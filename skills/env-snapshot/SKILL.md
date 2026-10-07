---
name: env-snapshot
description: One-call workspace environment baseline for a DreamTeam role — placement, git state against the base, runtime, manifests, dependency state, rule documents. Invoke only from a role skill or a workflow that names this skill, or on an explicit request; never auto-trigger on ordinary work.
---

# Environment Snapshot

One bundled script collects the whole workspace environment in a single shell call: the same facts roles otherwise gather through many separate discovery calls at the start of a run and re-derive again near the end. The workspace is the tree the wrapper prepared for the task — a linked worktree or the primary checkout. Run it first; treat its output as the environment baseline for the entire assignment.

## Run first

From the assignment workspace (the process cwd), one shell call:

```
node <plugin_root>/skills/env-snapshot/scripts/env-snapshot.mjs
```

`<plugin_root>` is the installed plugin directory containing `skills/`; resolve it from the location of the role skill file you already loaded — this skill sits next to the role skills.

Options:

| Flag | Effect |
| --- | --- |
| `--json` | machine-readable JSON instead of Markdown; the only form that carries `validation` |
| `--base=<ref>` | comparison base of the change, tried as given and as `origin/<ref>` — pass the base the assignment names; a subtask is based on its parent branch |
| `--skip=rules` | list rule documents with sizes but omit their contents — use when the hosting runtime already injected the instruction chain of this same workspace; a chain injected from the primary checkout is another branch's |
| `--skip=git,runtime,validation,docs` | drop any other section, comma-separated |
| `--max-bytes=N` | per-document embed cap for rule documents (default 16384) |

## What it returns

| Section | Content |
| --- | --- |
| workspace | git toplevel, placement (linked worktree with the path of its primary checkout, or the primary checkout), HEAD, current ref, the base with changed paths and commits on top of it, short status, recent commits, uncommitted diffstat, names of local env files (contents never read) |
| runtime | versions of node plus the package tooling the project actually uses (pnpm/npm/yarn, php/composer), version-manager files |
| project | detected kinds (node, php, mixed), manifest names, engines, full script lists, lockfiles, Makefile targets, dependency directories (`node_modules`, `vendor`): present, a symlink with its target, or absent |
| validation | JSON only, read by the QA role's `qa-run.mjs`: per-tool checks derived from the binaries the project scripts actually run — how each one narrows to the paths a change touched, or why it cannot — plus the whole-project suite as the fallback |
| docs index | tracked documentation file list for routing later reads |
| rules | bounded embeds of repository instruction documents, following their `@` imports; `README.md` is listed with its size, never embedded |

## After the snapshot

- Do not re-collect anything the snapshot already reports; cite it instead.
- Batch the remaining startup context — language-server or index status probes, task-specific file reads — into the next single call.
- The gate is the QA role's: the developer runs only the tests of the behavior it changed, through the executor the repository rules declare; the reviewer runs nothing.
- Without `--base` the base is the remote default branch (`origin/HEAD`, then `origin/main|master|develop`), a local branch name only when no remote ref exists: the local base is shared by every tree and lags its remote. When the assignment names a base, pass it.
- An absent dependency directory is a fact to report: the wrapper's setup owns installs and links, a role adds none.

## Boundaries

Read-only: never mutates git state, files, or configuration. Never prints env-file values — names only. A missing tool or manifest is reported as absent, not treated as an error; a PHP-only host without node package tooling is a normal outcome.
