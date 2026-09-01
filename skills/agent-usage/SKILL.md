---
name: agent-usage
description: Manual-only usage collector for one finished agent launch or the whole current session (working time, exact runtime tokens, cache read/write, steps, and official model-token tariff cost). Invoke only on an explicit request or from a workflow that names this skill; never auto-trigger on ordinary work.
---

# Agent Usage

The bundled collector reads local Codex rollout logs or Claude Code transcripts. It reports one finished launch, or the whole hosting session when `rootAgentRef` is omitted. Hosting workflows and humans call it; roles never do.

The main report is a request ledger built from runtime usage. Context attribution under `analysis` is a separate inference and never changes exact token totals or `token_cost_usd`.

## Run

One shell call, one JSON line on stdout, always exit 0:

```sh
node <plugin_root>/skills/agent-usage/scripts/agent-usage.mjs '<args JSON>'
```

Resolve `<plugin_root>` from this skill file's installed location.

| Field | Meaning |
| --- | --- |
| `runtime` | Required: `"codex"` or `"claude"`. |
| `sessionId` | Required hosting-session UUID. |
| `rootAgentRef` | Codex spawned task path/thread id or Claude Task `agentId`. Omit or pass `null` for the session transcript plus all descendants. |
| `label` | Caller-owned display name. Required for one launch; whole-session default is «Основная сессия». |
| `analyze` | Optional boolean, default `false`. Use `true` only when the request asks for «анализ» or why the context grew. |
| `full` | Optional boolean, default `false`. Adds the machine-readable fields to stdout. Tests and debugging only — workflows paste rendered strings and never pass it. |

Never add a whole-session report to its own per-launch rows: the session already contains all descendants.

## Exact output contract

`ok: true` carries only what callers paste — ready Markdown/HTML strings:

```js
{
  label,
  rendered: {
    block,           // the «Затрачено» table for one launch
    table_header,
    rows,            // one line per launch × model × service tier
    total_row,       // «ИТОГО»; omitted when the table has a single row
    analysis_block?  // analyze: true only
  },
  comment_html
}
```

`full: true` adds the machine-readable fields: `wall_seconds`, `started_at`, `ended_at`, `agents`, `steps`, `models`, `tokens {input, uncached_input, cache_read_input, cache_write_input, cached_input /* deprecated alias of cache_read_input */, output, total}`, `token_cost_usd: number | null`, `cost_usd` (compatibility alias), `cost_breakdown_usd {uncached_input, cache_read_input, cache_write_input, output, total} | null`, `pricing {status: "priced" | "unpriced", basis: "official_api_model_token_rates", catalog_version, checked_at, sources, service_tiers, long_context_steps, issues, excluded}`, `by_launch`, `by_model`, `unpriced_models`, `source`, `analysis?`.

The token invariants always hold:

```text
input = uncached_input + cache_read_input + cache_write_input
total = input + output
cached_input = cache_read_input
```

`by_launch` is keyed by launch × model × service tier; `by_model` aggregates rows for the same model and lists its `service_tiers`. Both carry the same token and nullable cost fields. `steps` counts distinct model requests, not log notifications.

The Markdown and HTML tables use `Без кэша | Из кэша | В кэш | Выход`. Their money column is `$ токены`, because this is model-token tariff cost rather than a subscription invoice.

## Pricing rules

The script contains a versioned, offline catalog with checked-at dates, official source URLs, explicit model ids/snapshot formats, service-tier rules, cache-write rates, and long-context thresholds. It performs no network request while collecting.

Each request is priced before aggregation using integer nano-USD. Serialization is the first point where values become USD. For OpenAI requests above 272,000 input tokens, the configured long-context multipliers apply to that whole request. Cache write is its own input bucket and is never also counted as uncached input.

Codex tier evidence comes from the latest `thread_settings_applied` before the request. `default` means Standard. A configured `fast`/`priority` request is unpriced unless the usage event proves the actual tier, because Fast may downgrade to Standard. `model_rerouted` and `model/rerouted` move the next request to the reported target model.

Pricing is fail-closed. If any request lacks a provable model/tier/tariff, or its usage conflicts, the report-level `token_cost_usd`, `cost_usd`, and `cost_breakdown_usd` are `null`; no partial total is emitted. `pricing.issues` contains machine-readable entries whose `code` is one of `unknown_model`, `missing_service_tier`, `actual_service_tier_unknown`, `tariff_not_found`, `usage_mismatch`, or `invalid_token_breakdown`.

`token_cost_usd` is the exact model-token cost under the catalog's frozen official API tariff. It is not proof of the actual ChatGPT/Codex invoice. Subscription billing and separately priced tool calls are listed in `pricing.excluded` and never included.

## Runtime extraction

Codex treats every non-duplicate `token_count` as one request. It uses `last_token_usage` when that value agrees with the cumulative delta, otherwise preserves the cumulative delta and marks the request `usage_mismatch`. Without `last_token_usage`, a valid cumulative delta is accepted. Repeated cumulative notifications add nothing; a counter decrease starts a new segment. The active model comes from `turn_context`, subject to a later reroute.

Claude deduplicates streaming records by request id, then normalizes `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` into the same contract. Cache writes are priced only when the log distinguishes the applicable 5-minute/1-hour buckets; otherwise tokens remain exact and the request is unpriced with `tariff_not_found`.

`wall_seconds` is working time, not calendar span: the union of exact Codex task intervals or Claude user-to-last-work intervals. Units without markers use a 30-minute idle-gap fallback. Parallel descendants count once at report level; per-model wall sums may exceed it.

## Inferred analysis

When `analyze: true`, paste `rendered.analysis_block` after `rendered.block`. The two sections answer different questions and are never summed. The raw `analysis` object appears only with `full: true`; default output carries the rendered block alone.

`analysis.accuracy` is `"inferred"`. Its `base`, `resent`, tool attribution, compaction/rebuild interpretation, and blended tariff allocation are heuristic. Money inside this section is named `estimated_cost_usd` and rendered as `≈$`. It never participates in `token_cost_usd`. Only `analysis.cache.read/write` are copied from exact normalized runtime counters and must equal the main `tokens.cache_read_input/cache_write_input` totals.

## Failure output

`ok: false` returns `{code, warning_line}`. Possible codes: `bad_args`, `logs_not_found`, `root_not_found`, `ambiguous_root`, `workflow_run_incomplete`, `timestamps_missing`, `log_limit_exceeded`, `collector_error`.

Paste script-owned renderings verbatim. Collection is best-effort: failure never blocks the hosting workflow.
