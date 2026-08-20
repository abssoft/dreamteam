#!/usr/bin/env node
// Best-effort usage collector for one finished agent launch. Wrapper-side
// only: the hosting workflow (a project Dispatcher or a human) runs it once
// per launch after the terminal result; roles never run it.
// Input: single CLI arg — JSON {runtime:"codex"|"claude", sessionId,
//   rootAgentRef, label, codexRoot?, codexArchivedRoot?,
//   claudeProjectsRoot?} (the three optional roots override the default log
//   locations; used by tests). `label` is the caller-owned display name of
//   the launch (stage, role, or task name) — this script embeds it verbatim.
// Output: one JSON line on stdout; always exit 0.
//   ok:true  → {ok, label, wall_seconds, started_at, ended_at, agents,
//               steps, models, tokens: {input, cached_input, output, total},
//               cost_usd, unpriced_models, by_model, source,
//               rendered: {block, table_header, rows}, comment_html}
//   ok:false → {ok, code, warning_line}: bad_args | logs_not_found |
//               root_not_found | ambiguous_root | timestamps_missing |
//               log_limit_exceeded | collector_error
// steps counts API model requests across the launch: Codex — token_count
// events, Claude — distinct requestIds carrying usage. The optimization
// target is fewer steps per task.
// by_model splits wall time/steps/tokens/cost per model: [{model,
//   wall_seconds, steps, tokens: {input, cached_input, output, total},
//   cost_usd|null}] sorted by model name; cost_usd is null for models
//   without a PRICING entry. Claude token/step attribution is exact per
//   request; Codex attributes the delta between consecutive cumulative
//   token_count events to the model active at that event (turn_context), so
//   a thread that switches models splits correctly; a negative delta means
//   the counter reset and the event becomes a fresh baseline. Per-model
//   wall_seconds is that model's own working time: the span of records
//   while the model was active (Codex, per thread) or of its own assistant
//   records (Claude, per agent file), summed across threads/files; parallel
//   agents can make the sum exceed the launch-level wall_seconds (the full
//   launch span).
// rendered.* and warning_line are ready-to-paste Russian strings — the
// caller copies them verbatim and never re-formats numbers: rendered.block
// is the standalone «Затрачено» table for one launch; rendered.rows is the
// same data rows (one Markdown table line per model, newline-joined, each
// carrying that model's own working time) for assembling a multi-launch
// table over rendered.table_header. comment_html is the same breakdown as
// one HTML fragment for trackers that take HTML comments.
// Token cells: >=1 000 000 → millions with two decimals and «М» (3238493 →
// 3.24М), below → space-separated thousands (323885 → 323 885); the Выход
// cell always uses the space form.
// tokens.input is the full model input; tokens.cached_input is its cache-read
// subset (both runtimes), so total = input + output.
// cost_usd sums only usage whose model has a PRICING entry; models without
// one are listed in unpriced_models (their tokens still count in `tokens`).
// Codex: rollout files under ~/.codex/{sessions,archived_sessions}; the root
// thread is the one whose session_meta thread_spawn has
// parent_thread_id === sessionId and agent_path === rootAgentRef; descendants
// are linked by parent_thread_id chains. Token totals sum the per-event
// deltas of the cumulative token_count counters; models come from
// turn_context records.
// Claude Code: ~/.claude/projects/**/<sessionId>/subagents/agent-<id>.jsonl;
// the launched Task's file carries agentId === rootAgentRef; usage and models
// are summed over its assistant messages.

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

const LIMITS = Object.freeze({
    maxLineBytes: 4 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    maxCandidateFiles: 10_000
});

// Official USD prices per 1M tokens, checked 2026-08-15.
// Claude: https://platform.claude.com/docs/en/about-claude/pricing
//   (Sonnet 5: the $2/$10 launch pricing is now standard — the September 1,
//   2026 increase to $3/$15 was canceled.)
//   cache_write_5m = 5-minute cache write (1.25x input); cache reads bill at
//   0.1x input (cached_input). 1h cache writes (2x input) are not
//   distinguishable in the logs and are priced as 5m writes here.
// OpenAI: https://developers.openai.com/api/docs/pricing
//   (standard tier; long-context rates for requests over 272K input tokens
//   are higher but not recoverable from cumulative session totals.)
const PRICING = Object.freeze({
    "claude-fable-5": { input: 10, cached_input: 1, cache_write_5m: 12.5, output: 50 },
    "claude-opus-5": { input: 5, cached_input: 0.5, cache_write_5m: 6.25, output: 25 },
    "claude-sonnet-5": { input: 2, cached_input: 0.2, cache_write_5m: 2.5, output: 10 },
    "gpt-5.6-sol": { input: 5, cached_input: 0.5, output: 30 },
    "gpt-5.6-terra": { input: 2, cached_input: 0.2, output: 12 },
    "gpt-5.6-luna": { input: 0.2, cached_input: 0.02, output: 1.2 }
});

function rateFor(model) {
    if (!isNonEmptyString(model)) return undefined;
    if (PRICING[model]) return PRICING[model];
    const key = Object.keys(PRICING).find((k) => model.startsWith(`${k}-`));
    return key ? PRICING[key] : undefined;
}

// Per-model accumulator: steps, tokens, and cost per model plus the launch
// totals. Codex adds one entry per thread (usage: raw slices for pricing);
// Claude adds one entry per API request.
function usageLedger() {
    const perModel = new Map();
    const bucket = (model) => {
        const key = isNonEmptyString(model) && model !== "<synthetic>" ? model : "неизвестно";
        if (!perModel.has(key)) {
            perModel.set(key, { wall_ms: 0, steps: 0, input: 0, cached_input: 0, output: 0, total: 0, usd: 0 });
        }
        return perModel.get(key);
    };
    return {
        // Milliseconds of this model's own working span (one thread or one
        // agent file at a time); summed across units into wall_seconds.
        addWall(model, ms) {
            bucket(model).wall_ms += ms;
        },
        // totals: {input, cached_input, output, total} — log-shaped counts.
        // priced: {input, cache_write, cached_input, output} — raw slices.
        add(model, steps, totals, priced) {
            const entry = bucket(model);
            const rate = rateFor(model);
            entry.steps += steps;
            entry.input += totals.input;
            entry.cached_input += totals.cached_input;
            entry.output += totals.output;
            entry.total += totals.total;
            if (rate) {
                entry.usd +=
                    ((priced.input ?? 0) * rate.input +
                        (priced.cache_write ?? 0) * (rate.cache_write_5m ?? rate.input) +
                        (priced.cached_input ?? 0) * rate.cached_input +
                        (priced.output ?? 0) * rate.output) /
                    1_000_000;
            } else {
                entry.unpriced = true;
            }
        },
        result() {
            const sorted = [...perModel.entries()].sort(([a], [b]) => a.localeCompare(b));
            const tokens = { input: 0, cached_input: 0, output: 0, total: 0 };
            let steps = 0;
            let usd = 0;
            for (const [, entry] of sorted) {
                tokens.input += entry.input;
                tokens.cached_input += entry.cached_input;
                tokens.output += entry.output;
                tokens.total += entry.total;
                steps += entry.steps;
                if (!entry.unpriced) usd += entry.usd;
            }
            return {
                by_model: sorted.map(([model, entry]) => ({
                    model,
                    wall_seconds: Math.round(entry.wall_ms / 1000),
                    steps: entry.steps,
                    tokens: { input: entry.input, cached_input: entry.cached_input, output: entry.output, total: entry.total },
                    cost_usd: entry.unpriced ? null : Math.round(entry.usd * 10_000) / 10_000
                })),
                tokens,
                steps,
                cost_usd: Math.round(usd * 10_000) / 10_000,
                unpriced_models: sorted.filter(([, entry]) => entry.unpriced).map(([model]) => model)
            };
        }
    };
}

function out(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(0);
}

// «Затрачено» rendering lives here, not in caller prose: digit formatting is
// deterministic script work — the caller pastes rendered.block (or
// rendered.rows for a multi-launch table) and warning_line verbatim.
const TABLE_HEADER = "| Роль | Время | Вход | Выход | Всего | Шаги | $ |\n|---|---:|---:|---:|---:|---:|---:|";

let launchLabel = "";

function formatThousands(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// >= 1 000 000 -> millions with exactly two decimals and the «М» suffix;
// below that -> space-separated thousands. Output tokens never use М.
function formatTokens(value) {
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}М` : formatThousands(value);
}

function formatWall(wallSeconds) {
    return `${Math.floor(wallSeconds / 60)}м ${wallSeconds % 60}с`;
}

function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderUsage({ label, wall_seconds, by_model, steps, cost_usd, unpriced_models }) {
    const entries = by_model.length > 0
        ? by_model
        : [{ model: "неизвестно", wall_seconds, steps: 0, tokens: { input: 0, cached_input: 0, output: 0, total: 0 }, cost_usd: 0 }];
    const rows = entries
        .map((entry) =>
            [
                "",
                `${label}<br>*${entry.model}*`,
                formatWall(entry.wall_seconds),
                `${formatTokens(entry.tokens.input)}<br>*кэш ${formatTokens(entry.tokens.cached_input)}*`,
                formatThousands(entry.tokens.output),
                formatTokens(entry.tokens.total),
                formatThousands(entry.steps),
                entry.cost_usd === null ? "без тарифа" : String(entry.cost_usd),
                ""
            ]
                .join(" | ")
                .trim()
        )
        .join("\n");

    const totalCost = unpriced_models.length > 0
        ? `${cost_usd} (без тарифа: ${unpriced_models.join(", ")})`
        : String(cost_usd);
    const items = entries
        .map((entry) =>
            `<li><b>${escapeHtml(entry.model)}</b>: ${formatWall(entry.wall_seconds)} · ` +
            `вход ${formatTokens(entry.tokens.input)} (кэш ${formatTokens(entry.tokens.cached_input)}) · ` +
            `выход ${formatThousands(entry.tokens.output)} · всего ${formatTokens(entry.tokens.total)} · шаги ${formatThousands(entry.steps)}` +
            `${entry.cost_usd === null ? " · без тарифа" : ` · $${entry.cost_usd}`}</li>`
        )
        .join("");
    const comment_html =
        `<p>Метрики ${escapeHtml(label)}: ${formatWall(wall_seconds)} · шаги ${formatThousands(steps)} · $${totalCost}</p><ul>${items}</ul>`;

    return {
        rendered: {
            block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}`,
            table_header: TABLE_HEADER,
            rows
        },
        comment_html
    };
}

function failWith(code) {
    out({
        ok: false,
        code,
        warning_line: launchLabel
            ? `Предупреждение: метрики ${launchLabel} не собраны — ${code}.`
            : `Предупреждение: метрики не собраны — ${code}.`
    });
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

async function pathKind(path) {
    try {
        const st = await lstat(path);
        if (st.isSymbolicLink()) return "other";
        return st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
    } catch {
        return "missing";
    }
}

async function listJsonlFiles(root, state) {
    if ((await pathKind(root)) !== "directory") return;
    const queue = [root];
    while (queue.length > 0) {
        const dir = queue.shift();
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push(path);
            } else if (entry.isFile() && path.endsWith(".jsonl") && !state.seen.has(path)) {
                state.seen.add(path);
                state.files.push(path);
                if (state.files.length > LIMITS.maxCandidateFiles) throw new Error("log_limit_exceeded");
            }
        }
    }
}

async function readRecords(path, { firstOnly = false } = {}) {
    const records = [];
    const stream = createReadStream(path, { end: LIMITS.maxFileBytes });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (line.length > LIMITS.maxLineBytes) continue;
            const trimmed = line.trim();
            if (trimmed === "") continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch {
                continue;
            }
            if (firstOnly) break;
        }
    } finally {
        lines.close();
        stream.destroy();
    }
    return records;
}

function toMillis(value) {
    const ms = typeof value === "number" ? value : Date.parse(value ?? "");
    return Number.isFinite(ms) ? ms : undefined;
}

function spanCollector() {
    let min;
    let max;
    return {
        add(value) {
            const ms = toMillis(value);
            if (ms === undefined) return;
            if (min === undefined || ms < min) min = ms;
            if (max === undefined || ms > max) max = ms;
        },
        result() {
            return { min, max };
        }
    };
}

function emit(label, span, agents, models, ledger, source) {
    const { min, max } = span.result();
    if (min === undefined || max === undefined || max < min) failWith("timestamps_missing");
    const result = {
        ok: true,
        label,
        wall_seconds: Math.round((max - min) / 1000),
        started_at: new Date(min).toISOString(),
        ended_at: new Date(max).toISOString(),
        agents,
        models: [...models].sort(),
        ...ledger.result(),
        source
    };
    out({ ...result, ...renderUsage(result) });
}

async function collectCodex({ sessionId, rootAgentRef, label, codexRoot, codexArchivedRoot }) {
    const state = { files: [], seen: new Set() };
    await listJsonlFiles(codexRoot ?? join(homedir(), ".codex", "sessions"), state);
    await listJsonlFiles(codexArchivedRoot ?? join(homedir(), ".codex", "archived_sessions"), state);
    if (state.files.length === 0) failWith("logs_not_found");

    const metadata = [];
    for (const path of state.files) {
        const [record] = await readRecords(path, { firstOnly: true });
        const payload = record?.type === "session_meta" ? record.payload : undefined;
        const spawn = payload?.source?.subagent?.thread_spawn;
        if (!isNonEmptyString(payload?.id) || !isNonEmptyString(spawn?.parent_thread_id) || !isNonEmptyString(spawn?.agent_path)) {
            continue;
        }
        metadata.push({ path, id: payload.id, parentId: spawn.parent_thread_id, agentPath: spawn.agent_path });
    }

    const roots = metadata.filter((item) => item.parentId === sessionId && item.agentPath === rootAgentRef);
    if (roots.length === 0) failWith("root_not_found");
    if (roots.length > 1) failWith("ambiguous_root");

    const selected = new Map([[roots[0].id, roots[0]]]);
    const pending = [roots[0].id];
    while (pending.length > 0) {
        const parentId = pending.shift();
        for (const child of metadata.filter((item) => item.parentId === parentId)) {
            if (selected.has(child.id)) failWith("ambiguous_root");
            selected.set(child.id, child);
            pending.push(child.id);
        }
    }

    const span = spanCollector();
    const models = new Set();
    const ledger = usageLedger();
    for (const item of selected.values()) {
        const records = await readRecords(item.path);
        let activeModel;
        let prev;
        // Per-model working time within this thread: the span of all records
        // while that model was the active turn_context model.
        const modelSpans = new Map();
        for (const record of records) {
            span.add(record.timestamp);
            const payload = record?.payload;
            if (record?.type === "turn_context" && isNonEmptyString(payload?.model)) {
                models.add(payload.model);
                activeModel = payload.model;
            }
            if (activeModel !== undefined) {
                if (!modelSpans.has(activeModel)) modelSpans.set(activeModel, spanCollector());
                modelSpans.get(activeModel).add(record.timestamp);
            }
            if (record?.type === "event_msg" && payload?.type === "token_count" && payload.info?.total_token_usage) {
                const cur = payload.info.total_token_usage;
                const now = {
                    input: cur.input_tokens ?? 0,
                    cached: cur.cached_input_tokens ?? 0,
                    output: cur.output_tokens ?? 0
                };
                now.total = cur.total_tokens ?? now.input + now.output;
                // token_count is cumulative per thread: the delta since the
                // previous event is this request's usage and belongs to the
                // model active right now. A negative delta means the counter
                // reset — take the event as a fresh baseline.
                let delta = prev
                    ? { input: now.input - prev.input, cached: now.cached - prev.cached, output: now.output - prev.output, total: now.total - prev.total }
                    : now;
                if (delta.input < 0 || delta.cached < 0 || delta.output < 0 || delta.total < 0) delta = now;
                prev = now;
                // Codex input_tokens include the cached subset; price the two slices apart.
                ledger.add(
                    activeModel,
                    1,
                    { input: delta.input, cached_input: delta.cached, output: delta.output, total: delta.total },
                    { input: Math.max(0, delta.input - delta.cached), cached_input: delta.cached, output: delta.output }
                );
            }
        }
        for (const [model, modelSpan] of modelSpans) {
            const { min, max } = modelSpan.result();
            if (min !== undefined && max !== undefined && max >= min) ledger.addWall(model, max - min);
        }
    }
    emit(label, span, selected.size, models, ledger, "codex");
}

async function collectClaude({ sessionId, rootAgentRef, label, claudeProjectsRoot }) {
    // Subagent transcripts live at <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl;
    // nested subagents are linked through toolUseResult.agentId in the parent's records.
    const state = { files: [], seen: new Set() };
    await listJsonlFiles(claudeProjectsRoot ?? join(homedir(), ".claude", "projects"), state);
    const agentFile = (id) =>
        state.files.filter((path) => path.endsWith(join(sessionId, "subagents", `agent-${id}.jsonl`)));

    const rootMatches = agentFile(rootAgentRef);
    if (rootMatches.length === 0) {
        if (state.files.some((path) => basename(path) === `${sessionId}.jsonl`)) failWith("root_not_found");
        failWith("logs_not_found");
    }
    if (rootMatches.length > 1) failWith("ambiguous_root");

    const selected = new Map();
    const pending = [[rootAgentRef, rootMatches[0]]];
    const span = spanCollector();
    const models = new Set();
    const ledger = usageLedger();
    while (pending.length > 0) {
        const [agentId, path] = pending.shift();
        if (selected.has(agentId)) continue;
        selected.set(agentId, path);
        const records = await readRecords(path);
        // Streaming writes several assistant records per API request; the last
        // record per requestId carries the final usage — keep only that one.
        const usageByRequest = new Map();
        // Per-model working time within this file: the span of the model's own
        // assistant records (streaming duplicates extend it naturally).
        const modelSpans = new Map();
        for (const record of records) {
            span.add(record.timestamp);
            const childId = record?.toolUseResult?.agentId;
            if (isNonEmptyString(childId) && !selected.has(childId)) {
                const childMatches = agentFile(childId);
                if (childMatches.length === 1) pending.push([childId, childMatches[0]]);
            }
            if (record?.type !== "assistant") continue;
            const usage = record?.message?.usage;
            const model = record?.message?.model;
            if (usage) usageByRequest.set(record.requestId ?? record.uuid, { usage, model });
            if (isNonEmptyString(model) && model !== "<synthetic>") {
                models.add(model);
                if (usage) {
                    if (!modelSpans.has(model)) modelSpans.set(model, spanCollector());
                    modelSpans.get(model).add(record.timestamp);
                }
            }
        }
        for (const [model, modelSpan] of modelSpans) {
            const { min, max } = modelSpan.result();
            if (min !== undefined && max !== undefined && max >= min) ledger.addWall(model, max - min);
        }
        for (const { usage, model } of usageByRequest.values()) {
            const input = usage.input_tokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const output = usage.output_tokens ?? 0;
            // Same shape as Codex: input is the full model input, cache reads included.
            ledger.add(
                model,
                1,
                { input: input + cacheCreate + cacheRead, cached_input: cacheRead, output, total: input + cacheCreate + cacheRead + output },
                { input, cache_write: cacheCreate, cached_input: cacheRead, output }
            );
        }
    }
    emit(label, span, selected.size, models, ledger, "claude");
}

async function main() {
    let args;
    try {
        args = JSON.parse(process.argv[2] ?? "");
    } catch {
        failWith("bad_args");
    }
    const { runtime, sessionId, rootAgentRef, label } = args ?? {};
    if (!["codex", "claude"].includes(runtime) || !isNonEmptyString(sessionId) || !isNonEmptyString(rootAgentRef) || !isNonEmptyString(label)) {
        failWith("bad_args");
    }
    launchLabel = label.trim();
    if (runtime === "codex") {
        await collectCodex(args);
    } else {
        await collectClaude(args);
    }
}

main().catch((error) => failWith(error?.message === "log_limit_exceeded" ? "log_limit_exceeded" : "collector_error"));
