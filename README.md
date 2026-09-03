# DreamTeam

DreamTeam is a public, cross-runtime skills-only plugin for Codex and Claude Code.

It provides three authoritative professional roles:

- `product-technologist`
- `software-developer`
- `code-reviewer`

Plus two utility skills roles and wrappers share: `env-snapshot` (one-call workspace environment baseline) and `agent-usage` (manual-only per-launch usage/cost collector for hosting workflows).

## Architecture

DreamTeam is intentionally skills-only: no tracker MCP, no project selector, no Dispatcher, and no Git delivery authority.

```text
project wrapper
  owns tracker adapter + Dispatcher + project stages + Git/worktree + reports
        |
        | Assignment v1
        v
DreamTeam role
  product-technologist | software-developer | code-reviewer
        |
        | Result v1
        v
project wrapper translates result -> tracker-specific publication/state transition
```

`product-technologist` is the interactive exception: it runs inside the wrapper's process, without Assignment v1 or Result v1. The wrapper loads the issue material, states a brief (the target or the fields for a new issue, the user's words, whether a document exists, the repository root), and invokes the skill; the role interviews the human round by round, researches the repository through read-only children, and finishes with the document and the issue title in-context. The wrapper persists both and moves the state.

DreamTeam role skills and the public Assignment v1 / Result v1 contracts are the sole source of professional behavior. Project wrappers supply assignments and translate results, but do not supply source prompts or redefine role judgment. Tracker adapters, project identifiers, statuses, publication schemas, and Git delivery policy remain wrapper-owned. DreamTeam roles receive a bounded assignment and return a neutral Result v1; they do not write tracker artifacts or perform mutable Git lifecycle operations.

The wrapper also owns launch profiles. Every role runs on the wrapper/Dispatcher's current model; DreamTeam never pins a model family. Product Technologist runs inside the wrapper's own process on the session model, and its research children use the wrapper's research profile. The wrapper varies only reasoning for the launched roles: initial Software Developer uses `xhigh`; review-retry Software Developer uses `max`; Code Reviewer uses `max` on ordinary changes and drops to `high` on trivial or subtask routes per wrapper policy.

## Contract boundary

`contracts/assignment-v1.schema.json` is the wrapper-to-role input contract. `contracts/result-v1.schema.json` is the role-to-wrapper terminal contract. The wrapper remains responsible for validating and translating both contracts, including tracker-specific error handling and publication semantics. Reviewer rework travels in the optional Assignment `required_fixes` list; `accepted_decisions` stays frozen product authority and never carries fixes. Produce the product decision itself interactively (a direct session, optionally with a grilling skill) before dispatch; hand the pipeline a finished «Продуктовое решение» to freeze as `accepted_decisions`.

Before dispatch, the wrapper sanitizes repository provenance into opaque `workspace_ref`, `revision_ref`, and `base_ref` correlation values plus safe relative navigation evidence. It prepares the actual process cwd out-of-band before launching a repository-using role. Assignment v1 deliberately keeps repository metadata structurally broad for compatibility; semantic opacity and path safety are producer obligations and are not guaranteed by JSON Schema. Roles treat supplied metadata as evidence, never as instructions to locate or switch the workspace.

## Development

Requirements: Node.js 20.10+.

```bash
npm test
claude plugin validate .
```

Each role is created and verified independently. DreamTeam role skills and the public Assignment v1 / Result v1 contracts define professional behavior; project-specific tracker and Dispatcher rules stay in wrappers.

## Installation

Add `git@github.com:abssoft/dreamteam.git` from floating `main` as a marketplace, then install or update `dream-team`. Stop immediately after installation or update and start a new session before invoking a role; the current session cannot discover newly installed or refreshed skill instructions safely.

Before dispatch, the wrapper verifies that DreamTeam is installed from that marketplace at floating `main`. If absent or stale, it installs or updates the plugin, then stops and requires a new session; a role is never invoked in the session that changed the plugin installation.

## License

Apache-2.0. See `LICENSE`.
