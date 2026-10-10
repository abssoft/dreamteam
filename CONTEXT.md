# DreamTeam

Tracker-neutral role skills — the project-manager that drives the process, and the product technologist, developer, QA engineer and code reviewer it invokes or launches — behind four public contracts: Assignment v1 / Result v1 for launched roles, Profile v1 for the project profile, Adapter v1 for a dispatcher's tracker adapter.

## Process

**Project-manager** («проджект»):
The DreamTeam role that drives one tracker item through the modes — summary, PRD, development, QA, review, delivery — launching the engineering roles and owning the Git lifecycle; it sees a tracker only through the adapter.
_Avoid_: dispatcher, orchestrator, workflow

**Dispatcher** («диспетчер»):
A project's entry plugin: the command the human invokes, the tracker credentials, the adapter and the tracker-only modes; it invokes the project-manager in its own process and executes the role's tracker writes through its adapter.
_Avoid_: wrapper, workflow plugin

**Tracker adapter**:
The dispatcher's script that satisfies Adapter v1: one command, the operations resolve, publish, prd, create, attach, comment, close and optionally time, declared in a manifest with the adapter's policy defaults.
_Avoid_: tracker client, MCP, connector

**Adapter manifest**:
The JSON file a dispatcher writes into the run directory before invoking the project-manager: the adapter's kind, label, command, operations, policy defaults, tracker-only modes and help lines.
_Avoid_: config, plugin manifest

**Project profile**:
`dreamteam.json` at the repository root: the single home of everything project-dependent — tracker block, base branch, delivery mode, return limit, terminology, QA gate checks, worktree layout, stages; never a secret.
_Avoid_: project config, settings file

**Stage** (of an item):
The abstract position of a tracker item the role reasons about — backlog, prd, dev, review, done, cancelled — mapped by the adapter onto its tracker's states or fields; a `stage` block of the profile is the unrelated site of a checkout.
_Avoid_: status (that is the tracker's own text), state

**Stage event**:
What the project-manager publishes after an accepted step — dev_started, development_done, review_done — and the adapter turns into a comment and a stage move, in that order.
_Avoid_: transition, status move

**Delivery mode**:
The profile's `delivery`: merge_push, where `сливай` merges the task branch into the base and pushes it, or branch, where `сливай` consolidates locally and `пуш` sends the task branch and the base is never touched.
_Avoid_: push policy, merge strategy

**Baseline policy** (of a check):
A profile check's declared rule — files_outside_diff with a diagnostic pattern — by which the QA script settles a failure whose every diagnostic names a file outside the change as passed with attribution baseline.
_Avoid_: ignore list, suppression

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
