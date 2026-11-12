# Tidy — `приберись`

Loaded on `приберись [отчёт | KEY …]`. Project-wide: no target of its own, no roles, no AI mark, no journal, no Follow-up block; the tracker is read, never written. A `profile.error` (§1.4) is one warning line here: the report runs on Git facts, and a removal answers with the code. Every script call is one `node "<scripts.tidy>" '<args JSON>'` carrying `"repo":"<root>","base":"<policy.base>"`. The script owns every verdict and every removal: a tree leaves the machine only through its `remove`; task branches and the workflow directories — the items' history — stay.

1. Keys: `{"op":"keys",…}` → `keys`, the task trees whose verdict needs a tracker stage.
2. Stages: one call per key — `<manifest.command> resolve '{"key":"<KEY>","self":true,"dir":"<run_dir>/<KEY>"}'` — keeping `target.stage` and `target.status`. An `ok: false` with a relationship or data code gives that key the stage `unknown`; a connection code ends this step, the unanswered keys stay out of `stages`, and the report names the tracker as unavailable. The step is complete when every key of step 1 carries a stage or the connection failed.
3. One call by the command, with `"sync":true,"stages":{"<KEY>":{"stage":"<stage>","status":"<status>"},…}`, its `rendered` pasted as-is:
   - bare `приберись` → `{"op":"remove",…}`: every tree the verdict `remove` covers goes, and `rendered` names each removed tree and each one that stayed with its reason;
   - `приберись отчёт` (also `отчет`) → `{"op":"scan",…}`: the same verdicts with sizes and stages, nothing changed; it ends with the one next command `приберись` when `totals.items` is above zero, else «убирать нечего»;
   - `приберись KEY …` → `{"op":"remove",…,"keys":[…]}`: the named trees are the human's decision and go under any verdict; the script still keeps a tree with uncommitted changes.

In a session that already holds the stages, steps 1–2 are not repeated. `ok: false` → one error line with its `code` and `detail`. The command that settles a tree the script kept is the human's — `<KEY> сливай` for an accepted item, a commit for uncommitted changes. End with the §13 whole-session «Затрачено» call like any run without launches.
