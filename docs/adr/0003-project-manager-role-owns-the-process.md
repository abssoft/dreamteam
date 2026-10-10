# The project-manager role owns the process and the Git lifecycle

DreamTeam was skills-only by decision: four tracker-neutral roles behind the Assignment v1 / Result v1 contracts, while each project dispatcher owned the process — modes, pipeline, gates, role launches, the Git lifecycle — and its tracker. Two dispatchers then carried the same process in two copies of prose and four same-named scripts, every change to the process landing three times. The process now lives in one DreamTeam role, `project-manager` («проджект»), which a dispatcher invokes in its own process the way it invokes the product technologist: the role drives the item from summary to delivery, launches the developer and the reviewer, runs the QA role, and owns branches, worktrees, commits, merges and pushes through the scripts that moved with it. The dispatcher keeps its tracker: an entry command, the credentials, and an adapter that satisfies the Tracker Adapter v1 contract — the one seam the role sees a tracker through.

The rule that no DreamTeam role performs a mutable Git operation holds for the four engineering roles and falls for this one: the process cannot deliver without Git, and splitting delivery back into the dispatcher would put the duplicated prose back where it was. Project policy that the dispatchers hardcoded — base branch, delivery mode, return limit, terminology, worktree layout, a check's baseline policy — moved into the project profile, `dreamteam.json`, under the Profile v1 contract: the profile first, the adapter's defaults second, DreamTeam's defaults last.

## Consequences

- A tracker is a manifest plus one script with seven operations; a new tracker costs an adapter, not a process. The file adapter in this repository is the contract's reference and the role's test bench.
- Every process change ships once, in DreamTeam, and every dispatcher picks it up through the floating installation; a dispatcher's own release is tracker work only.
- Commit and merge run `--no-verify` for every project: the project's gate already ran in the QA role, and task-repo hooks need host state a worktree lacks. A project that wants its hooks in delivery declares them in `checks` instead.
- The role is prose; its contracts and scripts are tested, the prose only by live runs. A defect in the process is a DreamTeam release, never a dispatcher patch.
