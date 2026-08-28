---
name: agent-usage
description: Manual-only usage collector for one finished agent launch or the whole current session (time, tokens, steps, cost per model). Invoke only on an explicit request or from a workflow that names this skill; never auto-trigger on ordinary work.
---

# Agent Usage

One bundled script reads local runtime logs (Codex rollouts or Claude Code transcripts) and reports what one finished agent launch cost: wall time, tokens, steps (API model requests), and USD — split per model. Without `rootAgentRef` it reports the whole hosting session instead — «Основная сессия»: everything the current chat spent, its own usage plus every launch it spawned, split per model the same way. Hosting workflows and humans call it; roles never do.

## Run

One shell call, one JSON line on stdout, always exit 0:

```
node <plugin_root>/skills/agent-usage/scripts/agent-usage.mjs '<args JSON>'
```

`<plugin_root>` is the installed plugin directory containing `skills/` — resolve it from the location of this skill file.

Args:

| Field | Meaning |
| --- | --- |
| `runtime` | required. `"codex"` or `"claude"` — which runtime's logs to read |
| `sessionId` | required. The hosting session id: Codex — the session UUID; Claude Code — the session UUID from the session-scoped scratchpad path |
| `rootAgentRef` | the launch identity the runtime returned: Codex — the spawned task path, or the `agent_id` from a `multi_agent_v1` launcher; Claude Code — the Task `agentId`. Omit (or pass `null`) for whole-session scope: the session's own log plus every launch it spawned |
| `label` | caller-owned display name of the launch (role or stage name); embedded verbatim in every rendered string. Required with `rootAgentRef`; in whole-session scope optional, defaulting to «Основная сессия» |
| `analyze` | optional boolean, default `false`. `true` adds the context-attribution pass — pass it when the request carries the keyword **«анализ»** (see below). Adds fields only; every existing field and rendered string is unchanged |

## Keyword «анализ»

When the invoking request contains «анализ» (or explicitly asks why the launch cost what it did), pass `analyze: true` and paste `rendered.analysis_block` **after** `rendered.block` as a separate section. Without the keyword, omit `analyze` — the report stays the cost table alone.

The two blocks answer different questions and are never merged: `rendered.block` is «сколько потрачено», `rendered.analysis_block` is «почему столько». Never sum figures across them — `Влил`/`Пересылок` decompose the same tokens the cost table already counts.

## Output contract

`ok: true` → `label`, `wall_seconds` (working time: the union of exact turn intervals — Codex `task_started`→`task_complete`, Claude a real user message to the last record before the next one — so pauses between turns never count and parallel subagents count once; units without markers fall back to a 30-minute idle-gap heuristic; `ended_at - started_at` still spans the calendar), `started_at`, `ended_at`, `agents`, `steps`, `models`, `tokens {input, cached_input, output, total}`, `cost_usd`, `unpriced_models`, `by_launch` (the same figures per launch × model so subagents stay visible: the root unit under the report label, each spawned unit under its own name — Codex: the `agent_path` last segment via the script's `ROLE_LABELS` map (known roles get the dispatcher's Russian stage names, the rest humanize), Claude: the parent's Task/Agent `input.description`), `by_model` (per-model aggregate `wall_seconds`/`steps`/`tokens`/`cost_usd`, `cost_usd: null` when the model has no price entry), `source`, and two ready-to-paste renderings:

- `rendered.block` — standalone Russian «Затрачено» Markdown table for one launch, closed by the `rendered.total_row` «ИТОГО» line (launch-level wall time plus summed tokens/steps/cost; per-model wall sums may exceed its time); `rendered.rows` (one line per `by_launch` entry — launch × model) over `rendered.table_header` assemble a multi-launch table — keep per-launch total_rows out of it. Each row reads as one statement: this launch's model worked this long, spent these tokens over these steps, and it cost this much.
- `comment_html` — the same breakdown as one HTML fragment for trackers that take HTML comments.

Callers paste these strings verbatim and never re-format numbers, labels, or table markup.

`ok: false` → `{code, warning_line}`; `warning_line` is the one chat line to show. Codes: `bad_args`, `logs_not_found`, `root_not_found`, `ambiguous_root`, `workflow_run_incomplete`, `timestamps_missing`, `log_limit_exceeded`, `collector_error`. Collection is best-effort: a failure never blocks the hosting workflow.

## Semantics

- Whole-session scope (no `rootAgentRef`): Claude Code — the session transcript plus every `*.jsonl` directly under `<sessionId>/subagents/`, linked or not; Codex — the session's own rollout plus its descendant thread tree. A missing session log is `logs_not_found` (never `root_not_found`). The session already contains every launch — never sum its rows with per-launch rows in one table.
- `steps` counts API model requests (the optimization target is fewer steps per task): Codex — `token_count` events; Claude Code — distinct requests carrying usage.
- `tokens.input` is the full model input; `tokens.cached_input` is its cache-read subset, so `total = input + output`.
- Per-model attribution: Claude Code — exact per request; Codex — the delta between consecutive cumulative `token_count` events goes to the model active at that event, so a thread that switches models splits correctly. Per-model `wall_seconds` is the model's own activity (records while it was active per thread, or its own assistant records per agent file; 30-minute idle gaps split segments) clipped to its unit's turn intervals, summed across threads/files — parallel agents can make it exceed the launch-level `wall_seconds`.
- `analysis` (only with `analyze: true`) explains the totals rather than adding to them. Every model request contributes its context size (Claude — `input + cache_creation + cache_read`; Codex — `last_token_usage.input_tokens`), and the tool results that arrived during one step share that step's **measured** context growth minus the step's own output. A step holding one tool result is exact; several split it by JSON size, and `coverage.share` reports how much of the growth was placed at all. Each chunk then carries `resent` = `injected` × how many later steps still re-sent it; a context collapsing below 70% of the previous step is a compaction, after which earlier chunks stop being charged (`resets` counts them).
- `analysis.base` is the unit's opening context — system prompt, tool schemas, skill text — attributable to no tool and re-sent by every later step. On multi-agent launches it sums per unit, because each subagent starts a context of its own. It is routinely the largest single line, and it is cut by disconnecting unused MCP servers and shortening skills, not by the agent working differently.
- `analysis.by_tool` / `by_detail` rank the causes (MCP server, skill, file, command word, host); `repeats` lists only content-bearing sources (Read, WebFetch, MCP) hit more than once, where a second call re-injects the same bytes.
- Everything is priced with rates blended across the models the launch actually used: re-sent context bills as a cache read, a chunk's first appearance as a cache write. That yields `per_step` (cost and context gained per model request, plus the priciest launch per step), `base.per_unit` (the cold-start cost each unit pays before doing anything), and `cache.rebuilt` — writes beyond the context actually gained, i.e. content that had to be cached twice. `cost_usd` in the main table stays the authority on what the launch cost; these figures decompose it and are never added to it.
- `analysis.verdict` splits the result into `largest` (where the money went — overhead is not automatically waste) and `waste` (redundant re-reads, failed calls, cache rebuilt for nothing), each item carrying the figure it rests on and one concrete action. `rendered.analysis_block` renders the tables followed by that verdict **in prose**: «Куда ушло больше всего», «Потрачено впустую», «На будущее». Paste it verbatim — the numbers and the advice are both script-owned, so never rewrite, re-rank, or extend them with your own estimates.
- Pricing lives in the script's `PRICING` table (USD per 1M tokens, with the check date in the comment). Models without an entry keep their tokens counted and appear in `unpriced_models` / as `без тарифа`.
