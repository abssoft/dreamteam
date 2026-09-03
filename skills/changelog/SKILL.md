---
name: changelog
description: Show what changed in the installed dream-team plugin — prints the newest CHANGELOG.md entries (default 10). Invoke only on an explicit request (what's new, что нового, changelog); never auto-trigger on ordinary work.
---

# Changelog

One shell call prints the newest entries of the plugin's bundled `CHANGELOG.md`, newest first:

```
node <plugin_root>/skills/changelog/scripts/changelog.mjs
```

Resolve `<plugin_root>` from this skill file's installed location. `--last=N` changes the count (default 10).

Paste the output verbatim: the top entry is the installed version. A trailing `(ещё N в CHANGELOG.md)` line means the file holds more — rerun with a larger `--last` when asked.

Read-only: one file, no git, no network.
