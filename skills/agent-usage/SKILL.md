---
name: agent-usage
description: Manual-only usage collector for one finished agent launch (time, tokens, steps, cost per model). Invoke only on an explicit request or from a workflow that names this skill; never auto-trigger on ordinary work.
---

# Agent Usage

One bundled script reads local runtime logs (Codex rollouts or Claude Code transcripts) and reports what one finished agent launch cost: wall time, tokens, steps (API model requests), and USD — split per model. Hosting workflows and humans call it; roles never do.

## Run

One shell call, one JSON line on stdout, always exit 0:

```
node <plugin_root>/skills/agent-usage/scripts/agent-usage.mjs '<args JSON>'
```

`<plugin_root>` is the installed plugin directory containing `skills/` — resolve it from the location of this skill file.

Args (all required):

| Field | Meaning |
| --- | --- |
| `runtime` | `"codex"` or `"claude"` — which runtime's logs to read |
| `sessionId` | the hosting session id: Codex — the session UUID; Claude Code — the session UUID from the session-scoped scratchpad path |
| `rootAgentRef` | the launch identity the runtime returned: Codex — the spawned task path; Claude Code — the Task `agentId` |
| `label` | caller-owned display name of the launch (role or stage name); embedded verbatim in every rendered string |

## Output contract

`ok: true` → `label`, `wall_seconds`, `started_at`, `ended_at`, `agents`, `steps`, `models`, `tokens {input, cached_input, output, total}`, `cost_usd`, `unpriced_models`, `by_model` (per-model `steps`/`tokens`/`cost_usd`, `cost_usd: null` when the model has no price entry), `source`, and two ready-to-paste renderings:

- `rendered.block` — standalone Russian «Затрачено» Markdown table for one launch; `rendered.rows` (one line per model) over `rendered.table_header` assemble a multi-launch table. Wall time appears only on a launch's first row.
- `comment_html` — the same breakdown as one HTML fragment for trackers that take HTML comments.

Callers paste these strings verbatim and never re-format numbers, labels, or table markup.

`ok: false` → `{code, warning_line}`; `warning_line` is the one chat line to show. Codes: `bad_args`, `logs_not_found`, `root_not_found`, `ambiguous_root`, `timestamps_missing`, `log_limit_exceeded`, `collector_error`. Collection is best-effort: a failure never blocks the hosting workflow.

## Semantics

- `steps` counts API model requests (the optimization target is fewer steps per task): Codex — `token_count` events; Claude Code — distinct requests carrying usage.
- `tokens.input` is the full model input; `tokens.cached_input` is its cache-read subset, so `total = input + output`.
- Claude Code attribution is exact per request; Codex attribution is per thread (a thread's cumulative totals go to its last `turn_context` model).
- Pricing lives in the script's `PRICING` table (USD per 1M tokens, with the check date in the comment). Models without an entry keep their tokens counted and appear in `unpriced_models` / as `без тарифа`.
