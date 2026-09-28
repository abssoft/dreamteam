# Review depth is chosen by the pack script, not by a model

Which model and effort a review runs at is a review depth from 1 to 5, computed deterministically by the review pack's check from the change itself — the most expensive hunk decides, size never raises it — and the dispatcher maps that level to its runtime's models. We rejected an LLM assessor run before the review (a separate launch whose verdict mostly restates what the numbers already show) and a single fixed tier (it either overpays for documentation-only changes or underpays for migrations).

## Consequences

- DreamTeam owns only the number and its rule; each dispatcher owns the level-to-model table per runtime, so recalibrating spend is a one-row change there and never touches the role.
- The role cannot raise its own depth mid-review; a change the rule under-rates is fixed by changing the rule.
