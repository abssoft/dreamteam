# Read-only Summary — bare key

Loaded when the invocation contains a key and no mode token and no free text. This route is terminal and read-only: no roles gate stop, no AI mark, no stage change, no Git/worktree access, no role launch, no tracker mutation.

1. Resolve the invoked item itself with one `resolve` call using `"self": true` and `"parent": true` (no `mark`). A parent key remains the summary target even when it has unfinished children; a child key remains that explicit child and includes its parent plus the full sibling summary.
2. Render one terse Russian report from that answer and its files alone (`files.issue`, `files.parent_issue`, `files.comments`) — never from memory: linked key and title, kind and stage with the tracker's own `status` text; parent identity and `N из M` for a child; every direct child from `children.list` with its stage and finished/unfinished; the document — `document.managed` with its present `subsections`, or `document.legacy` → «документ в старом формате», which counts as no PRD; the latest marker; visible blocker evidence in the comments. Missing DreamTeam roles are one warning line, never a stop.
3. End with exactly one recommended command:
   - marker `review_done` with a nonterminal stage → `<KEY> Ревью`;
   - marker `development_done` or stage `review` → `<KEY> Ревью`;
   - a parent whose direct children are all finished, in a nonterminal stage, without marker `review_done` → `<PARENT> Ревью`;
   - unfinished children on a parent → `<NEXT_CHILD> разработка` or `<PARENT> подряд` (choose one, never both);
   - no PRD (`document.managed` false, a legacy document included) → `<KEY> PRD`, or `<KEY> разработка просто` only when the visible item text is unambiguously trivial and passes the easy hard-suppression test;
   - a PRD with «Рекомендация по разбивке» on a parent/ordinary item without children → `<KEY> разбей`;
   - a PRD exists and Development has not started → `<KEY> разработка`;
   - accepted Review or stage `done` and undelivered → `<KEY> сливай` under `merge_push`, `<KEY> пуш` under `branch` (it names `сливай` instead when uncommitted changes remain); fully delivered → «не требуется»;
   - stage `cancelled` → `не требуется`.
4. Stop. Do not emit the Development Follow-up block.
