# Stages — `стейдж`

Loaded on `стейдж [KEY|main] [стоп]`. No roles, no tracker, no Git change: the dispatcher's bootstrap supplies the script path and the `profile` gate (its error stops this mode, §1.4); no §3 resolution, no AI mark, no Follow-up block. A profile without a `stage` block has no stages: the script answers `stage: null` with its `message`. Every call is one `node "<scripts.stage>" '<args JSON>'` with `"repo":"<root>"`; the script finds the tree by the stage name in its `.dreamteam/local.json`, else by the checked-out branch (a subtask key resolves to the parent tree that holds it), and a key checked out in the primary is the stage `main`.

- `стейдж` → `{"op":"list"}`: one line per stage — name, branch, address, запущен/остановлен; name `pruned` ports in one line when non-empty (their tailnet entries belonged to no tree).
- `стейдж <KEY|main>` → `{"op":"ensure","name":"<KEY|main>"}`: a running stage with no pending migrations returns its address without a restart (`restarted: false`); otherwise the stage is prepared. Report `Стейдж: <stage.url>`. `migrations.error: "migration_failed_branch"` is reported as an error with `migrations.error_tail` — the database's text.
- `стейдж <KEY|main> стоп` → `{"op":"stop","name":"<KEY|main>"}`: stops only that stage and drops its tailnet entries; an already stopped stage is a success.

`ok: false` → one error line with its `code`, `detail` and `log` (`worktree_missing` — no tree for that key; nothing is created; `stage_limit_reached` lists `running[]` with addresses and their `стейдж <KEY> стоп` commands). `stage: null` → the script's `message`. End with the §13 whole-session «Затрачено» call like any run without launches.
