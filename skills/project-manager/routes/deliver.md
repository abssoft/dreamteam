# Delivery — `сливай`, `пуш` and Recovery

Continuation of `project-manager` §11, read on an explicit `сливай` or `пуш`, or from the explicit `Ревью` entry when `route_hint: "completion_recovery"`. The bare-key summary only recommends these commands and never loads delivery. §11 rails hold in full: never an MR/PR; every Git sequence through `deliver.mjs`, one call per attempt, `base` passed on every commit, subtask and push call. Which procedure runs is `policy.delivery`.

## `merge_push`

`сливай` only after accepted terminal Review, confirmed marker `review_done`, and the `done` stage. `сливай` is itself the human decision to deliver — no extra review gate exists here. `пуш` does not exist under this policy: one short line names `сливай` and the run stops.

1. Re-read comments once (a fresh `resolve`); run required delivery verification; commit scoped changes via deliver `mode: "commit"` on `<KEY>` when needed, message per `routes/develop.md` rules (subject `<KEY> <exact item title>`, body `## Что сделано` / `## Почему` from the accepted Development Result). A delivery-only session without that Result in context commits with the subject alone (state it in one short chat line). Stage only files that belong to this item's run.
2. The merge runs in the checkout holding the base — `branches.<base>.checked_out_at` from a fresh read-only prepare-worktree (no `ensure`); Git refuses a second checkout of the same branch. When no checkout holds the base — an in-place run (`placement: primary`) leaves the primary on `<KEY>` — pass the checkout holding `<KEY>` (`branches.<KEY>.checked_out_at`): deliver switches that clean checkout to the base first. Call deliver once: `{"mode":"merge","workspace":"<base checkout path>","key":"<KEY>","base":"<policy.base>"}`. It requires a clean base checkout, synchronizes the base from the remote when one exists (`ls-remote` + exact-refspec fetch; behind → fast-forward only; no remote → local-only), merges `--no-ff <KEY>`, and pushes the base.
3. Map the result: `ok: true` → delivered; report `pushed`. `not_on_base`, `base_checkout_failed`, `dirty_base_checkout`, `base_diverged`, `transport_failure`, `merge_conflict` → blocker, nothing repaired. `push_rejected` → blocker reporting the completed local merge; never force-push. An in-place call has switched the checkout to the base unless the code is `not_on_base`, `base_checkout_failed` or `dirty_base_checkout`: any later blocker leaves it on the base with `<KEY>` untouched — report that Git state.
4. Cleanup (§5.6, §5.8), only after `ok: true` and only with a profile `worktree` block: one call `node "<scripts.stage>" '{"op":"cleanup","repo":"<root>","key":"<KEY>"}'` — it stops the task stage and drops its tailnet entries, runs `stage.cleanup` then the machine `cleanup`, removes the task tree when it is task-owned, clean and its stage confirmed stopped, then in the primary runs `worktree.setup` and brings the main stage up on the base. An in-place run removes nothing and restarts only the main stage. Report `tree.removed` or `tree.reason`, every `warnings[]` entry as one line with its code and log path, and `Стейдж: <main.url>` when `main.running`; none of them changes the delivery outcome. Never delete `<KEY>`.

## `branch`

Both commands start with one §3 `resolve` (the title for the commit subject, the parent key for a subtask) and one read-only prepare-worktree snapshot (`ensure` omitted; the workspace is the checkout holding `<KEY>`, for a subtask the checkout holding `<KEY>` or the parent branch). Nothing leaves the machine on `сливай`; `пуш` sends what `сливай` produced.

**`сливай`**

1. Ordinary/parent item: `{"mode":"commit","workspace":"<path>","key":"<KEY>","base":"<policy.base>","paths":["."],"message":"<KEY> <exact item title>"}` — `["."]` stages everything uncommitted, tracked and untracked alike, on branch `<KEY>`. A clean workspace returns `committed: false` — report «нечего коммитить», not a blocker. Then stop: the branch is ready for `пуш`.
2. Subtask: `{"mode":"subtask","workspace":"<path>","key":"<SUBTASK_KEY>","parentKey":"<PARENT_KEY>","base":"<policy.base>","paths":["."],"message":"<SUBTASK_KEY> <subtask title>"}` — commit on the subtask branch, checkout the parent branch, `--no-ff` merge; idempotent via `already_merged`. Worktree and subtask branch are kept. `merge_conflict` → branches preserved, blocker naming `conflict_files`; never resolve a parent-branch conflict automatically. After `ok: true` (including `already_merged`), `close` the child (§11.3), then stop: the parent branch is ready for `пуш`.
3. A commit body is composed only when the accepted Development Result is in this session's context (`resultPath` + `subject` instead of `paths` + `message`); a delivery-only session commits with the subject alone — state it in one short chat line.

**`пуш`**

1. The branch to push is the one `сливай` leaves behind: `<KEY>` for an ordinary/parent item, `<PARENT_KEY>` for a subtask.
2. `{"mode":"push","workspace":"<checkout holding that branch>","key":"<that branch>","base":"<policy.base>","toplevel":"<primary checkout>","removeWorktree":<true under placement worktree, false under primary>}` — `push -u origin <branch>`, then remove the run-owned worktree; a primary checkout stays as the human left it. The merge request into the base is created by a human.
3. `workspace_dirty` → stop naming `<KEY> сливай` as the command to run first; nothing is committed here.

Map script results fail-closed: any `ok: false` code (`wrong_branch`, `base_forbidden`, `workspace_dirty`, `push_rejected`, `remote_missing`, `merge_conflict`, `nothing_to_merge`, …) → blocker, nothing repaired, never force-push.

## Completion recovery — `route_hint: "completion_recovery"`

Inside an explicit `Ревью`/`сливай` mode, marker `review_done` with unfinished delivery triggers recovery before any role launch. Never relaunch a completed route.

**Subtask:**

1. From §5.1 prepare-worktree data: changes not attributable to the selected subtask block. Run-owned uncommitted changes → pending: require one fresh accepted `code-reviewer` full-suite delivery gate in the current invocation before any deliver call — uncommitted work either postdates the accepted review or predates its commit, and the two are indistinguishable. A stored marker or prior Result never replaces that gate for uncommitted changes; reuse the current invocation's accepted terminal Review if it exists, otherwise launch a fresh Review Assignment v1; fixes follow the normal bounded Development retry cycle. A clean workspace whose subtask branch already carries commits beyond the parent, with marker `review_done`, needs no fresh gate: commits precede the accepted review, so the committed tree is the reviewed tree — proceed to the deliver call.
2. `ancestry.key_in_parent: true` with a clean workspace → already merged: skip Reviewer, call deliver `mode: "subtask"` (it reports `already_merged: true`, switches to `<PARENT_KEY>` and creates nothing), retry only the `close`.
3. After the gate: the same deliver call as §11 automatic delivery — it commits run-owned changes or reuses the reviewed commit and reports `nothing_to_merge` when a clean branch has no commit beyond the parent (→ blocker). A retry reuses existing commit/merge evidence and never duplicates delivery. Then `close` (§11.3): a `pending` field is a stop naming it, the merge stands; `подряд` selects the next child only after `close` answers with nothing pending.

**Ordinary/parent:** with uncommitted run-owned changes, the same fresh Reviewer full-suite gate precedes a deliver `mode: "commit"` call, and `review_done` is published only after that commit succeeds; with a clean workspace and the change already committed, the item's stage is already past review — under `merge_push` the `сливай` token then continues the delivery above, under `branch` the run reports the branch ready for `сливай`/`пуш`.
