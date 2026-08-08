# DreamTeam Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with a verification checkpoint after each task.

**Goal:** Build the public `dream-team` skills-only plugin by extracting the four existing professional prompts from PlaneWorkflow, preserving their behavior while removing only Dispatcher, tracker, and project-specific responsibilities.

**Architecture:** Keep project wrappers as workflow owners. DreamTeam supplies explicit role skills and neutral assignment/result contracts. Each role is migrated directly from the current Plane prompt; Macro prompts are not copied or used as source material in this phase.

**Tech Stack:** Markdown skills, YAML frontmatter, JSON manifests/schemas, Node.js 20 built-in test runner, Python quick validator already used by the local skill toolchain, GitHub Actions.

## Global Constraints

- Treat `/Users/macmini/Documents/PlaneWorkflow/plugins/stroyberry/skills/stroyberry-workflow/prompts/` as the primary source of professional instructions.
- Do not invent replacement behavior where an equivalent Plane prompt section already exists.
- Remove only Plane MCP names, Plane reports, project keys, branch policy, Dispatcher routing, and tracker mutations from public role skills.
- DreamTeam roles never write tracker artifacts and never perform mutable Git lifecycle operations.
- Every role returns neutral Result v1; no `next_stage`, tracker report, or state transition fields.
- Keep runtime dependencies at zero; use Node built-ins for repository tests.
- Validate each role before starting the next role.
- Do not push or configure a remote GitHub repository.

---

### Task 1: Establish source inventory and contract tests

**Files:**
- Create: `tests/plugin.test.js`
- Create: `tests/source-inventory.test.js`
- Create: `contracts/assignment-v1.schema.json`
- Create: `contracts/result-v1.schema.json`
- Create: `contracts/examples/assignment.json`
- Create: `contracts/examples/result.json`
- Modify: `package.json`

**Interfaces:**
- Tests consume the source prompt paths under PlaneWorkflow and the declared DreamTeam role directories.
- Contract fixtures expose stable required keys for later role tests and wrapper adapters.

- [ ] **Step 1: Write failing source-inventory tests**

Assert that the four source prompt files exist (`prd`, `developer`, `reviewer`, `docs`), each declared role has a `SKILL.md`, every skill has `agents/openai.yaml`, and public role files contain none of the forbidden tracker tokens (`Plane`, `YouTrack`, `plane_report`, `youtrack_report`, internal hostnames, or task prefixes).

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `node --test tests/source-inventory.test.js`

Expected: fail because the DreamTeam role directories and manifests do not exist.

- [ ] **Step 3: Write failing contract tests**

Assert that the assignment requires `contract_version`, `assignment_id`, `role`, `objective`, `scope`, `repository`, `permissions`, `verification`, and `return_contract`; assert that results permit only `done`, `blocked`, `needs_human`, and `failed`, and reject `next_stage` and tracker report fields.

- [ ] **Step 4: Run the focused test and verify the expected failure**

Run: `node --test tests/plugin.test.js`

Expected: fail because manifests and contract fixtures do not exist.

- [ ] **Step 5: Add the minimal package test entry point**

Set `package.json` to a private Node package with `type: "module"`, Node `>=20.10`, and `"test": "node --test"`.

- [ ] **Step 6: Run the focused tests and record the remaining failures**

Run: `npm test`

Expected: source-inventory and contract assertions still fail; this confirms the tests are exercising missing production artifacts rather than passing accidentally.

- [ ] **Step 7: Commit the test and contract baseline**

```bash
git add package.json tests contracts
git commit -m "test: define DreamTeam source and contract gates"
```

### Task 2: Scaffold the cross-runtime plugin package

**Files:**
- Create: `.codex-plugin/plugin.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `README.md`
- Create: `LICENSE`
- Create: `SECURITY.md`
- Create: `AGENTS.md`
- Create: `.github/CODEOWNERS`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Manifests expose `skills: "./skills/"` and synchronized version `1.0.0`.
- Marketplaces point to the repository-local plugin path and use plugin name `dream-team`.

- [ ] **Step 1: Add manifest consistency assertions**

Extend `tests/plugin.test.js` to parse both plugin manifests, both marketplaces, and `package.json`; assert identical `name`/`version`, valid relative paths, and marketplace plugin source paths inside the repository.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/plugin.test.js`

Expected: fail on absent manifests and package metadata.

- [ ] **Step 3: Initialize plugin metadata with the Superpowers-compatible layout**

Create manifests with display name `DreamTeam`, plugin ID `dream-team`, skills directory `./skills/`, and no MCP server. Use Apache-2.0 for the public repository and keep the repository URL unset until the GitHub owner is supplied.

- [ ] **Step 4: Add repository governance files**

Document installation, explicit role invocation, wrapper integration, contract compatibility, contribution checks, security reporting, and the rule that role skills are adapted from the Plane source prompts. Keep governance docs outside runtime skill directories.

- [ ] **Step 5: Add CI and ownership rules**

Run `npm test`, `git diff --check`, and the local skill validator for every pull request. Require review for `skills/`, `contracts/`, and manifests.

- [ ] **Step 6: Run manifest and packaging tests**

Run: `npm test`

Expected: metadata tests pass; role inventory tests remain red until Tasks 3–9 create the role skills.

- [ ] **Step 7: Commit the package scaffold**

```bash
git add .codex-plugin .claude-plugin .agents .github README.md LICENSE SECURITY.md AGENTS.md package.json
git commit -m "chore: scaffold DreamTeam cross-runtime plugin"
```

### Task 3: Extract Product-Technologist from the Plane PRD source

**Files:**
- Create: `skills/product-technologist/SKILL.md`
- Create: `skills/product-technologist/agents/openai.yaml`
- Create: `skills/product-technologist/references/assignment.md`
- Create: `evals/product-technologist/baseline/ambiguous-request.md`
- Create: `evals/product-technologist/skill-enabled/ambiguous-request.md`
- Modify: `tests/source-inventory.test.js`

**Source:** `PlaneWorkflow/plugins/stroyberry/skills/stroyberry-workflow/prompts/prd.prompt.md`, preserving its Product-Technologist role, evidence, scope, visual-reference, acceptance, and canonical-output rules while excluding Plane tools and HTML publication.

- [ ] **Step 1: Write and run a failing baseline scenario for ambiguous product/technical scope**
- [ ] **Step 2: Record the baseline omissions and rationalizations in the eval fixture**
- [ ] **Step 3: Initialize the role skill with `init_skill.py` and explicit UI metadata**
- [ ] **Step 4: Port the Plane prompt sections without tracker leakage or new methodology**
- [ ] **Step 5: Run quick validation, leakage tests, and the enabled scenario**
- [ ] **Step 6: Commit the verified role**

### Task 4: Extract Developer from the Plane workflow

**Files:**
- Create: `skills/software-developer/SKILL.md`
- Create: `skills/software-developer/agents/openai.yaml`
- Create: `skills/software-developer/references/assignment.md`
- Create: `evals/software-developer/`
- Modify: `tests/source-inventory.test.js`

**Source:** `PlaneWorkflow/plugins/stroyberry/skills/stroyberry-workflow/prompts/developer.prompt.md`, preserving implementation, verification, comment, security-lens, and handoff rules while excluding Plane-specific publication.

- [ ] **Step 1: Write and run failing baseline scenarios for scope pressure, test skipping, and unrelated changes**
- [ ] **Step 2: Record exact baseline rationalizations**
- [ ] **Step 3: Initialize the role skill through `init_skill.py`**
- [ ] **Step 4: Port the existing developer contract without adding tracker or Git-delivery behavior**
- [ ] **Step 5: Run quick validation, leakage tests, and enabled scenarios**
- [ ] **Step 6: Commit the verified role**

### Task 5: Extract Reviewer from the Plane workflow

**Files:**
- Create: `skills/code-reviewer/SKILL.md`
- Create: `skills/code-reviewer/agents/openai.yaml`
- Create: `skills/code-reviewer/references/assignment.md`
- Create: `evals/code-reviewer/`
- Modify: `tests/source-inventory.test.js`

**Source:** `PlaneWorkflow/plugins/stroyberry/skills/stroyberry-workflow/prompts/reviewer.prompt.md`, preserving diff, verification, comment, security-lens, refutation, and handoff rules while excluding Plane-specific publication.

- [ ] **Step 1: Write and run failing baseline scenarios for false-positive findings and pressure to approve**
- [ ] **Step 2: Record exact baseline rationalizations**
- [ ] **Step 3: Initialize the role skill through `init_skill.py`**
- [ ] **Step 4: Port the reviewer contract; make it read-only by default and allow trivial fixes only when the assignment grants that capability**
- [ ] **Step 5: Run quick validation, leakage tests, and enabled scenarios**
- [ ] **Step 6: Commit the verified role**

### Task 6: Extract Technical Writer from the Plane workflow

**Files:**
- Create: `skills/technical-writer/SKILL.md`
- Create: `skills/technical-writer/agents/openai.yaml`
- Create: `skills/technical-writer/references/assignment.md`
- Create: `evals/technical-writer/`
- Modify: `tests/source-inventory.test.js`

**Source:** `PlaneWorkflow/plugins/stroyberry/skills/stroyberry-workflow/prompts/docs.prompt.md`, preserving its documentation artifact rules and verified-facts discipline while excluding Plane page writes.

- [ ] **Step 1: Write and run a failing baseline scenario for documentation invention and stale implementation facts**
- [ ] **Step 2: Record the exact baseline failure**
- [ ] **Step 3: Initialize and port the role skill**
- [ ] **Step 4: Require the role to cite verified implementation facts and return a neutral document artifact**
- [ ] **Step 5: Run focused validation, leakage tests, and the enabled scenario**
- [ ] **Step 6: Commit the verified role**

### Task 7: Complete contract fixtures and static security gates

**Files:**
- Modify: `tests/plugin.test.js`
- Modify: `tests/source-inventory.test.js`
- Modify: `contracts/examples/assignment.json`
- Modify: `contracts/examples/result.json`
- Create: `tests/fixtures/plane-dispatcher-result.json`
- Create: `tests/fixtures/youtrack-dispatcher-result.json`

- [ ] **Step 1: Add fixture tests for every role and every allowed terminal status**
- [ ] **Step 2: Add forbidden-token and secret-pattern tests across all runtime skill files**
- [ ] **Step 3: Add assertions for explicit invocation metadata and no MCP dependency declarations**
- [ ] **Step 4: Add adapter fixtures proving both wrapper shapes consume the same neutral result**
- [ ] **Step 5: Run the complete test suite and inspect every failure**
- [ ] **Step 6: Commit the contract and security gates**

### Task 8: Validate packaging and local installation surfaces

**Files:**
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/plugin.test.js`

- [ ] **Step 1: Add package-content assertions**

Reject `.env`, credentials, generated caches, private source snapshots, and files outside declared plugin paths from the installable surface.

- [ ] **Step 2: Run all local validators**

Run: `npm test`

Run: `git diff --check`

Run: `uv run --with pyyaml python /Users/macmini/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills`

Run: `claude plugin validate /Users/macmini/Documents/DreamTeam`

- [ ] **Step 3: Verify both manifests and marketplaces from clean paths**

Use a temporary copy containing only package files and confirm every role skill and reference resolves after installation.

- [ ] **Step 4: Commit packaging verification**

```bash
git add README.md .github tests
git commit -m "test: verify DreamTeam packaging and installation"
```

### Task 9: Review the complete public extraction

**Files:**
- Review: all `skills/*/SKILL.md`
- Review: all `skills/*/references/*`
- Review: `README.md`, `SECURITY.md`, `LICENSE`, manifests, marketplaces, contracts, tests

- [ ] **Step 1: Compare every role section against its Plane source prompt**

Record each retained section and each removed tracker/Dispatcher section in a source map. Any missing Plane professional rule is a defect, not an opportunity to redesign.

- [ ] **Step 2: Run the complete gate suite from a clean tree**

Run: `npm test`

Run: `git diff --check`

Run: `claude plugin validate /Users/macmini/Documents/DreamTeam`

- [ ] **Step 3: Inspect the final diff and installed file list**

Confirm that only DreamTeam files changed, no remote was configured, and no public skill contains private tracker/project material.

- [ ] **Step 4: Commit the release candidate**

```bash
git add .
git commit -m "release: DreamTeam 1.0.0"
```

Do not push. GitHub owner/repository and public release remain explicit follow-up actions.
