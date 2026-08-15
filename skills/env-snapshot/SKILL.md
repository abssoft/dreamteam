---
name: env-snapshot
description: Use when starting any repository assignment (implementation, review, specification, documentation) before any other exploration call, and whenever startup discovery would otherwise take several separate git, version, manifest, or rules-document reads.
---

# Environment Snapshot

One bundled script collects the whole workspace environment in a single shell call: the same facts roles otherwise gather through many separate discovery calls at the start of a run and re-derive again near the end. Run it first; treat its output as the environment baseline for the entire assignment.

## Run first

From the assignment workspace (the process cwd), one shell call:

```
node <plugin_root>/skills/env-snapshot/scripts/env-snapshot.mjs
```

`<plugin_root>` is the installed plugin directory containing `skills/`; resolve it from the location of the role skill file you already loaded — this skill sits next to the role skills.

Options:

| Flag | Effect |
| --- | --- |
| `--json` | machine-readable JSON instead of Markdown |
| `--skip=rules` | list rule documents with sizes but omit their contents — use when the hosting runtime already injected the repository instruction chain |
| `--skip=git,runtime,tooling,docs` | drop any other section, comma-separated |
| `--max-bytes=N` | per-document embed cap for rule documents (default 16384) |

## What it returns

| Section | Content |
| --- | --- |
| workspace | git toplevel, HEAD, current ref, short status, recent commits, auto-detected base with changed paths and commits on top of it, uncommitted diffstat, worktree list |
| runtime | versions of node plus the package tooling the project actually uses (pnpm/npm/yarn, php/composer), version-manager files |
| project | detected kinds (node, php, mixed), manifest names, engines, full script lists, lockfiles, Makefile targets |
| validation | check commands derived from project scripts (typecheck, lint, tests) to run before handoff |
| tooling | config files present, test-file count, names of local env files (contents never read) |
| docs index | tracked documentation file list for routing later reads |
| rules | bounded embeds of repository instruction documents, following one level of `@` imports |

## After the snapshot

- Do not re-collect anything the snapshot already reports; cite it instead.
- Batch the remaining startup context — language-server or index status probes, task-specific file reads — into the next single call.
- Before handoff, reuse the `validation` section commands; do not re-derive them.
- The auto-detected base is name-based; when the assignment implies a different comparison base, diff against that one.

## Boundaries

Read-only: never mutates git state, files, or configuration. Never prints env-file values — names only. A missing tool or manifest is reported as absent, not treated as an error; a PHP-only host without node package tooling is a normal outcome.
