# DreamTeam repository rules

- DreamTeam role skills and the public Assignment v1 / Result v1 contracts are the source of truth for professional behavior.
- Keep Dispatcher, tracker, status, branch, and delivery rules in project wrappers.
- DreamTeam roles must remain tracker-neutral and must not perform mutable Git lifecycle operations.
- Any behavior change requires a failing test or failing skill evaluation before implementation.
- Run `npm test`, `git diff --check`, and plugin validation before delivery.
- Never commit secrets, private URLs, task identifiers, raw transcripts, or generated caches.
