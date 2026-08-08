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

The wrapper should verify that DreamTeam is installed before dispatch. If absent, it may install the pinned public repository reference, then stop and require a fresh session. Installation is a dependency check, not a hidden runtime download during a role invocation.

The four roles are sourced from the Plane workflow prompts in the sibling source repository. Their public instructions preserve the role behavior and verification discipline while removing Plane MCP names, project identifiers, status markers, and tracker report schemas. Macro/YouTrack-only roles are deliberately deferred until their contracts can be extracted and tested separately.

## Contract boundary

`contracts/assignment-v1.schema.json` is the wrapper-to-role input contract. `contracts/result-v1.schema.json` is the role-to-wrapper terminal contract. The wrapper remains responsible for validating and translating both contracts, including tracker-specific error handling and publication semantics.
