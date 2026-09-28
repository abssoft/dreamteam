# DreamTeam

Tracker-neutral role skills (product technologist, developer, QA engineer, code reviewer) that project wrappers dispatch through the Assignment v1 / Result v1 contracts.

## Code review

**Review phase**:
One narrow pass of the single reviewer process over the same pack, with its own mandate and an explicit list of what is not its concern.
_Avoid_: lens, stage, child review

**Review depth**:
The model-and-effort level, 1 (cheapest) to 5 (priciest), that a change's most expensive hunk buys; chosen before the reviewer starts, never by the reviewer itself.
_Avoid_: effort tier, reasoning tier

**Finding anchor**:
The changed lines of the change a finding hangs on; code outside the change that the finding rests on is its related evidence, never its anchor.
_Avoid_: finding location

**Applicable rule**:
A repository rule whose declared paths match a changed file, or one that declares no paths at all.
_Avoid_: relevant rule, selected rule

**Sceptic**:
The final review phase that passes a verdict on every recorded finding and adds none; only code proving the opposite of a finding's claim refutes it.
_Avoid_: verifier, validator

**Refuted finding**:
A recorded finding the sceptic disproved; it stays in the review for audit with its reason and never becomes a required fix.
_Avoid_: dropped finding, false positive
