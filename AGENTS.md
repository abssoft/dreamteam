# DreamTeam repository rules

- DreamTeam role skills and the public Assignment v1 / Result v1 contracts are the source of truth for professional behavior.
- `product-technologist` is interactive: it runs inside the wrapper's process without the Assignment v1 / Result v1 envelope and hands off the document and title in-context; the wrapper persists them.
- Keep Dispatcher, tracker, status, branch, and delivery rules in project wrappers.
- DreamTeam roles must remain tracker-neutral and must not perform mutable Git lifecycle operations.
- Never commit secrets, private URLs, task identifiers, raw transcripts, or generated caches.
- Every version bump adds one row per change at the top of `CHANGELOG.md` in the form the file's header states (verb-first, one phrase); `npm test` fails while the top row lags `package.json`.
