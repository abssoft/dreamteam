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

## Output contract

`ok: true` → `label`, `wall_seconds` (full launch span), `started_at`, `ended_at`, `agents`, `steps`, `models`, `tokens {input, cached_input, output, total}`, `cost_usd`, `unpriced_models`, `by_model` (per-model `wall_seconds`/`steps`/`tokens`/`cost_usd`, `cost_usd: null` when the model has no price entry), `source`, and two ready-to-paste renderings:

- `rendered.block` — standalone Russian «Затрачено» Markdown table for one launch, closed by the `rendered.total_row` «ИТОГО» line (launch-level wall time plus summed tokens/steps/cost; per-model wall sums may exceed its time); `rendered.rows` (one line per model) over `rendered.table_header` assemble a multi-launch table — keep per-launch total_rows out of it. Each row reads as one statement: this model worked this long, spent these tokens over these steps, and it cost this much.
- `comment_html` — the same breakdown as one HTML fragment for trackers that take HTML comments.

Callers paste these strings verbatim and never re-format numbers, labels, or table markup.

`ok: false` → `{code, warning_line}`; `warning_line` is the one chat line to show. Codes: `bad_args`, `logs_not_found`, `root_not_found`, `ambiguous_root`, `workflow_run_incomplete`, `timestamps_missing`, `log_limit_exceeded`, `collector_error`. Collection is best-effort: a failure never blocks the hosting workflow.

## Semantics

- Whole-session scope (no `rootAgentRef`): Claude Code — the session transcript plus every `*.jsonl` directly under `<sessionId>/subagents/`, linked or not; Codex — the session's own rollout plus its descendant thread tree. A missing session log is `logs_not_found` (never `root_not_found`). The session already contains every launch — never sum its rows with per-launch rows in one table.
- `steps` counts API model requests (the optimization target is fewer steps per task): Codex — `token_count` events; Claude Code — distinct requests carrying usage.
- `tokens.input` is the full model input; `tokens.cached_input` is its cache-read subset, so `total = input + output`.
- Per-model attribution: Claude Code — exact per request; Codex — the delta between consecutive cumulative `token_count` events goes to the model active at that event, so a thread that switches models splits correctly. Per-model `wall_seconds` is the model's own working span (records while it was active per thread, or its own assistant records per agent file), summed across threads/files — parallel agents can make it exceed the launch-level `wall_seconds`.
- Pricing lives in the script's `PRICING` table (USD per 1M tokens, with the check date in the comment). Models without an entry keep their tokens counted and appear in `unpriced_models` / as `без тарифа`.
