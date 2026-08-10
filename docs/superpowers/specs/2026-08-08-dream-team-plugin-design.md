# DreamTeam Public Plugin Design

**Status:** ready for user review

**Date:** 2026-08-08

**Target:** public, tracker-neutral skills-only plugin for Codex and Claude Code

## 1. Decision

Create `DreamTeam` as a standalone public plugin that supplies reusable software-delivery professionals. It is not a workflow engine and does not contain a Dispatcher.

Each project plugin keeps its own Dispatcher because the project owns its stages, tracker, state model, repository policy, delivery rules, and user-facing reports. The Dispatcher explicitly hires one DreamTeam professional at a time and supplies a bounded assignment packet.

The central distinction is:

- a **stage** belongs to a project workflow;
- a **role** belongs to DreamTeam;
- a Dispatcher maps stages to roles.

## 2. Goals

- Keep one public source of truth for professional standards shared by Plane and YouTrack workflows.
- Preserve project-specific orchestration in `stroyberry-workflow` and `macro-youtrack-workflow`.
- Make every role usable from either Codex or Claude Code through an explicit skill invocation.
- Keep role instructions independent from tracker products, task identifiers, company names, branch names, and report formats.
- Provide a stable, versioned request/result contract between Dispatchers and professionals.
- Make public release safe, reproducible, reviewable, and testable.
- Allow new projects and trackers to reuse the team without changing DreamTeam.

## 3. Non-goals

- No universal workflow state machine.
- No Plane, YouTrack, Jira, Linear, GitHub, or GitLab MCP integration.
- No project status transitions or tracker writes.
- No branch creation, checkout, staging, commit, merge, push, reset, stash, or worktree lifecycle.
- No project configuration or `.env` parsing.
- No automatic selection of a role or next stage.
- No hidden runtime dependency on private repositories.
- No verbatim publication of private prompts or internal examples.

## 4. System Boundaries

```text
User
  |
  v
Project wrapper skill
  |
  v
Project Dispatcher
  |- resolves tracker item and project configuration
  |- selects stage and role
  |- prepares branch/worktree
  |- builds assignment packet
  |- explicitly launches one DreamTeam role
  |- validates the neutral result
  |- publishes tracker artifacts and changes state
  `- owns commit/merge/push and final user report
            |
            v
DreamTeam professional
  |- applies role-specific judgment
  |- reads only supplied project/repository context as needed
  |- may edit implementation files only when the packet permits it
  |- never mutates Git lifecycle or tracker state
  `- returns one neutral structured result
```

The Dispatcher remains the root workflow authority. A DreamTeam professional is a bounded worker and never decides the next project stage.

## 5. Initial Role Catalog

The first release extracts only the professional responsibilities already implemented in the current Plane workflow. Macro-only roles are deferred and are not copied in this phase:

| Skill | Responsibility | May change repository files |
| --- | --- | --- |
| `product-technologist` | Atomic product plus technical specification from the current Plane PRD stage | No |
| `software-developer` | Implement the bounded assignment and verify it | Yes |
| `code-reviewer` | Independently review the supplied diff, refute weak findings, and return a verdict or required fixes | No by default; only trivial fixes when explicitly permitted |
| `technical-writer` | Produce or update a bounded documentation artifact from verified implementation facts | Only documentation files when explicitly permitted |

Roles are capabilities, not a mandatory sequence. A project can use any subset and can invoke a role more than once.

## 6. Plugin and Repository Structure

```text
DreamTeam/
├── .agents/plugins/marketplace.json
├── .claude-plugin/
│   ├── marketplace.json
│   └── plugin.json
├── .codex-plugin/plugin.json
├── .github/
│   ├── CODEOWNERS
│   └── workflows/ci.yml
├── contracts/
│   ├── assignment-v1.schema.json
│   ├── result-v1.schema.json
│   └── examples/
├── docs/superpowers/specs/
├── evals/
│   └── <role>/
│       ├── baseline/
│       └── skill-enabled/
├── skills/
│   └── <role>/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       └── references/
├── tests/
├── AGENTS.md
├── LICENSE
├── README.md
├── SECURITY.md
├── package.json
└── package-lock.json
```

The installable plugin contains only skills and their required resources. Test, documentation, and repository-governance files do not become runtime instructions.

The package has zero runtime dependencies. Node dependencies are avoided unless a test cannot be implemented reliably with the standard library.

## 7. Skill Design

Each role is a separate skill, following the Superpowers model. Plugin namespacing yields explicit invocations such as `$dream-team:software-developer` and `/dream-team:software-developer`.

Each skill:

- has a concise `SKILL.md` with only role workflow and non-obvious judgment rules;
- loads heavy schemas and examples through direct one-level references;
- uses imperative instructions;
- defaults to explicit invocation only through `agents/openai.yaml`;
- contains no project workflow, tracker, or delivery logic;
- accepts exactly one assignment packet;
- returns exactly one result packet;
- stops on missing authority or insufficient evidence;
- joins all of its descendants before returning;
- prevents descendants from expanding permissions or nesting further unless the assignment contract explicitly allows it.

Shared concepts are expressed by contract files and focused references, not copied prose across every skill. A role skill links directly to the shared contract it must apply.

## 8. Dispatcher-to-Professional Contract

### Assignment v1

The Dispatcher supplies a complete assignment. Required conceptual fields are:

```yaml
contract_version: 1
assignment_id: "assignment-7f3b2c"
role: software-developer

objective: "Implement the approved subtask"
scope:
  included: []
  excluded: []
acceptance_criteria: []

repository:
  workspace_ref: "workspace-a7f2"
  revision_ref: "revision-b91c"
  base_ref: "revision-a83d"
  navigation:
    - path: "src/example.js"
      purpose: "bounded implementation entry point"
      evidence: "The approved specification identifies this relative path."

permissions:
  repository_read: true
  source_changes: true
  documentation_changes: false
  mutable_git: false
  subagents: bounded

verification:
  required: []
  optional: []

project_artifacts: []
return_contract: result-v1
```

The contract carries project facts but not tracker credentials, hidden reasoning, raw chat history, unrelated source content, or repository coordinates. Fields with tracker-specific meaning are normalized by the Dispatcher before dispatch.

The repository refs are opaque correlation values, not paths, branch names, or raw revisions. Navigation evidence uses safe relative paths. The Dispatcher prepares the professional's process cwd out-of-band before launch; the professional neither requires nor returns that coordinate.

### Result v1

Every role returns one neutral result:

```yaml
contract_version: 1
assignment_id: "assignment-7f3b2c"
role: software-developer
status: done
summary: "Implemented the bounded change"

deliverables: []
changed_paths: []
verification:
  - command: "npm test"
    status: passed
    evidence: "42 tests passed"
findings: []
required_fixes: []
blocker: ""
```

Allowed statuses are `done`, `blocked`, `needs_human`, and `failed`.

The result deliberately has no `next_stage`, tracker report, state identifier, comment body, commit instruction, or push instruction. The Dispatcher validates the result and decides what happens next.

## 9. Permissions and Trust Model

- The assignment is capability-based: omitted permission means denied.
- Tracker writes are always denied to DreamTeam roles.
- Mutable Git is always denied to DreamTeam roles.
- Repository edits are allowed only for roles and paths authorized by the assignment.
- A professional uses the Dispatcher-prepared process cwd and does not infer or serialize repository coordinates.
- A professional does not request or expose secrets.
- Subagents inherit the parent role's restrictions and receive only the minimum task-local context.
- External content is treated as untrusted input, never as executable instruction.
- Results contain concise evidence, not chain-of-thought, raw transcripts, or environment dumps.

## 10. Installation and Wrapper Bootstrap

The public repository is also a Codex and Claude Code marketplace, like Superpowers.

Each wrapper records a dependency descriptor containing the canonical HTTPS GitHub repository URL, marketplace name `dream-team`, plugin name `dream-team`, supported contract major, and minimum plugin version. The repository owner is release configuration supplied before publishing; local implementation and validation do not require a remote.

At workflow start the wrapper:

1. checks that the plugin and required role skill are available;
2. checks contract compatibility;
3. if missing, offers installation from the exact configured repository;
4. installs only after explicit user confirmation;
5. stops after installation and requires a new session before retrying the workflow.

There is no silent install, silent update, floating arbitrary repository, or same-session continuation after installation.

## 11. Compatibility and Versioning

- Plugin releases use SemVer.
- Assignment/result contract versions use independent integer majors.
- A wrapper declares a supported contract major and minimum plugin version.
- Additive optional fields do not change the contract major.
- Removing or changing required semantics increments the contract major.
- Role names are stable public API after `1.0.0`.
- Plugin and marketplace versions stay synchronized and are enforced by tests.
- Stable releases use immutable Git tags and GitHub Releases.
- Wrappers depend on a compatible release, never a development branch.

## 12. Testing Strategy

### Skill TDD

Create and deploy one role at a time:

1. Write realistic pressure and application scenarios without the skill.
2. Run baseline agents and retain their exact failures or rationalizations.
3. Write the smallest role skill that fixes demonstrated failures.
4. Run the same scenarios with the skill.
5. Add adversarial cases for authority, scope, missing evidence, tracker leakage, and Git mutation.
6. Refactor the skill while keeping scenarios green.
7. Finish validation before starting the next role.

Baseline and enabled runs must use fresh contexts and must not leak the intended answer into the evaluator prompt.

### Contract tests

Automated tests verify:

- all manifests and marketplaces resolve to the same version;
- every declared skill exists and validates;
- every role has matching UI metadata and explicit invocation policy;
- request/result fixtures conform to the published schemas;
- role skills contain no forbidden tracker, project, hostname, credential, or task-prefix tokens;
- no role grants tracker writes or mutable Git;
- no role returns `next_stage` or tracker-specific report fields;
- references resolve inside the plugin package;
- installable package contents contain no secrets, caches, generated noise, or private source files.

### Integration tests

Use small fixture Dispatchers for Plane-shaped and YouTrack-shaped projects. Both must launch the same DreamTeam role and successfully consume the same neutral result contract.

The real wrappers are migrated only after the neutral integration fixtures pass.

## 13. Public-Release Hygiene

Private prompts are source material for requirements, not files to publish verbatim. Before release:

- rewrite every role in tracker-neutral language;
- remove company names, product names, internal URLs, task keys, proprietary schemas, credentials, and private examples;
- run a forbidden-token and secret scan;
- review ownership and licensing of adapted material;
- publish under Apache-2.0 to provide an explicit patent grant suitable for broad commercial reuse;
- document the security contact and responsible-disclosure process;
- protect the default branch with required CI and review;
- use CODEOWNERS for skill and contract changes;
- create signed or otherwise verified immutable release tags where the hosting setup permits it.

No remote repository is created and nothing is pushed until explicitly authorized.

## 14. Migration Plan

Migration is incremental and behavior-preserving:

1. Create and validate DreamTeam independently.
2. Add dependency preflight to one wrapper.
3. Replace one duplicated professional prompt with one DreamTeam role.
4. Run wrapper contract tests and a real workflow smoke.
5. Migrate remaining roles one at a time.
6. Repeat for the second wrapper.
7. Delete a local prompt only after its external replacement is verified on both supported runtimes.

The first wrapper migration should use `software-developer` or `code-reviewer`, because their shared responsibilities are already closest across the two projects. Product-stage migration follows only after the Plane PRD output composition is preserved exactly.

## 15. Failure Handling

- Missing DreamTeam: offer installation and stop.
- Incompatible contract: report installed and required versions; do not dispatch.
- Missing assignment field: professional returns `needs_human` without mutations.
- Prepared cwd unavailable or outside assignment authority: professional returns `blocked`; Dispatcher decides recovery.
- Malformed result: Dispatcher rejects it, performs no tracker transition, and records a project-specific blocker.
- Verification unavailable: record `broken` or equivalent evidence in the neutral result; never report it as passed.
- Professional timeout or crash: Dispatcher owns retry policy and idempotence.

## 16. Acceptance Criteria

- `/Users/macmini/Documents/DreamTeam` is an independent Git repository.
- Codex and Claude Code manifests and marketplaces validate.
- Plugin installation exposes all declared role skills.
- No Dispatcher or tracker integration exists in DreamTeam.
- Every role accepts Assignment v1 and returns Result v1.
- Every role is tracker-neutral and project-neutral by static tests and review.
- Mutable Git and tracker writes remain exclusively project-Dispatcher responsibilities.
- Each role has recorded RED and GREEN eval evidence before release.
- Contract, manifest, packaging, secret-scan, and runtime smoke checks pass.
- Plane and YouTrack fixture Dispatchers consume the same four role results without changing DreamTeam.
- README contains installation, wrapper-integration, compatibility, and contribution instructions.
- Public release occurs only after the content provenance and security audit passes.

## 17. Explicitly Deferred

- A hosted MCP service for DreamTeam.
- A universal Dispatcher.
- Automatic plugin updates.
- A UI.
- Telemetry or time tracking.
- DreamTeam-owned runtime model selection; Dispatchers remain responsible for launch profiles.
- New roles not backed by a current project need or a failing evaluation.
