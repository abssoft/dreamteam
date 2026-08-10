# Architecture

DreamTeam is the external professional-team plugin. It is intentionally skills-only: no tracker MCP, no project selector, no Dispatcher, and no Git delivery authority.

```text
project wrapper
  owns tracker adapter + Dispatcher + project stages + Git/worktree + reports
        |
        | Assignment v1
        v
DreamTeam role
  product-technologist | software-developer | code-reviewer | technical-writer
        |
        | Result v1
        v
project wrapper translates result -> tracker-specific publication/state transition
```

Before dispatch, verify that DreamTeam is installed from `git@github.com:abssoft/dreamteam.git` at floating `main`. If absent or stale, install or update it, then stop and require a new session. Do not invoke a role in the session that changed the plugin installation.

DreamTeam role skills and the public Assignment v1 / Result v1 contracts are the sole source of professional behavior. Project wrappers supply assignments and translate results, but do not supply source prompts or redefine role judgment. Tracker adapters, project identifiers, statuses, publication schemas, and Git delivery policy remain wrapper-owned.

## Contract boundary

`contracts/assignment-v1.schema.json` is the wrapper-to-role input contract. `contracts/result-v1.schema.json` is the role-to-wrapper terminal contract. The wrapper remains responsible for validating and translating both contracts, including tracker-specific error handling and publication semantics.
