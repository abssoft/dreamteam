#!/usr/bin/env node
// Best-effort usage collector for one finished agent launch. Wrapper-side
// only: the hosting workflow (a project Dispatcher or a human) runs it once
// per launch after the terminal result; roles never run it.
// Input: single CLI arg — JSON {runtime:"codex"|"claude", sessionId,
//   rootAgentRef?, label?, analyze?, full?, codexRoot?, codexArchivedRoot?,
//   claudeProjectsRoot?} (the three optional roots override the default log
//   locations; used by tests). `label` is the caller-owned display name of
//   the launch (stage, role, or task name) — this script embeds it verbatim.
// analyze:true adds the inferred context-attribution pass (see `analysis`
//   below); it is off by default and never changes exact usage or pricing.
// rootAgentRef targets one finished launch. Omitted (or null) it switches to
//   whole-session scope: everything the current chat spent — the session's
//   own log plus every launch it spawned — split per model as usual; label
//   then defaults to «Основная сессия» (required otherwise). A session
//   report already contains every launch, so never sum its rows with
//   per-launch rows in one table.
// Output: one JSON line on stdout; always exit 0.
//   ok:true  → {ok, label, rendered: {block, table_header, rows, total_row?,
//               analysis_block?}, comment_html} — callers only ever paste
//               the rendered strings, so nothing else is printed by default.
//               full:true (tests/debugging only) adds the machine fields:
//               {wall_seconds, started_at, ended_at, agents, steps, models,
//               tokens: {input, uncached_input, cache_read_input,
//               cache_write_input, cached_input, output, total},
//               token_cost_usd, cost_usd, cost_breakdown_usd, pricing,
//               unpriced_models, by_launch, by_model, source, analysis?}
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
// by_launch splits the same figures per (launch, model, service tier) so
//   subagents and actual billing buckets stay visible: [{launch, model,
//   service_tier, wall_seconds, steps, tokens, token_cost_usd|null,
//   cost_usd|null, cost_breakdown_usd|null}].
//   The root unit carries the report label; each spawned unit rows under
//   its own name — Codex: the agent_path's last segment through
//   ROLE_LABELS (known roles get the dispatcher's Russian stage names,
//   the rest humanize: underscores → spaces, capitalized; nickname, then
//   thread id, when the path is absent), Claude: the parent's Task/Agent
//   tool_use input.description (then subagent_type; «Сабагент
//   <id-prefix>» when unlinked). Launches keep processing order (root
//   first), models sort inside a launch.
// by_model splits wall time/steps/tokens/cost per model and lists the tiers
//   it used. Cost fields are null if any request in the row is unpriceable.
//   Claude token/step attribution is exact per request. Codex validates
//   last_token_usage against the cumulative delta, deduplicates repeated
//   counters, and starts a new segment after a counter reset. Per-model
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
// launch × model × service tier — newline-joined, each carrying that bucket's
// own working time inside that launch) for assembling a multi-launch table over
// rendered.table_header; rendered.total_row is the «ИТОГО» line
// closing rendered.block (launch-level wall time, summed tokens/steps/cost —
// per-model wall sums may exceed its time; when any request is unpriceable
// the $ cell says «тариф не определён»). A one-row table carries no ИТОГО —
// total_row is omitted and the block ends at its single data row, since the
// total would only repeat it. In a multi-launch table the caller keeps
// per-launch total_rows out and cannot total across launches itself (digit
// formatting is script-only). comment_html is the same breakdown as
// one HTML fragment for trackers that take HTML comments.
// analysis (analyze:true only) answers «почему столько», never «сколько»:
//   the token totals above stay the exact figures from the logs, and this
//   pass splits them by cause. Per unit, every model request contributes a
//   context size (Claude: input+cache_creation+cache_read; Codex:
//   last_token_usage.input_tokens) and the tool results that arrived between
//   two requests share the measured growth of that step, minus the previous
//   step's own output. A step holding one tool result is exact; several
//   split it by JSON size, and coverage.share reports how much of the total
//   growth was placed at all. Each chunk is then charged `resent` = injected
//   × the number of later requests still carrying it: a context shrinking
//   below RESET_RATIO of the previous step is a compaction, and chunks
//   before it stop being charged past that point (`resets` counts them).
//   base is the unit's opening context — system prompt, tool schemas, skill
//   text — which belongs to no tool and is re-sent by every later step;
//   on multi-agent launches it sums per unit, since each subagent starts a
//   context of its own. by_tool/by_detail rank causes (MCP server, skill,
//   file, command word, host); repeats lists only content-bearing sources
//   (Read, WebFetch, MCP) hit more than once, where a second call re-injects
//   the same bytes. Everything is then priced with rates blended across the
//   models the launch actually used (re-sends bill as cache reads, a chunk's
//   first appearance as a cache write), giving estimated per_step cost, the
//   cold-start cost of a multi-unit launch, and estimated cache rebuilds — writes beyond the
//   context actually gained, i.e. content cached twice. verdict ranks it into
//   `largest` (where the money went; overhead is not automatically waste) and
//   `waste` (redundant re-reads, failed calls, cache rebuilt for nothing),
//   each item carrying the inferred figure it rests on and one concrete action.
//   rendered.analysis_block is the ready-to-paste Russian block: the tables
//   followed by that verdict in prose, printed AFTER rendered.block and never
//   merged into it.
// Token cells: >=1 000 000 → millions with two decimals and «М» (3238493 →
// 3.24М), below → space-separated thousands (323885 → 323 885); the Выход
// cell always uses the space form.
// Token invariants: input = uncached_input + cache_read_input +
// cache_write_input; total = input + output; deprecated cached_input is an
// alias of cache_read_input. Exact request prices use the versioned catalog
// below. If any request cannot be priced, report-level token_cost_usd and its
// cost_usd compatibility alias are null; no partial subtotal is emitted.
// Codex: rollout files under ~/.codex/{sessions,archived_sessions}; the root
// thread is the one whose session_meta thread_spawn has
// parent_thread_id === sessionId and agent_path === rootAgentRef; for
// multi_agent_v1 spawns, whose agent_path is null, the thread id must equal
// rootAgentRef instead. Descendants are linked by parent_thread_id chains; a
// null-path descendant additionally requires its thread id to appear in the
// parent's log, otherwise workflow_run_incomplete. In whole-session scope the
// root is the rollout whose session_meta id equals sessionId (its spawn
// source is irrelevant; missing → logs_not_found) and descendants attach as
// usual. Each non-duplicate token_count is a request: last_token_usage is
// accepted only when it matches the cumulative delta; counters and model
// reroutes remain the fallback authority. Models originate in turn_context.
// Claude Code: ~/.claude/projects/**/<sessionId>/subagents/agent-<id>.jsonl;
// the launched Task's file carries agentId === rootAgentRef; usage and models
// are summed over its assistant messages. Cache reads/writes share the Codex
// token contract; an ambiguous cache-write duration makes only price unknown.
// In whole-session scope the root is
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

// Versioned official model-token tariffs. Rates are integer nano-USD per
// token so request pricing and aggregation never round intermediate values.
// Tool-call fees and ChatGPT/Codex subscription billing are deliberately out
// of scope; the rendered column is therefore named "$ токены".
const PRICING_CATALOG = Object.freeze({
    version: "2026-08-29",
    checked_at: "2026-08-29",
    basis: "official_api_model_token_rates",
    sources: Object.freeze([
        "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
        "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
        "https://developers.openai.com/api/docs/guides/fast-mode",
        "https://platform.claude.com/docs/en/about-claude/pricing"
    ]),
    models: Object.freeze([
        {
            key: "gpt-5.6-sol", provider: "openai", ids: Object.freeze(["gpt-5.6-sol", "gpt-5.6"]),
            snapshot: /^gpt-5\.6-sol-\d{4}-\d{2}-\d{2}$/,
            standard: Object.freeze({ uncached_input: 4_000, cache_read_input: 400, cache_write_input: 5_000, output: 20_000 }),
            fast_multiplier: 2,
            long_context: Object.freeze({ threshold: 272_000, input_multiplier: 2, output_multiplier: 1.5 })
        },
        {
            key: "gpt-5.6-terra", provider: "openai", ids: Object.freeze(["gpt-5.6-terra"]),
            snapshot: /^gpt-5\.6-terra-\d{4}-\d{2}-\d{2}$/,
            standard: Object.freeze({ uncached_input: 2_000, cache_read_input: 200, cache_write_input: 2_500, output: 12_000 }),
            long_context: Object.freeze({ threshold: 272_000, input_multiplier: 2, output_multiplier: 1.5 })
        },
        {
            key: "gpt-5.6-luna", provider: "openai", ids: Object.freeze(["gpt-5.6-luna"]),
            snapshot: /^gpt-5\.6-luna-\d{4}-\d{2}-\d{2}$/,
            standard: Object.freeze({ uncached_input: 200, cache_read_input: 20, cache_write_input: 250, output: 1_200 }),
            long_context: Object.freeze({ threshold: 272_000, input_multiplier: 2, output_multiplier: 1.5 })
        },
        {
            key: "claude-fable-5", provider: "claude", ids: Object.freeze(["claude-fable-5"]),
            snapshot: /^claude-fable-5-\d{8}$/,
            standard: Object.freeze({ uncached_input: 10_000, cache_read_input: 1_000, cache_write_5m: 12_500, cache_write_1h: 20_000, output: 50_000 })
        },
        {
            key: "claude-opus-5", provider: "claude", ids: Object.freeze(["claude-opus-5"]),
            snapshot: /^claude-opus-5-\d{8}$/,
            standard: Object.freeze({ uncached_input: 5_000, cache_read_input: 500, cache_write_5m: 6_250, cache_write_1h: 10_000, output: 25_000 })
        },
        {
            key: "claude-sonnet-5", provider: "claude", ids: Object.freeze(["claude-sonnet-5"]),
            snapshot: /^claude-sonnet-5-\d{8}$/,
            standard: Object.freeze({ uncached_input: 2_000, cache_read_input: 200, cache_write_5m: 2_500, cache_write_1h: 4_000, output: 10_000 })
        }
    ])
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

function catalogEntryFor(model) {
    if (!isNonEmptyString(model)) return undefined;
    return PRICING_CATALOG.models.find((entry) => entry.ids.includes(model) || entry.snapshot.test(model));
}

// Analysis uses approximate blended standard rates only. Exact request cost
// never calls this helper and lives entirely in priceRequest().
function rateFor(model) {
    const entry = catalogEntryFor(model);
    if (!entry) return undefined;
    const rates = entry.standard;
    return {
        input: rates.uncached_input / 1_000,
        cached_input: rates.cache_read_input / 1_000,
        cache_write_5m: (rates.cache_write_5m ?? rates.cache_write_input) / 1_000,
        output: rates.output / 1_000
    };
}

function emptyTokens() {
    return {
        input: 0,
        uncached_input: 0,
        cache_read_input: 0,
        cache_write_input: 0,
        cached_input: 0,
        output: 0,
        total: 0
    };
}

function addTokens(target, source) {
    for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
}

function normalizeUsage(raw) {
    const input = raw?.input_tokens ?? 0;
    const cacheRead = raw?.cached_input_tokens ?? raw?.cache_read_input_tokens ?? 0;
    const cacheWrite = raw?.cache_write_input_tokens ?? 0;
    const output = raw?.output_tokens ?? 0;
    const total = raw?.total_tokens ?? input + output;
    const numbers = [input, cacheRead, cacheWrite, output, total];
    const validNumbers = numbers.every((value) => Number.isSafeInteger(value) && value >= 0);
    const safeInput = Number.isSafeInteger(input) && input >= 0 ? input : 0;
    const safeOutput = Number.isSafeInteger(output) && output >= 0 ? output : 0;
    const safeCacheRead = Number.isSafeInteger(cacheRead) && cacheRead >= 0
        ? Math.min(cacheRead, safeInput)
        : 0;
    const safeCacheWrite = Number.isSafeInteger(cacheWrite) && cacheWrite >= 0
        ? Math.min(cacheWrite, safeInput - safeCacheRead)
        : 0;
    const uncached = safeInput - safeCacheRead - safeCacheWrite;
    const valid = validNumbers && cacheRead + cacheWrite <= input && total === input + output;
    return {
        valid,
        tokens: {
            input: safeInput,
            uncached_input: uncached,
            cache_read_input: safeCacheRead,
            cache_write_input: safeCacheWrite,
            cached_input: safeCacheRead,
            output: safeOutput,
            total: safeInput + safeOutput
        }
    };
}

function usageEquals(a, b) {
    return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "total_tokens"]
        .every((key) => (a?.[key] ?? 0) === (b?.[key] ?? 0));
}

function priceRequest({ model, serviceTier, actualTierProven, tokens, cacheWriteKind, cacheWriteBreakdown, issues = [] }) {
    const issueCodes = [...issues];
    const catalog = catalogEntryFor(model);
    if (!catalog) issueCodes.push("unknown_model");
    if (!tokens || tokens.input !== tokens.uncached_input + tokens.cache_read_input + tokens.cache_write_input || tokens.total !== tokens.input + tokens.output) {
        issueCodes.push("invalid_token_breakdown");
    }

    let tier = serviceTier;
    if (catalog?.provider === "openai") {
        if (!isNonEmptyString(tier)) issueCodes.push("missing_service_tier");
        else if (["fast", "priority"].includes(tier) && !actualTierProven) issueCodes.push("actual_service_tier_unknown");
        else if (!["default", "fast", "priority"].includes(tier)) issueCodes.push("tariff_not_found");
        if (["fast", "priority"].includes(tier) && catalog?.fast_multiplier === undefined) issueCodes.push("tariff_not_found");
    } else if (catalog?.provider === "claude") {
        tier = "standard";
        const exactWrite = ["5m", "1h"].includes(cacheWriteKind) ||
            (cacheWriteKind === "mixed" &&
                cacheWriteBreakdown?.fiveMinute + cacheWriteBreakdown?.oneHour === tokens.cache_write_input);
        if (tokens.cache_write_input > 0 && !exactWrite) issueCodes.push("tariff_not_found");
    }

    const uniqueIssues = [...new Set(issueCodes)];
    if (uniqueIssues.length > 0 || !catalog) return { priced: false, tier: tier ?? "unknown", issues: uniqueIssues };

    const rates = catalog.standard;
    const fastMultiplier = ["fast", "priority"].includes(tier) ? catalog.fast_multiplier : 1;
    const isLong = Boolean(catalog.long_context && tokens.input > catalog.long_context.threshold);
    const inputMultiplier = fastMultiplier * (isLong ? catalog.long_context.input_multiplier : 1);
    const outputMultiplier = fastMultiplier * (isLong ? catalog.long_context.output_multiplier : 1);
    const cacheWriteNano = catalog.provider === "claude" && cacheWriteKind === "mixed"
        ? (cacheWriteBreakdown.fiveMinute * rates.cache_write_5m + cacheWriteBreakdown.oneHour * rates.cache_write_1h) * inputMultiplier
        : tokens.cache_write_input * (catalog.provider === "claude"
            ? cacheWriteKind === "1h" ? rates.cache_write_1h : rates.cache_write_5m
            : rates.cache_write_input) * inputMultiplier;
    const nano = {
        uncached_input: tokens.uncached_input * rates.uncached_input * inputMultiplier,
        cache_read_input: tokens.cache_read_input * rates.cache_read_input * inputMultiplier,
        cache_write_input: cacheWriteNano,
        output: tokens.output * rates.output * outputMultiplier
    };
    nano.total = nano.uncached_input + nano.cache_read_input + nano.cache_write_input + nano.output;
    return { priced: true, tier, issues: [], nano, isLong };
}

function nanoToUsd(value) {
    return value / 1_000_000_000;
}

function costBreakdown(nano) {
    if (!nano) return null;
    return {
        uncached_input: nanoToUsd(nano.uncached_input),
        cache_read_input: nanoToUsd(nano.cache_read_input),
        cache_write_input: nanoToUsd(nano.cache_write_input),
        output: nanoToUsd(nano.output),
        total: nanoToUsd(nano.total)
    };
}

// Usage accumulator keyed by (launch, model, service tier): the hosting session and each
// subagent launch stay separate rows instead of dissolving into per-model
// totals. Launches keep first-seen order (the root unit is processed
// first); models sort alphabetically inside a launch. Codex adds one entry
// per thread (usage: raw slices for pricing); Claude adds one entry per
// API request.
function usageLedger() {
    const perLaunch = new Map();
    const pricingIssues = new Map();
    let longContextSteps = 0;
    const bucket = (launch, model, serviceTier = "unknown") => {
        const modelKey = isNonEmptyString(model) && model !== "<synthetic>" ? model : "неизвестно";
        if (!perLaunch.has(launch)) perLaunch.set(launch, new Map());
        const models = perLaunch.get(launch);
        const key = `${modelKey}\u0000${serviceTier}`;
        if (!models.has(key)) {
            models.set(key, {
                model: modelKey,
                service_tier: serviceTier,
                wall_ms: 0,
                steps: 0,
                tokens: emptyTokens(),
                nano: { uncached_input: 0, cache_read_input: 0, cache_write_input: 0, output: 0, total: 0 },
                unpriced: false
            });
        }
        return models.get(key);
    };
    const addIssue = (launch, model, serviceTier, code) => {
        const key = `${launch}\u0000${model}\u0000${serviceTier}\u0000${code}`;
        if (!pricingIssues.has(key)) pricingIssues.set(key, { code, launch, model, service_tier: serviceTier, requests: 0 });
        pricingIssues.get(key).requests += 1;
    };
    return {
        // Milliseconds of this model's own active time (one thread or one
        // agent file at a time); summed across units into wall_seconds.
        addWall(launch, model, serviceTier, ms) {
            bucket(launch, model, serviceTier).wall_ms += ms;
        },
        addRequest(launch, model, serviceTier, tokens, pricingContext = {}) {
            const priced = priceRequest({ model, serviceTier, tokens, ...pricingContext });
            const entry = bucket(launch, model, priced.tier);
            entry.steps += 1;
            addTokens(entry.tokens, tokens);
            if (priced.priced) {
                for (const key of Object.keys(entry.nano)) entry.nano[key] += priced.nano[key];
                if (priced.isLong) longContextSteps += 1;
            } else {
                entry.unpriced = true;
                for (const code of priced.issues) addIssue(launch, entry.model, entry.service_tier, code);
            }
        },
        result() {
            // A bucket can exist from wall stamps alone (a configured tier or
            // model stretch that issued no request); without a single request
            // it is attribution noise, not usage, and never becomes a row.
            const isEmpty = (entry) => entry.steps === 0 && entry.tokens.total === 0;
            const by_launch = [];
            for (const [launch, models] of perLaunch) {
                for (const [, entry] of [...models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                    if (isEmpty(entry)) continue;
                    const cost = entry.unpriced ? null : nanoToUsd(entry.nano.total);
                    by_launch.push({
                        launch,
                        model: entry.model,
                        service_tier: entry.service_tier,
                        wall_seconds: Math.round(entry.wall_ms / 1000),
                        steps: entry.steps,
                        tokens: entry.tokens,
                        token_cost_usd: cost,
                        cost_usd: cost,
                        cost_breakdown_usd: entry.unpriced ? null : costBreakdown(entry.nano),
                        unpriced: Boolean(entry.unpriced)
                    });
                }
            }
            // by_model keeps the aggregate per-model contract on top of the
            // per-launch split; sums run over raw (unrounded) USD.
            const aggregate = new Map();
            for (const [, models] of perLaunch) {
                for (const [, entry] of models) {
                    if (isEmpty(entry)) continue;
                    if (!aggregate.has(entry.model)) {
                        aggregate.set(entry.model, {
                            model: entry.model, service_tiers: new Set(), wall_seconds: 0, steps: 0,
                            tokens: emptyTokens(),
                            nano: { uncached_input: 0, cache_read_input: 0, cache_write_input: 0, output: 0, total: 0 },
                            unpriced: false
                        });
                    }
                    const agg = aggregate.get(entry.model);
                    agg.service_tiers.add(entry.service_tier);
                    agg.wall_seconds += Math.round(entry.wall_ms / 1000);
                    agg.steps += entry.steps;
                    addTokens(agg.tokens, entry.tokens);
                    if (entry.unpriced) agg.unpriced = true;
                    else for (const key of Object.keys(agg.nano)) agg.nano[key] += entry.nano[key];
                }
            }
            const sorted = [...aggregate.values()].sort((a, b) => a.model.localeCompare(b.model));
            const tokens = emptyTokens();
            let steps = 0;
            const nano = { uncached_input: 0, cache_read_input: 0, cache_write_input: 0, output: 0, total: 0 };
            let anyUnpriced = false;
            for (const entry of sorted) {
                addTokens(tokens, entry.tokens);
                steps += entry.steps;
                if (entry.unpriced) anyUnpriced = true;
                else for (const key of Object.keys(nano)) nano[key] += entry.nano[key];
            }
            const totalCost = anyUnpriced ? null : nanoToUsd(nano.total);
            return {
                by_launch: by_launch.map(({ unpriced, ...row }) => row),
                by_model: sorted.map((entry) => ({
                    model: entry.model,
                    service_tiers: [...entry.service_tiers].sort(),
                    wall_seconds: entry.wall_seconds,
                    steps: entry.steps,
                    tokens: entry.tokens,
                    token_cost_usd: entry.unpriced ? null : nanoToUsd(entry.nano.total),
                    cost_usd: entry.unpriced ? null : nanoToUsd(entry.nano.total),
                    cost_breakdown_usd: entry.unpriced ? null : costBreakdown(entry.nano)
                })),
                tokens,
                steps,
                token_cost_usd: totalCost,
                cost_usd: totalCost,
                cost_breakdown_usd: anyUnpriced ? null : costBreakdown(nano),
                unpriced_models: sorted.filter((entry) => entry.unpriced).map((entry) => entry.model),
                pricing: {
                    status: anyUnpriced ? "unpriced" : "priced",
                    basis: PRICING_CATALOG.basis,
                    catalog_version: PRICING_CATALOG.version,
                    checked_at: PRICING_CATALOG.checked_at,
                    sources: [...PRICING_CATALOG.sources],
                    service_tiers: [...new Set(by_launch.map((entry) => entry.service_tier))].sort(),
                    long_context_steps: longContextSteps,
                    issues: [...pricingIssues.values()],
                    excluded: ["tool_call_fees", "chatgpt_codex_subscription_billing"]
                }
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
// «Токены всего» is the full input (uncached + cache read + cache write —
// writes have no column of their own: Codex logs report them as 0),
// «В т.ч. кэш» its cache-read part, «Выход» separate. No input+output grand
// total is rendered: the buckets carry different tariffs, so their sum
// prices nothing. tokens.total in the machine fields still holds it.
const TABLE_HEADER = "| Роль | Время | Шаги | Токены всего | В т.ч. кэш | Выход | $ |\n|---|---:|---:|---:|---:|---:|---:|";

let launchLabel = "";

function formatThousands(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// >= 1 000 000 -> millions with exactly two decimals and the «М» suffix;
// below that -> space-separated thousands. Output tokens never use М.
function formatTokens(value) {
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}М` : formatThousands(value);
}

// Russian noun agreement for the counts embedded in findings prose.
function plural(count, one, few, many) {
    const mod100 = Math.abs(count) % 100;
    const mod10 = Math.abs(count) % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

// Cost cells read as money, not as the 4-decimal ledger figure.
function formatUsd(value) {
    if (value === null || value === undefined) return "—";
    return `$${value >= 0.01 ? value.toFixed(2) : String(round4(value))}`;
}

function formatEstimatedUsd(value) {
    const formatted = formatUsd(value);
    return formatted === "—" ? formatted : `≈${formatted}`;
}

function formatWall(wallSeconds) {
    return `${Math.floor(wallSeconds / 60)}м ${wallSeconds % 60}с`;
}

function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Rendered $ cells truncate (not round) to three decimals; the exact figures
// stay in the machine cost fields.
function formatCost(value) {
    return value === null ? "тариф не определён" : (Math.trunc(value * 1000) / 1000).toFixed(3);
}

function renderUsage({ label, wall_seconds, by_launch, tokens, steps, cost_usd }) {
    const entries = by_launch.length > 0
        ? by_launch
        : [{ launch: label, model: "неизвестно", service_tier: "unknown", wall_seconds, steps: 0, tokens: emptyTokens(), cost_usd: null }];
    const rows = entries
        .map((entry) =>
            [
                "",
                `${entry.launch}<br>*${entry.model} · ${entry.service_tier}*`,
                formatWall(entry.wall_seconds),
                formatThousands(entry.steps),
                formatTokens(entry.tokens.input),
                formatTokens(entry.tokens.cache_read_input),
                formatThousands(entry.tokens.output),
                formatCost(entry.cost_usd),
                ""
            ]
                .join(" | ")
                .trim()
        )
        .join("\n");

    const totalCost = formatCost(cost_usd);
    // The ИТОГО line closes a multi-row block: launch-level wall time
    // (per-model wall sums may exceed it) plus the summed tokens/steps/cost.
    // A one-row table skips it — the total would only repeat the row.
    const total_row = entries.length > 1
        ? [
            "",
            "**ИТОГО**",
            formatWall(wall_seconds),
            formatThousands(steps),
            formatTokens(tokens.input),
            formatTokens(tokens.cache_read_input),
            formatThousands(tokens.output),
            totalCost,
            ""
        ]
            .join(" | ")
            .trim()
        : undefined;
    const items = entries
        .map((entry) =>
            `<li><b>${escapeHtml(entry.launch)} · ${escapeHtml(entry.model)} · ${escapeHtml(entry.service_tier)}</b>: ${formatWall(entry.wall_seconds)} · ` +
            `шаги ${formatThousands(entry.steps)} · токены всего ${formatTokens(entry.tokens.input)} · ` +
            `в т.ч. кэш ${formatTokens(entry.tokens.cache_read_input)} · выход ${formatThousands(entry.tokens.output)}` +
            `${entry.cost_usd === null ? " · тариф не определён" : ` · $ ${formatCost(entry.cost_usd)}`}</li>`
        )
        .join("");
    const comment_html =
        `<p>Метрики ${escapeHtml(label)}: ${formatWall(wall_seconds)} · шаги ${formatThousands(steps)} · ${cost_usd === null ? "тариф не определён" : `$ ${totalCost}`}</p><ul>${items}</ul>`;

    return {
        rendered: {
            block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}${total_row === undefined ? "" : `\n${total_row}`}`,
            table_header: TABLE_HEADER,
            rows,
            ...(total_row === undefined ? {} : { total_row })
        },
        comment_html
    };
}

// The analysis block answers «почему столько», not «сколько» — it is rendered
// separately and pasted after rendered.block, never merged into it.
// Prose, not a table: the tables say where tokens are, this says what to do
// about it. Two lists — the largest cost items (overhead is not automatically
// waste) and the ones that bought nothing — each item stating the number it
// rests on, then the action.
function renderVerdict(analysis) {
    const lines = ["Выводы:"];
    const cost = (item) => item.estimated_cost_usd === null
        ? formatTokens(item.tokens)
        : formatEstimatedUsd(item.estimated_cost_usd);
    // Facts are written as clause fragments so they can also read inline;
    // here each opens its own sentence.
    const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

    if (analysis.verdict.largest.length > 0) {
        lines.push("", "**Куда ушло больше всего.**");
        analysis.verdict.largest.forEach((item, index) => {
            lines.push(`${index + 1}. **${item.title}** — ${cost(item)}. ${sentence(item.fact)}. ${item.advice}`);
        });
    }

    if (analysis.verdict.waste.length > 0) {
        lines.push("", "**Потрачено впустую.**");
        analysis.verdict.waste.forEach((item, index) => {
            lines.push(`${index + 1}. **${item.title}** — ${cost(item)}. ${sentence(item.fact)}. ${item.advice}`);
        });
    } else {
        lines.push("", "**Потрачено впустую.** Повторных чтений, ошибочных вызовов и лишней перестройки кэша не найдено.");
    }

    const perStep = analysis.estimated_priced
        ? `${formatEstimatedUsd(analysis.per_step.estimated_cost_usd)} за шаг`
        : `+${formatTokens(analysis.per_step.growth)} контекста за шаг`;
    const closing = [`**На будущее.** Оценка составила ${perStep} на ${formatThousands(analysis.requests)} ${plural(analysis.requests, "шаге", "шагах", "шагах")}.`];
    if (analysis.units > 1) {
        closing.push(
            `Холодный старт ${formatThousands(analysis.units)} ${plural(analysis.units, "юнита", "юнитов", "юнитов")} стоил ${formatTokens(analysis.base.tokens)} ещё до первого полезного действия — дробить задачу на новые запуски выгодно только когда каждый экономит больше шагов, чем стоит его старт.`
        );
    }
    if (analysis.resets > 0) {
        closing.push(
            `Контекст сбрасывался ${formatThousands(analysis.resets)} ${plural(analysis.resets, "раз", "раза", "раз")} — после сброса модель дочитывает то, что уже читала, так что дешевле уложиться до порога, чем пережить компакцию.`
        );
    }
    if (analysis.coverage.share < 0.5) {
        closing.push(
            `Атрибуция объяснила ${Math.round(analysis.coverage.share * 100)}% прироста — остальное принесли сообщения пользователя и вывод модели, так что разбивку по инструментам читать как нижнюю границу.`
        );
    }
    lines.push("", closing.join(" "));
    return lines;
}

function renderAnalysis(analysis) {
    const percent = (value) => `${Math.round(value * 100)}%`;
    const toolRows = analysis.by_tool
        .slice(0, ANALYSIS_TOP_TOOLS)
        .map((entry) =>
            `| ${entry.tool} | ${formatThousands(entry.calls)} | ${formatTokens(entry.injected)} | ` +
            `${formatTokens(entry.resent)} | ${entry.errors === 0 ? "—" : formatThousands(entry.errors)} | ${formatEstimatedUsd(entry.estimated_cost_usd)} |`
        );
    const hidden = analysis.by_tool.length - Math.min(analysis.by_tool.length, ANALYSIS_TOP_TOOLS);
    if (hidden > 0) {
        const rest = analysis.by_tool.slice(ANALYSIS_TOP_TOOLS);
        const restErrors = rest.reduce((sum, entry) => sum + entry.errors, 0);
        toolRows.push(
            `| *ещё ${formatThousands(hidden)}* | ${formatThousands(rest.reduce((sum, entry) => sum + entry.calls, 0))} | ` +
            `${formatTokens(rest.reduce((sum, entry) => sum + entry.injected, 0))} | ` +
            `${formatTokens(rest.reduce((sum, entry) => sum + entry.resent, 0))} | ` +
            `${restErrors === 0 ? "—" : formatThousands(restErrors)} | ` +
            `${formatEstimatedUsd(rest.reduce((sum, entry) => sum + (entry.estimated_cost_usd ?? 0), 0) || null)} |`
        );
    }

    const sections = [
        "Анализ контекста:",
        "",
        "| Показатель | Значение |",
        "|---|---:|",
        `| Шагов (запросов к модели) | ${formatThousands(analysis.requests)} |`,
        `| Контекст: старт → пик | ${formatTokens(analysis.context.start)} → ${formatTokens(analysis.context.peak)} |`,
        `| Прирост контекста | ${formatTokens(analysis.context.growth)} |`,
        `| Базовый контекст, переслан | ${formatTokens(analysis.base.tokens)} × ${formatThousands(Math.max(0, analysis.requests - analysis.units))} = ${formatTokens(analysis.base.resent)} (${percent(analysis.base.share)}) |`,
        `| Пересылок всего | ${formatTokens(analysis.resends.total)} |`,
        `| Прирост объяснён | ${percent(analysis.coverage.share)} |`,
        `| Оценка цены шага | ${analysis.estimated_priced ? formatEstimatedUsd(analysis.per_step.estimated_cost_usd) : "—"} · +${formatTokens(analysis.per_step.growth)} контекста |`
    ];
    if (analysis.units > 1) {
        sections.push(
            `| Холодный старт | ${formatThousands(analysis.units)} ${plural(analysis.units, "юнит", "юнита", "юнитов")} × ~${formatTokens(analysis.base.per_unit)} = ${formatTokens(analysis.base.tokens)} |`
        );
    }
    if (analysis.estimated_priced && (analysis.cache.estimated_rebuild_overpay_usd ?? 0) > 0) {
        sections.push(
            `| Кэш предположительно переписан | ${formatTokens(analysis.cache.estimated_rebuilt)} = ${formatEstimatedUsd(analysis.cache.estimated_rebuild_overpay_usd)} |`
        );
    }
    if (analysis.per_step.by_launch.length > 1) {
        const worst = analysis.per_step.by_launch[0];
        sections.push(`| Дороже всех на шаг | ${worst.launch} — ${formatEstimatedUsd(worst.estimated_per_step)} × ${formatThousands(worst.steps)} |`);
    }
    if (analysis.resets > 0) sections.push(`| Сбросов контекста (компакция) | ${formatThousands(analysis.resets)} |`);
    if (analysis.cache.read > 0 || analysis.cache.write > 0) {
        sections.push(`| Кэш: чтений / записей | ${formatTokens(analysis.cache.read)} / ${formatTokens(analysis.cache.write)} |`);
    }

    if (toolRows.length > 0) {
        sections.push(
            "",
            "| Инструмент | Вызовов | Влил | Пересылок | Ошибок | ≈$ |",
            "|---|---:|---:|---:|---:|---:|",
            ...toolRows
        );
    }
    if (analysis.by_detail.length > 0) {
        sections.push(
            "",
            "| Конкретный источник | Вызовов | Влил | Пересылок | ≈$ |",
            "|---|---:|---:|---:|---:|",
            ...analysis.by_detail.map((entry) =>
                `| ${entry.detail} | ${formatThousands(entry.calls)} | ${formatTokens(entry.injected)} | ${formatTokens(entry.resent)} | ${formatEstimatedUsd(entry.estimated_cost_usd)} |`
            )
        );
    }
    sections.push("", ...renderVerdict(analysis));
    sections.push(
        "",
        "*«Влил» — сколько токенов результат добавил в контекст (из измеренного прироста шага). " +
        "«Пересылок» — сколько токенов ушло на повторную отправку этого куска на следующих шагах. " +
        "Суммы токенов и кэш в основной таблице точные; вся атрибуция причин и денег в этом блоке эвристическая.*"
    );
    return sections.join("\n");
}

// Token-weighted rates across the models this launch actually used, so the
// analysis can price re-sends without pretending they all ran on one model.
// Re-sent context bills as a cache read; a chunk's first appearance bills as
// a cache write. Null when no model in the launch has a catalog entry.
function blendedRates(byModel) {
    let weight = 0;
    const blend = { input: 0, cached_input: 0, cache_write: 0, output: 0 };
    for (const entry of byModel) {
        const rate = rateFor(entry.model);
        if (!rate) continue;
        const share = entry.tokens.total;
        if (share <= 0) continue;
        weight += share;
        blend.input += share * rate.input;
        blend.cached_input += share * rate.cached_input;
        blend.cache_write += share * (rate.cache_write_5m ?? rate.input);
        blend.output += share * rate.output;
    }
    if (weight === 0) return null;
    for (const key of Object.keys(blend)) blend[key] /= weight;
    return blend;
}

const round4 = (value) => Math.round(value * 10_000) / 10_000;

// Advice is tied to the kind of source, because the fix differs: a skill is
// loaded whole and never leaves, an MCP answer is sized by its request, a
// file read can be ranged, a command's output can be filtered.
function adviceForTool(tool) {
    if (tool.startsWith("Skill:")) {
        return "Скил грузится целиком и живёт до конца запуска — вынести редкие разделы в отдельные файлы, чтобы они читались только при необходимости.";
    }
    if (tool.startsWith("MCP ")) {
        return "Ответ MCP оседает в контексте навсегда — запрашивать меньший объём (лимиты, поля, пагинация) вместо полной выдачи.";
    }
    if (tool.startsWith("Агент:")) {
        return "Сабагент возвращает отчёт в родительский контекст — просить сжатый результат, а не полный пересказ работы.";
    }
    if (tool === "Read") {
        return "Читать нужный диапазон (offset/limit), а не файл целиком: прочитанное пересылается на каждом следующем шаге.";
    }
    if (tool === "Bash" || tool === "Shell") {
        return "Резать вывод на стороне команды (head, grep, --quiet), а не сваливать полный лог в контекст.";
    }
    if (tool === "WebFetch") return "Страницы попадают в контекст целиком — забирать только нужный фрагмент.";
    return "Проверить, нужен ли полный ответ этого инструмента — в контексте он останется до конца запуска.";
}

// Estimates attribution cost with blended standard rates. The exact request
// ledger above is authoritative; causal attribution remains heuristic.
function priceAnalysis(analysis, result) {
    const rates = blendedRates(result.by_model ?? []);
    analysis.accuracy = "inferred";
    analysis.estimated_priced = rates !== null;
    const charge = (injected, resent) =>
        rates === null ? null : round4((injected * rates.cache_write + resent * rates.cached_input) / 1_000_000);

    analysis.per_step = {
        estimated_cost_usd: result.cost_usd !== null && analysis.requests > 0
            ? round4(result.cost_usd / analysis.requests)
            : null,
        growth: analysis.requests > 0 ? Math.round(analysis.context.growth / analysis.requests) : 0
    };
    analysis.base.estimated_cost_usd = charge(analysis.base.tokens, analysis.base.resent);
    for (const entry of analysis.by_tool) entry.estimated_cost_usd = charge(entry.injected, entry.resent);
    for (const entry of analysis.by_detail) entry.estimated_cost_usd = charge(entry.injected, entry.resent);
    for (const entry of analysis.repeats) entry.estimated_cost_usd = charge(entry.injected, entry.resent);
    analysis.errors.estimated_cost_usd = charge(analysis.errors.injected, analysis.errors.resent);
    // Caching new content is unavoidable and costs the write rate once. Only
    // the writes beyond the context the launch actually gained are rebuilds
    // of content that had been cached already; the overpay is that excess at
    // the gap between the write and the read rate. A conservative floor: the
    // baseline charges every new token as if it were cached perfectly.
    analysis.cache.estimated_rebuilt = Math.max(0, analysis.cache.write - analysis.context.growth);
    analysis.cache.estimated_rebuild_overpay_usd = rates === null
        ? null
        : round4((analysis.cache.estimated_rebuilt * (rates.cache_write - rates.cached_input)) / 1_000_000);

    // The launch paying most per step, over enough steps to mean something.
    const perLaunch = new Map();
    for (const row of result.by_launch ?? []) {
        if (!perLaunch.has(row.launch)) perLaunch.set(row.launch, { launch: row.launch, steps: 0, estimated_cost_usd: 0, unpriced: false });
        const entry = perLaunch.get(row.launch);
        entry.steps += row.steps;
        if (row.cost_usd === null) entry.unpriced = true;
        else entry.estimated_cost_usd += row.cost_usd;
    }
    const ranked = [...perLaunch.values()]
        .filter((entry) => entry.steps >= 3 && !entry.unpriced)
        .map((entry) => ({ ...entry, estimated_per_step: round4(entry.estimated_cost_usd / entry.steps) }))
        .sort((a, b) => b.estimated_per_step - a.estimated_per_step);
    analysis.per_step.by_launch = ranked;

    analysis.verdict = buildVerdict(analysis);
}

// Two ranked lists: the largest cost items (overhead, not necessarily waste)
// and the ones that are pure loss (redundant re-reads, failed calls, cache
// rebuilt for nothing). Ordered by money where prices exist, by tokens where
// they do not.
function buildVerdict(analysis) {
    const size = (estimatedCost, tokens) => (estimatedCost === null ? tokens : estimatedCost);
    const largest = [];
    if (analysis.base.share > 0.15) {
        largest.push({
            key: "base",
            title: "Базовый контекст",
            estimated_cost_usd: analysis.base.estimated_cost_usd,
            tokens: analysis.base.tokens + analysis.base.resent,
            fact:
                `${formatTokens(analysis.base.tokens)} на старте` +
                `${analysis.units > 1 ? ` (${formatThousands(analysis.units)} ${plural(analysis.units, "юнит", "юнита", "юнитов")} × ~${formatTokens(analysis.base.per_unit)})` : ""}` +
                `, переслан ${formatThousands(Math.max(0, analysis.requests - analysis.units))} ${plural(Math.max(0, analysis.requests - analysis.units), "раз", "раза", "раз")}` +
                ` — ${Math.round(analysis.base.share * 100)}% всех пересылок`,
            advice:
                analysis.units > 1
                    ? "Каждый сабагент начинает свой контекст с нуля — отключить неиспользуемые MCP-серверы, сократить текст скилов и не дробить задачу на лишние запуски."
                    : "Это системный промпт, схемы инструментов и текст скилов. Режется отключением неиспользуемых MCP-серверов и сокращением скилов, а не работой агента."
        });
    }
    for (const entry of analysis.by_tool.slice(0, 3)) {
        if (entry.injected + entry.resent <= 0) continue;
        largest.push({
            key: `tool:${entry.tool}`,
            title: entry.tool,
            estimated_cost_usd: entry.estimated_cost_usd,
            tokens: entry.injected + entry.resent,
            fact:
                `${formatThousands(entry.calls)} ${plural(entry.calls, "вызов", "вызова", "вызовов")}, ` +
                `влил ${formatTokens(entry.injected)}, переслано ${formatTokens(entry.resent)}`,
            advice: adviceForTool(entry.tool)
        });
    }
    largest.sort((a, b) => size(b.estimated_cost_usd, b.tokens) - size(a.estimated_cost_usd, a.tokens));

    const waste = [];
    for (const entry of analysis.repeats) {
        // Only the calls after the first re-inject bytes already in context.
        const share = (entry.calls - 1) / entry.calls;
        waste.push({
            title: entry.detail,
            estimated_cost_usd: entry.estimated_cost_usd === null ? null : round4(entry.estimated_cost_usd * share),
            tokens: Math.round((entry.injected + entry.resent) * share),
            fact: `запрошен ${formatThousands(entry.calls)} ${plural(entry.calls, "раз", "раза", "раз")} — лишние ${formatThousands(entry.calls - 1)} вернули то же содержимое`,
            advice: "Держать прочитанное в рабочих заметках вместо повторного чтения."
        });
    }
    if (analysis.errors.calls > 0 && analysis.errors.injected + analysis.errors.resent > 0) {
        waste.push({
            title: "Неудачные вызовы инструментов",
            estimated_cost_usd: analysis.errors.estimated_cost_usd,
            tokens: analysis.errors.injected + analysis.errors.resent,
            fact: `${formatThousands(analysis.errors.calls)} ${plural(analysis.errors.calls, "вызов", "вызова", "вызовов")} вернули ошибку, их вывод всё равно осел в контексте`,
            advice: "Ошибка стоит полный шаг и обычно повторяется с ещё большим контекстом — чинить причину, а не повторять вызов."
        });
    }
    if (analysis.cache.estimated_rebuilt > 0 && (analysis.cache.estimated_rebuild_overpay_usd ?? 0) > 0) {
        waste.push({
            title: "Перестройка кэша",
            estimated_cost_usd: analysis.cache.estimated_rebuild_overpay_usd,
            tokens: analysis.cache.estimated_rebuilt,
            fact:
                `записей в кэш ${formatTokens(analysis.cache.write)} при приросте контекста ${formatTokens(analysis.context.growth)} — ` +
                `${formatTokens(analysis.cache.estimated_rebuilt)} сверх нового содержимого записаны повторно`,
            advice: "Кэш перестраивается из-за пауз дольше его TTL между шагами или правок в начале контекста; плотнее идущие шаги платят меньше."
        });
    }
    waste.sort((a, b) => size(b.estimated_cost_usd, b.tokens) - size(a.estimated_cost_usd, a.tokens));

    return { largest: largest.slice(0, 4), waste: waste.slice(0, 4) };
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

// --- Context attribution (analysis mode) ------------------------------------
// Token totals come from the logs and are exact; what the logs never say is
// which tool result is sitting inside them. Attribution splits the measured
// context growth of each step between the tool results that arrived during
// it, then multiplies every chunk by how many later steps re-sent it. The
// split is the only estimated part — a step holding a single tool result is
// exact — and coverage reports how much of the measured growth was placed.

const CHARS_PER_TOKEN = 4;
// A context smaller than this fraction of the previous step's means the
// window was reset (compaction or /clear): earlier chunks stop being re-sent.
const RESET_RATIO = 0.7;
const ANALYSIS_TOP_TOOLS = 8;
const ANALYSIS_TOP_DETAILS = 6;
const ANALYSIS_TOP_REPEATS = 5;

function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return String(value);
    }
}

// Relative size only — used to share one step's growth between several tool
// results, never as a token count of its own.
function estimateSize(value) {
    if (value === undefined || value === null) return 0;
    const text = typeof value === "string" ? value : safeStringify(value);
    return Math.round(text.length / CHARS_PER_TOKEN);
}

function shortHost(url) {
    const match = /^https?:\/\/([^/]+)/.exec(String(url ?? ""));
    return match ? match[1] : null;
}

// Claude tool_use block → groupable label plus the one identifier worth
// ranking separately (file, command word, host).
function claudeToolLabel(name, input) {
    const ti = input && typeof input === "object" ? input : {};
    if (!isNonEmptyString(name)) return { tool: "неизвестно", detail: null };
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return { tool: `MCP ${mcp[1]}/${mcp[2]}`, detail: null, repeatable: true };
    if (name === "Task" || name === "Agent") return { tool: `Агент:${ti.subagent_type ?? "без имени"}`, detail: null };
    if (name === "Skill") return { tool: `Skill:${ti.skill ?? ti.skill_name ?? "без имени"}`, detail: null };
    if (["Read", "Edit", "Write", "NotebookEdit", "MultiEdit"].includes(name)) {
        return { tool: name, detail: ti.file_path ?? ti.notebook_path ?? null, repeatable: name === "Read" };
    }
    if (name === "Bash") {
        const head = String(ti.command ?? "").trim().split(/\s+/)[0];
        return { tool: "Bash", detail: head || null };
    }
    if (name === "WebFetch") return { tool: "WebFetch", detail: shortHost(ti.url), repeatable: true };
    return { tool: name, detail: null };
}

// Codex function_call → same shape; `arguments` arrives as a JSON string.
function codexToolLabel(name, rawArguments) {
    if (!isNonEmptyString(name)) return { tool: "неизвестно", detail: null };
    let args = {};
    try {
        const parsed = JSON.parse(rawArguments ?? "{}");
        if (parsed && typeof parsed === "object") args = parsed;
    } catch {
        args = {};
    }
    if (name === "shell" || name === "exec_command" || name === "local_shell") {
        const raw = Array.isArray(args.cmd) ? args.cmd.join(" ") : String(args.cmd ?? args.command ?? "");
        const head = raw.trim().split(/\s+/)[0];
        return { tool: "Shell", detail: head || null };
    }
    if (name === "apply_patch") return { tool: "apply_patch", detail: null };
    if (name === "update_plan") return { tool: "update_plan", detail: null };
    return { tool: name, detail: null };
}

// One unit (Codex thread or Claude agent file) walked in record order:
// `points` holds each model request as {ctx, output}, `events` each tool
// result as {tool, detail, size, isError, after} where `after` is how many
// requests the unit had already made — so the event landed between request
// after-1 and request after.
function analyzeUnit(points, events) {
    const total = points.length;
    if (total === 0) return null;
    // Where each step's context stops being re-sent: a reset ends the
    // preceding segment, so chunks before it are never charged past it.
    const segmentEnd = new Array(total);
    let resets = 0;
    let end = total - 1;
    for (let i = total - 1; i >= 0; i -= 1) {
        segmentEnd[i] = end;
        if (i > 0 && points[i].ctx < points[i - 1].ctx * RESET_RATIO) {
            resets += 1;
            end = i - 1;
        }
    }

    const byGap = new Map();
    for (const event of events) {
        if (event.after < 1 || event.after > total - 1) continue;
        if (!byGap.has(event.after)) byGap.set(event.after, []);
        byGap.get(event.after).push(event);
    }

    let growth = 0;
    let attributed = 0;
    for (let gap = 1; gap <= total - 1; gap += 1) {
        const delta = points[gap].ctx - points[gap - 1].ctx;
        if (delta > 0) growth += delta;
        const list = byGap.get(gap);
        if (!list || delta <= 0) continue;
        // The step's own output also enters the next context; only the rest
        // can belong to tool results.
        const toolGrowth = Math.max(0, delta - (points[gap - 1].output ?? 0));
        const weight = list.reduce((sum, event) => sum + Math.max(1, event.size), 0);
        const multiplier = Math.max(0, segmentEnd[gap] - gap);
        for (const event of list) {
            event.injected = Math.round((toolGrowth * Math.max(1, event.size)) / weight);
            event.resent = event.injected * multiplier;
            attributed += event.injected;
        }
    }

    return {
        requests: total,
        // The unit's opening context — system prompt, tool schemas, skill
        // text, first message — re-sent by every later step and attributable
        // to no tool at all.
        base: points[0].ctx,
        base_resent: points[0].ctx * (total - 1),
        ctx_start: points[0].ctx,
        ctx_peak: Math.max(...points.map((point) => point.ctx)),
        ctx_end: points[total - 1].ctx,
        growth,
        attributed,
        resets,
        events
    };
}

// Merges per-unit attribution into the report-level `analysis` object.
function analysisTracker() {
    const tools = new Map();
    const details = new Map();
    const errors = { calls: 0, injected: 0, resent: 0 };
    let requests = 0;
    let base = 0;
    let baseResent = 0;
    let growth = 0;
    let attributed = 0;
    let resets = 0;
    let ctxStart;
    let ctxPeak = 0;
    let units = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    const bump = (map, key, event) => {
        if (!map.has(key)) map.set(key, { calls: 0, errors: 0, injected: 0, resent: 0, repeatable: false });
        const entry = map.get(key);
        if (event.repeatable) entry.repeatable = true;
        entry.calls += 1;
        entry.errors += event.isError ? 1 : 0;
        entry.injected += event.injected ?? 0;
        entry.resent += event.resent ?? 0;
    };

    return {
        addCache(read, write) {
            cacheRead += read;
            cacheWrite += write;
        },
        addUnit(points, events) {
            const unit = analyzeUnit(points, events);
            if (!unit) return;
            units += 1;
            requests += unit.requests;
            base += unit.base;
            baseResent += unit.base_resent;
            growth += unit.growth;
            attributed += unit.attributed;
            resets += unit.resets;
            if (ctxStart === undefined) ctxStart = unit.ctx_start;
            if (unit.ctx_peak > ctxPeak) ctxPeak = unit.ctx_peak;
            for (const event of unit.events) {
                bump(tools, event.tool, event);
                if (isNonEmptyString(event.detail)) bump(details, `${event.tool} · ${event.detail}`, event);
                if (event.isError) {
                    errors.calls += 1;
                    errors.injected += event.injected ?? 0;
                    errors.resent += event.resent ?? 0;
                }
            }
        },
        result() {
            if (requests === 0) return null;
            const rank = (map) =>
                [...map.entries()]
                    .map(([key, entry]) => ({ key, ...entry }))
                    .sort((a, b) => b.resent + b.injected - (a.resent + a.injected) || a.key.localeCompare(b.key));
            const byTool = rank(tools);
            const byDetail = rank(details).filter((entry) => entry.injected > 0);
            // Only content-bearing sources: a second Read of one file re-injects
            // the same bytes, a second `git` command does not.
            const repeats = byDetail.filter((entry) => entry.calls > 1 && entry.repeatable).slice(0, ANALYSIS_TOP_REPEATS);
            const toolTotal = byTool.reduce((sum, entry) => sum + entry.injected + entry.resent, 0);
            const resendTotal = toolTotal + baseResent;
            return {
                units,
                requests,
                context: { start: ctxStart ?? 0, peak: ctxPeak, growth },
                base: {
                    tokens: base,
                    per_unit: Math.round(base / units),
                    resent: baseResent,
                    share: resendTotal > 0 ? baseResent / resendTotal : 0
                },
                errors,
                resends: { attributed_to_tools: toolTotal, total: resendTotal, measured_cache_read: cacheRead },
                coverage: { attributed: attributed, growth, share: growth > 0 ? Math.min(1, attributed / growth) : 0 },
                resets,
                cache: { read: cacheRead, write: cacheWrite },
                by_tool: byTool.map(({ key, repeatable, ...entry }) => ({ tool: key, ...entry })),
                by_detail: byDetail.slice(0, ANALYSIS_TOP_DETAILS).map(({ key, repeatable, ...entry }) => ({ detail: key, ...entry })),
                repeats: repeats.map(({ key, repeatable, ...entry }) => ({ detail: key, ...entry }))
            };
        }
    };
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

function emit(label, span, agents, models, ledger, source, analysis, full) {
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
    const rendered = renderUsage(result);
    // Analysis is opt-in and stays a separate field: existing callers paste
    // rendered.block unchanged and never see it.
    if (analysis) {
        priceAnalysis(analysis, result);
        result.analysis = analysis;
        rendered.rendered.analysis_block = renderAnalysis(analysis);
    }
    // Callers paste rendered strings and comment_html verbatim; the machine
    // fields have no readers outside tests, so by default they stay out of
    // the caller's context. full:true (tests/debugging) prints everything.
    out(full ? { ...result, ...rendered } : { ok: true, label, ...rendered });
}

async function collectCodex({ sessionId, rootAgentRef, label, analyze, full, codexRoot, codexArchivedRoot }) {
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
    const analysis = analyze ? analysisTracker() : null;
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
        let reroutedModel;
        let configuredTier;
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
        // Analysis mode only: model requests in order, and each tool result
        // tagged with how many requests preceded it.
        const points = [];
        const events = [];
        const pendingCalls = new Map();
        for (const record of records) {
            span.stamp(record.timestamp);
            const ms = toMillis(record.timestamp);
            const payload = record?.payload;
            if (analysis && record?.type === "response_item") {
                if ((payload?.type === "function_call" || payload?.type === "custom_tool_call") && isNonEmptyString(payload.call_id)) {
                    pendingCalls.set(
                        payload.call_id,
                        codexToolLabel(payload.name, payload.arguments ?? payload.input)
                    );
                } else if (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") {
                    const named = pendingCalls.get(payload.call_id) ?? { tool: "неизвестно", detail: null };
                    const output = payload.output;
                    const text = typeof output === "string" ? output : safeStringify(output);
                    const exit = /"exit_code"\s*:\s*(\d+)|exited with code (\d+)/.exec(text);
                    events.push({
                        tool: named.tool,
                        detail: named.detail,
                        repeatable: named.repeatable === true,
                        size: estimateSize(output),
                        isError: Boolean(exit && (exit[1] ?? exit[2]) !== "0"),
                        after: points.length
                    });
                }
            }
            if (record?.type === "event_msg" && payload?.type === "thread_settings_applied") {
                const appliedTier = payload?.thread_settings?.service_tier;
                if (isNonEmptyString(appliedTier)) configuredTier = appliedTier;
            }
            if (record?.type === "event_msg" && ["model_rerouted", "model/rerouted"].includes(payload?.type)) {
                const toModel = payload?.to_model ?? payload?.toModel;
                if (isNonEmptyString(toModel)) {
                    reroutedModel = toModel;
                    models.add(toModel);
                }
            }
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
                reroutedModel = undefined;
                if (isNonEmptyString(payload?.service_tier)) configuredTier = payload.service_tier;
            }
            const requestModel = reroutedModel ?? activeModel;
            if (requestModel !== undefined && ms !== undefined) {
                const activityKey = JSON.stringify([requestModel, configuredTier ?? "default"]);
                if (!modelStamps.has(activityKey)) modelStamps.set(activityKey, []);
                modelStamps.get(activityKey).push(ms);
            }
            if (record?.type === "event_msg" && payload?.type === "token_count" && payload.info?.total_token_usage) {
                if (analysis) {
                    // last_token_usage.input_tokens is this request's whole
                    // context; without it the step contributes no growth
                    // point rather than a wrong one.
                    const last = payload.info.last_token_usage;
                    if (last && Number.isFinite(last.input_tokens)) {
                        points.push({ ctx: last.input_tokens, output: last.output_tokens ?? 0 });
                    }
                }
                const cur = payload.info.total_token_usage;
                const now = {
                    input_tokens: cur.input_tokens ?? 0,
                    cached_input_tokens: cur.cached_input_tokens ?? 0,
                    cache_write_input_tokens: cur.cache_write_input_tokens ?? 0,
                    output_tokens: cur.output_tokens ?? 0
                };
                now.total_tokens = cur.total_tokens ?? now.input_tokens + now.output_tokens;
                let delta = prev
                    ? Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - prev[key]]))
                    : { ...now };
                const reset = Object.values(delta).some((value) => value < 0);
                if (reset) delta = { ...now };
                prev = now;
                // Repeated cumulative notifications carry no new request.
                if (Object.values(delta).every((value) => value === 0)) continue;

                const last = payload.info.last_token_usage;
                const pricingIssues = [];
                let requestUsage = delta;
                if (last) {
                    if (usageEquals(last, delta)) requestUsage = last;
                    else pricingIssues.push("usage_mismatch");
                }
                const normalized = normalizeUsage(requestUsage);
                if (!normalized.valid) pricingIssues.push("invalid_token_breakdown");
                if (analysis) analysis.addCache(normalized.tokens.cache_read_input, normalized.tokens.cache_write_input);

                const actualTier = payload.info.actual_service_tier ?? payload.info.service_tier;
                // A thread that never records a tier runs Standard: user
                // rollouts write service_tier explicitly (even "default"),
                // while spawned subagent threads omit the field entirely —
                // absence is the unset default, not an unknown override.
                const serviceTier = isNonEmptyString(actualTier) ? actualTier : configuredTier ?? "default";
                ledger.addRequest(unitLabel, requestModel, serviceTier, normalized.tokens, {
                    actualTierProven: isNonEmptyString(actualTier) || serviceTier === "default",
                    issues: pricingIssues
                });
            }
        }
        if (openTurnStart !== undefined && unitMax !== undefined) turnBounds.push([openTurnStart, unitMax]);
        // Exact turn intervals when the thread has markers; otherwise its
        // stamps join the shared idle-gap fallback pool.
        const unitIntervals = turnBounds.length > 0 ? mergeIntervals(turnBounds) : gapSegments(unitStamps);
        if (turnBounds.length > 0) span.addIntervals(unitIntervals);
        else span.addFallbackStamps(unitStamps);
        for (const [activityKey, stamps] of modelStamps) {
            const [model, serviceTier] = JSON.parse(activityKey);
            ledger.addWall(unitLabel, model, serviceTier, intervalsLength(clipToIntervals(gapSegments(stamps), unitIntervals)));
        }
        if (analysis) analysis.addUnit(points, events);
    }
    emit(label, span, selected.size, models, ledger, "codex", analysis?.result() ?? undefined, full);
}

async function collectClaude({ sessionId, rootAgentRef, label, analyze, full, claudeProjectsRoot }) {
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
    const analysis = analyze ? analysisTracker() : null;
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
        // Analysis mode only: one point per API request in order (streaming
        // records of the same request update the point in place), plus each
        // tool result tagged with how many requests preceded it.
        const points = [];
        const pointIndex = new Map();
        const events = [];
        const analysisNames = new Map();
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
                        if (analysis) analysisNames.set(block.id, claudeToolLabel(block.name, block.input));
                    }
                }
            }
            if (analysis && Array.isArray(content)) {
                for (const block of content) {
                    if (block?.type !== "tool_result") continue;
                    const named = analysisNames.get(block.tool_use_id) ?? { tool: "неизвестно", detail: null };
                    events.push({
                        tool: named.tool,
                        detail: named.detail,
                        repeatable: named.repeatable === true,
                        size: estimateSize(block.content ?? record.toolUseResult),
                        isError: block.is_error === true,
                        after: points.length
                    });
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
            if (usage) {
                const requestKey = record.requestId ?? record.uuid;
                usageByRequest.set(requestKey, { usage, model });
                if (analysis) {
                    // The whole context this request carried; streaming
                    // records repeat it and only grow the output.
                    const point = {
                        ctx: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
                        output: usage.output_tokens ?? 0
                    };
                    if (pointIndex.has(requestKey)) points[pointIndex.get(requestKey)] = point;
                    else {
                        pointIndex.set(requestKey, points.length);
                        points.push(point);
                    }
                }
            }
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
            ledger.addWall(unitLabel, model, "standard", intervalsLength(clipToIntervals(gapSegments(stamps), unitIntervals)));
        }
        if (analysis) analysis.addUnit(points, events);
        for (const { usage, model } of usageByRequest.values()) {
            const input = usage.input_tokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const output = usage.output_tokens ?? 0;
            const details = usage.cache_creation ?? usage.cache_creation_details ?? {};
            const fiveMinute = details.ephemeral_5m_input_tokens ?? usage.cache_creation_5m_input_tokens ?? 0;
            const oneHour = details.ephemeral_1h_input_tokens ?? usage.cache_creation_1h_input_tokens ?? 0;
            let cacheWriteKind;
            if (cacheCreate > 0 && fiveMinute + oneHour === cacheCreate) {
                cacheWriteKind = fiveMinute > 0 && oneHour > 0 ? "mixed" : oneHour > 0 ? "1h" : "5m";
            }
            if (analysis) analysis.addCache(cacheRead, cacheCreate);
            const normalized = normalizeUsage({
                input_tokens: input + cacheCreate + cacheRead,
                cached_input_tokens: cacheRead,
                cache_write_input_tokens: cacheCreate,
                output_tokens: output,
                total_tokens: input + cacheCreate + cacheRead + output
            });
            ledger.addRequest(unitLabel, model, "standard", normalized.tokens, {
                actualTierProven: true,
                cacheWriteKind,
                cacheWriteBreakdown: { fiveMinute, oneHour },
                issues: normalized.valid ? [] : ["invalid_token_breakdown"]
            });
        }
    }
    emit(label, span, selected.size, models, ledger, "claude", analysis?.result() ?? undefined, full);
}

async function main() {
    let args;
    try {
        args = JSON.parse(process.argv[2] ?? "");
    } catch {
        failWith("bad_args");
    }
    const { runtime, sessionId, rootAgentRef, label, analyze, full } = args ?? {};
    // rootAgentRef omitted/null → whole-session scope, where label may also
    // be omitted; an explicitly passed empty value stays a caller bug.
    const sessionScope = rootAgentRef == null;
    if (
        !["codex", "claude"].includes(runtime) ||
        !isNonEmptyString(sessionId) ||
        (!sessionScope && !isNonEmptyString(rootAgentRef)) ||
        !(isNonEmptyString(label) || (sessionScope && label == null)) ||
        !(analyze === undefined || typeof analyze === "boolean") ||
        !(full === undefined || typeof full === "boolean")
    ) {
        failWith("bad_args");
    }
    args.analyze = analyze === true;
    args.full = full === true;
    args.label = isNonEmptyString(label) ? label : "Основная сессия";
    launchLabel = args.label.trim();
    if (runtime === "codex") {
        await collectCodex(args);
    } else {
        await collectClaude(args);
    }
}

main().catch((error) => failWith(error?.message === "log_limit_exceeded" ? "log_limit_exceeded" : "collector_error"));
