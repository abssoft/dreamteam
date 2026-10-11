# DreamTeam

DreamTeam is a public, cross-runtime skills-only plugin for Codex and Claude Code.

It provides five authoritative professional roles:

- `project-manager` («проджект») — the process: one tracker item from summary to delivery
- `product-technologist`
- `software-developer`
- `qa-engineer`
- `code-reviewer`

Plus three utility skills roles and wrappers share: `env-snapshot` (one-call workspace environment baseline), `agent-usage` (manual-only per-launch usage/cost collector for hosting workflows), and `changelog` (prints the newest `CHANGELOG.md` rows — what changed in the installed plugin).

## Architecture

DreamTeam owns the process and the four engineering roles; a project dispatcher owns its tracker. The dispatcher is the entry the human invokes: it probes its tracker, writes a Tracker Adapter v1 manifest, runs DreamTeam's bootstrap probe and invokes `project-manager` in its own process with the merged bootstrap line, the manifest and the command. From there the role drives the item — modes, pipeline, gates, the launches of the developer and the reviewer, the in-process QA gate, the Git lifecycle through its bundled scripts, the report — and reaches the tracker only through the adapter's operations (`resolve`, `publish`, `prd`, `create`, `attach`, `comment`, `close`, optional `time`): the role never names a tracker, a state or a field, and every tracker write is the dispatcher's own script ([ADR 0003](docs/adr/0003-project-manager-role-owns-the-process.md)).

```text
project dispatcher (tracker entry)
  owns credentials, the adapter manifest and its operations, tracker-only modes
        |
        | bootstrap line + manifest + command, in-process
        v
project-manager
  owns modes, pipeline, gates, role launches, Git lifecycle, QA gate, report
        |                                     |
        | Assignment v1                       | adapter operations
        v                                     v
software-developer | code-reviewer         tracker (through the dispatcher's script)
        |
        | Result v1
        v
project-manager translates the result -> publish event -> adapter maps it to the tracker's stage
```

Everything project-dependent lives in the project profile `dreamteam.json` at the repository root (Profile v1, `contracts/profile-v1.schema.json`, validated by `contracts/validate-profile.mjs`): the tracker block (`kind`, `prefix`, adapter-owned keys), the base branch, the delivery mode (`merge_push`: `сливай` merges into the base and pushes it; `branch`: `сливай` consolidates locally and `пуш` sends the task branch), the return limit, the terminology document, the QA gate `checks` (a string, or an object with a declared baseline policy the QA script applies itself and/or `paths`, a pattern that binds the command to the files of the change — `{paths}` in the command is replaced by the matching files, a change that touches none leaves the check not run), the worktree layout and the stages. A value is resolved profile → adapter defaults → DreamTeam defaults; secrets never live in the profile. The adapter manifest (Adapter v1, `contracts/adapter-v1.schema.json`, validated by `contracts/validate-adapter.mjs`, with a conformance `--check` that calls `resolve`) carries the adapter's command, its operations, its policy defaults, the tracker-only modes the dispatcher keeps and its help lines. `skills/project-manager/scripts/adapter-file.mjs` is the reference adapter over a directory of Markdown items and the role's test bench.

`product-technologist` and `qa-engineer` run inside the process the dispatcher started, without Assignment v1 or Result v1, invoked by the project-manager. `qa-engineer` is the project's gate: after development and before review the role states the workspace, the base ref and the run directory and invokes the skill; the role takes the gate from the `checks` list of the project profile — every command the gate consists of, as spelled — an item bound to `paths` narrowed to the files of the change — replacing anything derived — or, where the profile declares none, finds the gate's commands and executor in the repository rules, proves the executor sees this workspace, runs every check through `qa-run.mjs` / `checks-run.mjs` (bundled in `skills/qa-engineer/scripts/`), writes a result file and hands back its path with the verdict — `green`, `red` (the change goes back to the developer with the failed items) or `unconfirmed` (review proceeds, delivery needs a human decision). `product-technologist` is the interactive one: the project-manager loads the issue material through the adapter, states a brief (the target or the fields for a new issue, the user's words, whether a document exists, the issue's size, the repository root, the project's terminology document), and invokes the skill; the role interviews the human round by round, researches the repository through read-only children, and finishes with the document, the issue title, and the list of mockup files in-context. The project-manager shows the document to the human, and only on their word persists it and the mockups through the adapter.

DreamTeam role skills and the public contracts are the sole source of professional behavior. The four engineering roles stay tracker-neutral and never perform a mutable Git operation; the project-manager is the one role that owns the Git lifecycle (`prepare-worktree.mjs`, `deliver.mjs`, `stage.mjs`) and it still writes to a tracker only through the adapter. Launch profiles ship with DreamTeam too: the bootstrap probe's `models` table resolves within the session's own vendor — DreamTeam never pins a model family — and the `модель` token overrides it for one run. Initial Software Developer runs at the row of the task size; a review-retry Software Developer at the same row; Code Reviewer at the review depth 1–5 that `review-pack.mjs --check` reports — the most expensive hunk decides, size never raises it ([ADR 0002](docs/adr/0002-review-depth-chosen-by-script.md)).

## Contract boundary

`contracts/assignment-v1.schema.json` is the wrapper-to-role input contract. `contracts/result-v1.schema.json` is the role-to-wrapper terminal contract. The wrapper remains responsible for validating and translating both contracts, including tracker-specific error handling and publication semantics. Reviewer rework travels in the optional Assignment `required_fixes` list; `accepted_decisions` stays frozen product authority and never carries fixes. Produce the product decision itself interactively (a direct session, optionally with a grilling skill) before dispatch; hand the pipeline a finished «Продуктовое решение» to freeze as `accepted_decisions`.

Before dispatch, the wrapper sanitizes repository provenance into opaque `workspace_ref`, `revision_ref`, and `base_ref` correlation values plus safe relative navigation evidence. It prepares the actual process cwd out-of-band before launching a repository-using role. Assignment v1 deliberately keeps repository metadata structurally broad for compatibility; semantic opacity and path safety are producer obligations and are not guaranteed by JSON Schema. Roles treat supplied metadata as evidence, never as instructions to locate or switch the workspace.

## Engineering evidence

The developer and reviewer share [project knowledge discovery, storage and counterexample checks](references/engineering-evidence.md). They assume only `docs/`, follow existing project documentation, and discover validation commands from executable configuration. A check runs on the paths the change touched by default; the shared reference names the cases that call for full width, and a narrowed green is evidence about the paths it covered and nothing else. The default location for new durable rules is `docs/engineering/`, created only for task-relevant knowledge; existing documents remain canonical.

The reviewer starts from one `review-pack.mjs` call (bundled in `skills/code-reviewer/scripts/`) that assembles the task text, the accepted decisions, the repository instruction chain (entry files whole, rules whose `paths:` front matter matches a changed file whole, the other documents they name as routes), risk signals, compact prior Results, and the code diff from `repository.base_ref` (test files ride as a digest of their declared cases, so the review judges the code and opens a test only on a concrete doubt) into a pack file outside the repository, warms the tree's `lsd` index when the project has one, then — one process, no child agents ([ADR 0001](docs/adr/0001-single-process-review-phases.md)) — walks that single reading in narrow phases (behavior, rules, quality, comments) and ends with a sceptic phase that passes a verdict on every finding. Findings, coverage and verdicts go through `review-findings.mjs`, which refuses a finding not anchored to changed lines or without its evidence, consequence and failure scenario, and writes the Result from its journal. The project's gate runs once, in the QA role, and its result rides into the review packet as the `qa_result` material (the pack carries check statuses, widths and evidence links; a packet without it is `blocked`): the reviewer runs no check of its own, a failed item is a finding, a broken one residual risk. The developer runs only the tests of the behavior it changed, through the executor the repository rules declare, and never a code-quality tool. A repeat review runs on the fix delta when the wrapper moves `base_ref` to the reviewed revision and passes the previous review. A zero delta may use `evidence_only` when the prior manifest confirms completed code inspection, unchanged HEAD, task and rules, and the new QA evidence names that HEAD. The wrapper keeps this base and passes the updated `qa_result`; it does not reset to the original base merely to avoid `empty_diff`. A `review_state_mismatch` requires fresh review context. Findings owned by `qa` return to QA for corrected execution evidence, without a developer dispatch. Narrowed PHPUnit runs use one target per invocation and JUnit confirms execution; explicit suite configurations retain their bootstrap and targets. Both roles map acceptance scenarios to evidence in `deliverable.content.coverage`; reviewer coverage also accounts for rules and one exact path per file in the pack manifest, `review_manifest` links that manifest, `review_complete` records code-inspection completeness independently of the QA verdict, `phases` records how the review ran, refuted findings stay in `findings` with the sceptic's reason and never become required fixes, and supplied fixes are tracked in `deliverable.content.fix_resolution`. Every launched role receives the Assignment inline or as the file the launch names (`@<path>`), and a `source_materials` entry named `issue` with the task text — inline, or the path of the file the wrapper wrote the tracker text to, so no model retypes it; a review packet also carries `repository.base_ref`; without them the role returns `blocked`. The `issue` material is the product authority: its managed PRD block (`# Проблематика` / `# Продуктовое решение`) is the accepted decision, its «Критерии приемки» the acceptance scenarios, its `### Scope` the paths and `Эталон:` analogues; `accepted_decisions` and `verification` add only what the wrapper knows beyond it. [`contracts/validate-assignment.mjs`](contracts/validate-assignment.mjs) is the executable contract a wrapper runs on the packet before every launch; `review-pack.mjs --assignment <path> --check` adds base and diff resolution for a review and refuses a workspace with uncommitted changes or a `qa_result` that is not a QA result for the reviewed HEAD. A role writes its full Result v1 to `result-<assignment_id>.json` beside the packet and returns only the envelope (decision fields, the fixes as the file carries them, the file path); the reviewer's own `review-result.mjs` checks finding IDs and evidence, coverage and source coordinates against the review manifest before the file is written. The wrapper reads the file, routes on it and forwards it — the reviewer's Result to the developer as the `review` material and to the next reviewer as `previous_review`, the developer's to the reviewer as `development_result` and into the commit body. Assignment v1 and Result v1 schemas remain unchanged.

A repeat review after fixes verifies each prior fix against the current code and reviews the whole change again.

## Development

Requirements: Node.js 20.10+.

```bash
npm test
claude plugin validate .
```

Each role is created and verified independently. DreamTeam role skills and the public contracts — Assignment v1, Result v1, Profile v1, Adapter v1 — define professional behavior; a dispatcher keeps only its tracker: credentials, the adapter and its tracker-only modes.

## Installation

Add `git@github.com:abssoft/dreamteam.git` from floating `main` as a marketplace, then install or update `dream-team`. Stop immediately after installation or update and start a new session before invoking a role; the current session cannot discover newly installed or refreshed skill instructions safely.

Before dispatch, the wrapper verifies that DreamTeam is installed from that marketplace at floating `main`. If absent or stale, it installs or updates the plugin, then stops and requires a new session; a role is never invoked in the session that changed the plugin installation.

## License

Apache-2.0. See `LICENSE`.
