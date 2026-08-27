#!/usr/bin/env node
// Best-effort usage collector for one finished agent launch. Wrapper-side
// only: the hosting workflow (a project Dispatcher or a human) runs it once
// per launch after the terminal result; roles never run it.
// Input: single CLI arg — JSON {runtime:"codex"|"claude", sessionId,
//   rootAgentRef?, label?, codexRoot?, codexArchivedRoot?,
//   claudeProjectsRoot?} (the three optional roots override the default log
//   locations; used by tests). `label` is the caller-owned display name of
//   the launch (stage, role, or task name) — this script embeds it verbatim.
// rootAgentRef targets one finished launch. Omitted (or null) it switches to
//   whole-session scope: everything the current chat spent — the session's
//   own log plus every launch it spawned — split per model as usual; label
//   then defaults to «Основная сессия» (required otherwise). A session
//   report already contains every launch, so never sum its rows with
//   per-launch rows in one table.
// Output: one JSON line on stdout; always exit 0.
//   ok:true  → {ok, label, wall_seconds, started_at, ended_at, agents,
//               steps, models, tokens: {input, cached_input, output, total},
//               cost_usd, unpriced_models, by_launch, by_model, source,
//               rendered: {block, table_header, rows, total_row},
//               comment_html}
//   ok:false → {ok, code, warning_line}: bad_args | logs_not_found |
//               root_not_found | ambiguous_root | workflow_run_incomplete |
//               timestamps_missing | log_limit_exceeded | collector_error
// steps counts API model requests across the launch: Codex — token_count
// events, Claude — distinct requestIds carrying usage. The optimization
// target is fewer steps per task.
// wall_seconds is WORKING time, not the calendar span: the union of exact
// turn intervals across all threads/files — Codex task_started→
// task_complete/turn_aborted event pairs (what the UI shows as "Worked
// for"; a turn left dangling by a crash closes at the last record before
// the resume's task_started, or the thread's last record at EOF), Claude
// a real user message to the last WORK record before the next one (an
// assistant record or a tool result — recognized by the toolUseResult
// side-field or a tool_result content block, since subagent files omit
// the side-field; queue-operation/system/attachment records are stamped
// at user-return time or out of order and never bound a turn). Pauses
// between turns — the user reading or away — never count; parallel
// subagents overlap their parent's turn and count once. A unit without
// any marker falls back to a 30-minute idle-gap heuristic over its raw
// record timestamps (pooled across such units). started_at/ended_at still
// bound the full calendar span, so ended-started may far exceed
// wall_seconds.
// by_launch splits the same figures per (launch, model) so subagents stay
//   visible: [{launch, model, wall_seconds, steps, tokens, cost_usd|null}].
//   The root unit carries the report label; each spawned unit rows under
//   its own name — Codex: the agent_path's last segment through
//   ROLE_LABELS (known roles get the dispatcher's Russian stage names,
//   the rest humanize: underscores → spaces, capitalized; nickname, then
//   thread id, when the path is absent), Claude: the parent's Task/Agent
//   tool_use input.description (then subagent_type; «Сабагент
//   <id-prefix>» when unlinked). Launches keep processing order (root
//   first), models sort inside a launch.
// by_model splits wall time/steps/tokens/cost per model: [{model,
//   wall_seconds, steps, tokens: {input, cached_input, output, total},
//   cost_usd|null}] sorted by model name; cost_usd is null for models
//   without a PRICING entry. Claude token/step attribution is exact per
//   request; Codex attributes the delta between consecutive cumulative
//   token_count events to the model active at that event (turn_context), so
//   a thread that switches models splits correctly; a negative delta means
//   the counter reset and the event becomes a fresh baseline. Per-model
//   wall_seconds is that model's own working time: its activity segments
//   (records while the model was active — Codex per thread; its own
//   assistant records — Claude per agent file; 30-minute idle gaps split
//   segments) clipped to the unit's turn intervals, summed across
//   threads/files; parallel agents can make the sum exceed the
//   launch-level wall_seconds.
// rendered.* and warning_line are ready-to-paste Russian strings — the
// caller copies them verbatim and never re-formats numbers: rendered.block
// is the standalone «Затрачено» table for one launch; rendered.rows is the
// same data rows (one Markdown table line per by_launch entry —
// launch × model — newline-joined, each carrying that model's own working
// time inside that launch) for assembling a multi-launch table over
// rendered.table_header; rendered.total_row is the «ИТОГО» line
// closing rendered.block (launch-level wall time, summed tokens/steps/cost —
// per-model wall sums may exceed its time; on unpriced models the $ cell
// carries the «без тарифа» note). In a multi-launch table the caller keeps
// per-launch total_rows out and cannot total across launches itself (digit
// formatting is script-only). comment_html is the same breakdown as
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
// parent_thread_id === sessionId and agent_path === rootAgentRef; for
// multi_agent_v1 spawns, whose agent_path is null, the thread id must equal
// rootAgentRef instead. Descendants are linked by parent_thread_id chains; a
// null-path descendant additionally requires its thread id to appear in the
// parent's log, otherwise workflow_run_incomplete. In whole-session scope the
// root is the rollout whose session_meta id equals sessionId (its spawn
// source is irrelevant; missing → logs_not_found) and descendants attach as
// usual. Token totals sum the per-event deltas of the cumulative token_count
// counters; models come from turn_context records.
// Claude Code: ~/.claude/projects/**/<sessionId>/subagents/agent-<id>.jsonl;
// the launched Task's file carries agentId === rootAgentRef; usage and models
// are summed over its assistant messages. In whole-session scope the root is
// <projects>/<slug>/<sessionId>.jsonl and every *.jsonl directly under its
// subagents dir joins even without a toolUseResult link.

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

// Subagent display names for Codex agent_path values: known role segments
// map to the dispatcher's Russian stage names (keep in sync with the
// dispatcher SKILL's label set); anything else humanizes its last path
// segment (underscores → spaces, capitalized).
const ROLE_LABELS = Object.freeze({
    development: "Разработка",
    review: "Ревью",
    prd: "PRD",
    product: "PRD",
    documentation: "Документация"
});

function labelForAgentPath(path) {
    const segment = path.split("/").filter(Boolean).pop();
    if (!isNonEmptyString(segment)) return path;
    const known = ROLE_LABELS[segment.toLowerCase()];
    if (known) return known;
    const words = segment.replaceAll("_", " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function rateFor(model) {
    if (!isNonEmptyString(model)) return undefined;
    if (PRICING[model]) return PRICING[model];
    const key = Object.keys(PRICING).find((k) => model.startsWith(`${k}-`));
    return key ? PRICING[key] : undefined;
}

// Usage accumulator keyed by (launch, model): the hosting session and each
// subagent launch stay separate rows instead of dissolving into per-model
// totals. Launches keep first-seen order (the root unit is processed
// first); models sort alphabetically inside a launch. Codex adds one entry
// per thread (usage: raw slices for pricing); Claude adds one entry per
// API request.
function usageLedger() {
    const perLaunch = new Map();
    const bucket = (launch, model) => {
        const modelKey = isNonEmptyString(model) && model !== "<synthetic>" ? model : "неизвестно";
        if (!perLaunch.has(launch)) perLaunch.set(launch, new Map());
        const models = perLaunch.get(launch);
        if (!models.has(modelKey)) {
            models.set(modelKey, { wall_ms: 0, steps: 0, input: 0, cached_input: 0, output: 0, total: 0, usd: 0 });
        }
        return models.get(modelKey);
    };
    return {
        // Milliseconds of this model's own active time (one thread or one
        // agent file at a time); summed across units into wall_seconds.
        addWall(launch, model, ms) {
            bucket(launch, model).wall_ms += ms;
        },
        // totals: {input, cached_input, output, total} — log-shaped counts.
        // priced: {input, cache_write, cached_input, output} — raw slices.
        add(launch, model, steps, totals, priced) {
            const entry = bucket(launch, model);
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
            const by_launch = [];
            for (const [launch, models] of perLaunch) {
                for (const [model, entry] of [...models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                    by_launch.push({
                        launch,
                        model,
                        wall_seconds: Math.round(entry.wall_ms / 1000),
                        steps: entry.steps,
                        tokens: { input: entry.input, cached_input: entry.cached_input, output: entry.output, total: entry.total },
                        cost_usd: entry.unpriced ? null : Math.round(entry.usd * 10_000) / 10_000,
                        unpriced: Boolean(entry.unpriced)
                    });
                }
            }
            // by_model keeps the aggregate per-model contract on top of the
            // per-launch split; sums run over raw (unrounded) USD.
            const aggregate = new Map();
            for (const [, models] of perLaunch) {
                for (const [model, entry] of models) {
                    if (!aggregate.has(model)) {
                        aggregate.set(model, {
                            model, wall_seconds: 0, steps: 0,
                            tokens: { input: 0, cached_input: 0, output: 0, total: 0 }, usd: 0, unpriced: false
                        });
                    }
                    const agg = aggregate.get(model);
                    agg.wall_seconds += Math.round(entry.wall_ms / 1000);
                    agg.steps += entry.steps;
                    agg.tokens.input += entry.input;
                    agg.tokens.cached_input += entry.cached_input;
                    agg.tokens.output += entry.output;
                    agg.tokens.total += entry.total;
                    if (entry.unpriced) agg.unpriced = true;
                    else agg.usd += entry.usd;
                }
            }
            const sorted = [...aggregate.values()].sort((a, b) => a.model.localeCompare(b.model));
            const tokens = { input: 0, cached_input: 0, output: 0, total: 0 };
            let steps = 0;
            let usd = 0;
            for (const entry of sorted) {
                tokens.input += entry.tokens.input;
                tokens.cached_input += entry.tokens.cached_input;
                tokens.output += entry.tokens.output;
                tokens.total += entry.tokens.total;
                steps += entry.steps;
                if (!entry.unpriced) usd += entry.usd;
            }
            return {
                by_launch: by_launch.map(({ unpriced, ...row }) => row),
                by_model: sorted.map((entry) => ({
                    model: entry.model,
                    wall_seconds: entry.wall_seconds,
                    steps: entry.steps,
                    tokens: entry.tokens,
                    cost_usd: entry.unpriced ? null : Math.round(entry.usd * 10_000) / 10_000,
                })),
                tokens,
                steps,
                cost_usd: Math.round(usd * 10_000) / 10_000,
                unpriced_models: sorted.filter((entry) => entry.unpriced).map((entry) => entry.model)
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

function renderUsage({ label, wall_seconds, by_launch, tokens, steps, cost_usd, unpriced_models }) {
    const entries = by_launch.length > 0
        ? by_launch
        : [{ launch: label, model: "неизвестно", wall_seconds, steps: 0, tokens: { input: 0, cached_input: 0, output: 0, total: 0 }, cost_usd: 0 }];
    const rows = entries
        .map((entry) =>
            [
                "",
                `${entry.launch}<br>*${entry.model}*`,
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
    // The ИТОГО line closes the single-launch block: launch-level wall time
    // (per-model wall sums may exceed it) plus the summed tokens/steps/cost.
    const total_row = [
        "",
        "**ИТОГО**",
        formatWall(wall_seconds),
        `${formatTokens(tokens.input)}<br>*кэш ${formatTokens(tokens.cached_input)}*`,
        formatThousands(tokens.output),
        formatTokens(tokens.total),
        formatThousands(steps),
        totalCost,
        ""
    ]
        .join(" | ")
        .trim();
    const items = entries
        .map((entry) =>
            `<li><b>${escapeHtml(entry.launch)} · ${escapeHtml(entry.model)}</b>: ${formatWall(entry.wall_seconds)} · ` +
            `вход ${formatTokens(entry.tokens.input)} (кэш ${formatTokens(entry.tokens.cached_input)}) · ` +
            `выход ${formatThousands(entry.tokens.output)} · всего ${formatTokens(entry.tokens.total)} · шаги ${formatThousands(entry.steps)}` +
            `${entry.cost_usd === null ? " · без тарифа" : ` · $${entry.cost_usd}`}</li>`
        )
        .join("");
    const comment_html =
        `<p>Метрики ${escapeHtml(label)}: ${formatWall(wall_seconds)} · шаги ${formatThousands(steps)} · $${totalCost}</p><ul>${items}</ul>`;

    return {
        rendered: {
            block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}\n${total_row}`,
            table_header: TABLE_HEADER,
            rows,
            total_row
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

// Fallback only (units without turn markers): pauses longer than this
// between consecutive records are idle and excluded from active wall time.
const IDLE_GAP_MS = 30 * 60 * 1000;

// [startMs, endMs] pairs → sorted, overlap-free union.
function mergeIntervals(intervals) {
    const sorted = intervals.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

function intervalsLength(intervals) {
    return intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
}

// Timestamps → activity segments, split where consecutive stamps sit more
// than IDLE_GAP_MS apart.
function gapSegments(stamps) {
    const sorted = [...stamps].sort((a, b) => a - b);
    const segments = [];
    for (const ms of sorted) {
        const last = segments[segments.length - 1];
        if (last && ms - last[1] <= IDLE_GAP_MS) last[1] = ms;
        else segments.push([ms, ms]);
    }
    return segments;
}

// A model's own activity never exceeds the time its unit was actually
// working: clip the model's segments to the unit's work intervals.
function clipToIntervals(segments, intervals) {
    const clipped = [];
    for (const [segStart, segEnd] of segments) {
        for (const [start, end] of intervals) {
            const from = Math.max(segStart, start);
            const to = Math.min(segEnd, end);
            if (to > from) clipped.push([from, to]);
        }
    }
    return clipped;
}

// Launch-level wall accumulator. Units with exact turn intervals contribute
// them directly; units without markers pour raw timestamps into one shared
// fallback pool segmented by idle gaps (pooled so a parent waiting on its
// child bridges across the two files). Overlaps — parallel agents inside a
// parent's turn — merge and count once. min/max over every record timestamp
// still bound the calendar span for started_at/ended_at.
function wallTracker() {
    let min;
    let max;
    const intervals = [];
    const fallbackStamps = [];
    return {
        stamp(value) {
            const ms = toMillis(value);
            if (ms === undefined) return;
            if (min === undefined || ms < min) min = ms;
            if (max === undefined || ms > max) max = ms;
        },
        addIntervals(list) {
            intervals.push(...list);
        },
        addFallbackStamps(stamps) {
            fallbackStamps.push(...stamps);
        },
        result() {
            const merged = mergeIntervals([...intervals, ...gapSegments(fallbackStamps)]);
            return { min, max, active_ms: intervalsLength(merged) };
        }
    };
}

function emit(label, span, agents, models, ledger, source) {
    const { min, max, active_ms } = span.result();
    if (min === undefined || max === undefined || max < min) failWith("timestamps_missing");
    const result = {
        ok: true,
        label,
        wall_seconds: Math.round(active_ms / 1000),
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
    const sessionScope = rootAgentRef == null;
    const state = { files: [], seen: new Set() };
    await listJsonlFiles(codexRoot ?? join(homedir(), ".codex", "sessions"), state);
    await listJsonlFiles(codexArchivedRoot ?? join(homedir(), ".codex", "archived_sessions"), state);
    if (state.files.length === 0) failWith("logs_not_found");

    const metadata = [];
    const sessionRoots = [];
    for (const path of state.files) {
        const [record] = await readRecords(path, { firstOnly: true });
        const payload = record?.type === "session_meta" ? record.payload : undefined;
        if (!isNonEmptyString(payload?.id)) continue;
        // Whole-session scope roots at the session's own rollout, whatever
        // spawned it; launch scope only ever matches spawned threads.
        if (sessionScope && payload.id === sessionId) {
            sessionRoots.push({ path, id: payload.id });
            continue;
        }
        const spawn = payload?.source?.subagent?.thread_spawn;
        if (!isNonEmptyString(spawn?.parent_thread_id)) continue;
        // multi_agent_v1 spawns leave no agent_path; the thread is then
        // identified by its id and evidenced by the parent's tool output.
        metadata.push({
            path,
            id: payload.id,
            parentId: spawn.parent_thread_id,
            agentPath: isNonEmptyString(spawn.agent_path) ? spawn.agent_path : null,
            nickname: isNonEmptyString(spawn.agent_nickname) ? spawn.agent_nickname : null
        });
    }

    const roots = sessionScope
        ? sessionRoots
        : metadata.filter((item) => item.parentId === sessionId
            && (item.agentPath === rootAgentRef || (item.agentPath === null && item.id === rootAgentRef)));
    if (roots.length === 0) failWith(sessionScope ? "logs_not_found" : "root_not_found");
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

    const span = wallTracker();
    const models = new Set();
    const ledger = usageLedger();
    for (const item of selected.values()) {
        // The root unit carries the launch label; each spawned thread rows
        // under its role name derived from agent_path (nickname, then id,
        // when the path is absent) so subagents stay visible in the report.
        const unitLabel = item.id === roots[0].id
            ? label
            : item.agentPath !== null ? labelForAgentPath(item.agentPath) : item.nickname ?? item.id;
        const records = await readRecords(item.path);
        // A null-path child has no structured launch record; the only
        // parent-side evidence is its thread id echoed in tool output.
        for (const child of metadata.filter((meta) => meta.parentId === item.id && meta.agentPath === null)) {
            if (!records.some((record) => JSON.stringify(record).includes(child.id))) failWith("workflow_run_incomplete");
        }
        let activeModel;
        let prev;
        // Exact working time per thread: task_started→task_complete (or
        // turn_aborted) event pairs — the same spans the UI shows as
        // "Worked for". A turn left dangling by a crash closes at the last
        // record seen before the resume's task_started (never at the new
        // start itself — the idle until the resume is not work), or at the
        // thread's last record when the file ends.
        const turnBounds = [];
        let openTurnStart;
        let prevMs;
        const unitStamps = [];
        let unitMax;
        // Per-model activity: every record's timestamp while that model was
        // the active turn_context model.
        const modelStamps = new Map();
        for (const record of records) {
            span.stamp(record.timestamp);
            const ms = toMillis(record.timestamp);
            const payload = record?.payload;
            if (record?.type === "event_msg" && ms !== undefined) {
                if (payload?.type === "task_started") {
                    if (openTurnStart !== undefined) turnBounds.push([openTurnStart, Math.max(openTurnStart, prevMs ?? openTurnStart)]);
                    openTurnStart = ms;
                } else if ((payload?.type === "task_complete" || payload?.type === "turn_aborted") && openTurnStart !== undefined) {
                    turnBounds.push([openTurnStart, ms]);
                    openTurnStart = undefined;
                }
            }
            if (ms !== undefined) {
                unitStamps.push(ms);
                prevMs = ms;
                if (unitMax === undefined || ms > unitMax) unitMax = ms;
            }
            if (record?.type === "turn_context" && isNonEmptyString(payload?.model)) {
                models.add(payload.model);
                activeModel = payload.model;
            }
            if (activeModel !== undefined && ms !== undefined) {
                if (!modelStamps.has(activeModel)) modelStamps.set(activeModel, []);
                modelStamps.get(activeModel).push(ms);
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
                    unitLabel,
                    activeModel,
                    1,
                    { input: delta.input, cached_input: delta.cached, output: delta.output, total: delta.total },
                    { input: Math.max(0, delta.input - delta.cached), cached_input: delta.cached, output: delta.output }
                );
            }
        }
        if (openTurnStart !== undefined && unitMax !== undefined) turnBounds.push([openTurnStart, unitMax]);
        // Exact turn intervals when the thread has markers; otherwise its
        // stamps join the shared idle-gap fallback pool.
        const unitIntervals = turnBounds.length > 0 ? mergeIntervals(turnBounds) : gapSegments(unitStamps);
        if (turnBounds.length > 0) span.addIntervals(unitIntervals);
        else span.addFallbackStamps(unitStamps);
        for (const [model, stamps] of modelStamps) {
            ledger.addWall(unitLabel, model, intervalsLength(clipToIntervals(gapSegments(stamps), unitIntervals)));
        }
    }
    emit(label, span, selected.size, models, ledger, "codex");
}

async function collectClaude({ sessionId, rootAgentRef, label, claudeProjectsRoot }) {
    // Subagent transcripts live at <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl;
    // nested subagents are linked through toolUseResult.agentId in the parent's records.
    const sessionScope = rootAgentRef == null;
    const state = { files: [], seen: new Set() };
    await listJsonlFiles(claudeProjectsRoot ?? join(homedir(), ".claude", "projects"), state);
    const agentFile = (id) =>
        state.files.filter((path) => path.endsWith(join(sessionId, "subagents", `agent-${id}.jsonl`)));

    const pending = [];
    if (sessionScope) {
        // Whole-session scope: the session transcript plus every subagent
        // file in its directory — linked or not, it was spent in this chat.
        const mains = state.files.filter((path) => basename(path) === `${sessionId}.jsonl`);
        if (mains.length === 0) failWith("logs_not_found");
        if (mains.length > 1) failWith("ambiguous_root");
        const subagentsDir = join(dirname(mains[0]), sessionId, "subagents");
        pending.push([sessionId, mains[0]]);
        for (const path of state.files) {
            if (dirname(path) === subagentsDir) pending.push([basename(path, ".jsonl").replace(/^agent-/, ""), path]);
        }
    } else {
        const rootMatches = agentFile(rootAgentRef);
        if (rootMatches.length === 0) {
            if (state.files.some((path) => basename(path) === `${sessionId}.jsonl`)) failWith("root_not_found");
            failWith("logs_not_found");
        }
        if (rootMatches.length > 1) failWith("ambiguous_root");
        pending.push([rootAgentRef, rootMatches[0]]);
    }

    const selected = new Map();
    const span = wallTracker();
    const models = new Set();
    const ledger = usageLedger();
    // Subagent launch names come from the parent's Task/Agent tool_use
    // blocks (input.description, then subagent_type), matched to the child
    // through the tool_result's tool_use_id → toolUseResult.agentId pair.
    // Parents always process before their children (the root is queued
    // first), so a child's label is known by the time its file is read.
    const rootAgentId = pending[0][0];
    const labelById = new Map();
    const toolUseNames = new Map();
    while (pending.length > 0) {
        const [agentId, path] = pending.shift();
        if (selected.has(agentId)) continue;
        selected.set(agentId, path);
        const unitLabel = agentId === rootAgentId
            ? label
            : labelById.get(agentId) ?? `Сабагент ${agentId.slice(0, 8)}`;
        const records = await readRecords(path);
        // Streaming writes several assistant records per API request; the last
        // record per requestId carries the final usage — keep only that one.
        const usageByRequest = new Map();
        // Exact working time per file: a turn runs from a real user message
        // to the last WORK record before the next one — an assistant record
        // or a tool result. Tool results are user-typed but never turn
        // starts, and subagent files carry them without the toolUseResult
        // side-field, so a tool_result content block marks them too.
        // Non-work records (queue-operation, system, attachment) are
        // stamped when the user returns or out of order, so they neither
        // start nor extend a turn — the think pause before the user's next
        // message never counts.
        const turnBounds = [];
        let openTurnStart;
        let turnWorkMax;
        const closeTurn = () => {
            if (openTurnStart === undefined) return;
            turnBounds.push([openTurnStart, Math.max(openTurnStart, turnWorkMax ?? openTurnStart)]);
            openTurnStart = undefined;
        };
        const unitStamps = [];
        // Per-model activity: the model's own assistant records carrying
        // usage (streaming duplicates extend a segment naturally).
        const modelStamps = new Map();
        for (const record of records) {
            span.stamp(record.timestamp);
            const ms = toMillis(record.timestamp);
            if (ms !== undefined) unitStamps.push(ms);
            const content = record?.message?.content;
            if (record?.type === "assistant" && Array.isArray(content)) {
                for (const block of content) {
                    if (block?.type === "tool_use" && isNonEmptyString(block.id)) {
                        const name = block.input?.description ?? block.input?.subagent_type;
                        if (isNonEmptyString(name)) toolUseNames.set(block.id, name);
                    }
                }
            }
            const childId = record?.toolUseResult?.agentId;
            if (isNonEmptyString(childId) && !selected.has(childId)) {
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block?.type === "tool_result" && toolUseNames.has(block.tool_use_id)) {
                            labelById.set(childId, toolUseNames.get(block.tool_use_id));
                        }
                    }
                }
                const childMatches = agentFile(childId);
                if (childMatches.length === 1) pending.push([childId, childMatches[0]]);
            }
            const isToolResult = Boolean(record.toolUseResult) ||
                (Array.isArray(content) && content.some((block) => block?.type === "tool_result"));
            if (record?.type === "user" && record?.message?.role === "user" && ms !== undefined && !isToolResult) {
                closeTurn();
                openTurnStart = ms;
                turnWorkMax = undefined;
            }
            const isWork = record?.type === "assistant" || (record?.type === "user" && isToolResult);
            if (isWork && ms !== undefined && (turnWorkMax === undefined || ms > turnWorkMax)) turnWorkMax = ms;
            if (record?.type !== "assistant") continue;
            const usage = record?.message?.usage;
            const model = record?.message?.model;
            if (usage) usageByRequest.set(record.requestId ?? record.uuid, { usage, model });
            if (isNonEmptyString(model) && model !== "<synthetic>") {
                models.add(model);
                if (usage && ms !== undefined) {
                    if (!modelStamps.has(model)) modelStamps.set(model, []);
                    modelStamps.get(model).push(ms);
                }
            }
        }
        closeTurn();
        // Exact turn intervals when the file has user-message markers;
        // otherwise its stamps join the shared idle-gap fallback pool.
        const unitIntervals = turnBounds.length > 0 ? mergeIntervals(turnBounds) : gapSegments(unitStamps);
        if (turnBounds.length > 0) span.addIntervals(unitIntervals);
        else span.addFallbackStamps(unitStamps);
        for (const [model, stamps] of modelStamps) {
            ledger.addWall(unitLabel, model, intervalsLength(clipToIntervals(gapSegments(stamps), unitIntervals)));
        }
        for (const { usage, model } of usageByRequest.values()) {
            const input = usage.input_tokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const output = usage.output_tokens ?? 0;
            // Same shape as Codex: input is the full model input, cache reads included.
            ledger.add(
                unitLabel,
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
    // rootAgentRef omitted/null → whole-session scope, where label may also
    // be omitted; an explicitly passed empty value stays a caller bug.
    const sessionScope = rootAgentRef == null;
    if (
        !["codex", "claude"].includes(runtime) ||
        !isNonEmptyString(sessionId) ||
        (!sessionScope && !isNonEmptyString(rootAgentRef)) ||
        !(isNonEmptyString(label) || (sessionScope && label == null))
    ) {
        failWith("bad_args");
    }
    args.label = isNonEmptyString(label) ? label : "Основная сессия";
    launchLabel = args.label.trim();
    if (runtime === "codex") {
        await collectCodex(args);
    } else {
        await collectClaude(args);
    }
}

main().catch((error) => failWith(error?.message === "log_limit_exceeded" ? "log_limit_exceeded" : "collector_error"));
