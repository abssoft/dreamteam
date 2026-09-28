# Code review runs as one process with sequential phases

The code reviewer reads the pack once and walks it in narrow review phases (behavior, rules, quality, comments, then the sceptic) inside that one context, with no child agents and no process per phase. The reference we learned from — a consumer project's CI review — runs every stage as its own process, and its narrow mandates are what we kept; its topology we did not: each extra process pays the whole pack again as fresh input, while a phase in the same context re-reads it from the prompt cache at a tenth of the price (a trivial two-file update cost that pipeline about two dollars over six processes).

## Consequences

- The sceptic shares the context of the phases that wrote the findings, so it is less independent than a separate process. Its only defence is the rule that nothing but code proving the opposite refutes a finding; if live runs show it rubber-stamping, a second launch of the role over the findings file is the fallback, not child agents.
- A change too large for one context is paged through in the same process; findings and per-file coverage live in the findings harness, so they survive context compaction and the review cannot close while a manifest file is uncovered.
