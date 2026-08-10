# Current-Model Role Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DreamTeam roles explicitly consume the wrapper's current model while varying only the wrapper-selected reasoning level.

**Architecture:** DreamTeam remains a tracker-neutral role library: project wrappers own launch selection, and role skills declare the inherited-model/reasoning precondition. Static tests protect that boundary and synchronized manifests advance to `1.0.1`.

**Tech Stack:** Markdown skill contracts, Node.js `node:test`, JSON plugin manifests, Claude/Codex plugin validators.

## Global Constraints

- DreamTeam never owns model-family selection or a model allowlist.
- Every role uses the current wrapper/Dispatcher model.
- Product Technologist uses `high`; initial Software Developer uses `xhigh`; review-retry Software Developer and Code Reviewer use `max`.
- Technical Writer inherits the current model and the reasoning explicitly supplied by its wrapper.
- Leaf agents inherit the active parent role model and reasoning.
- Preserve Assignment v1, Result v1, tracker neutrality, and wrapper-owned lifecycle.
- Advance synchronized DreamTeam declarations from `1.0.0` to `1.0.1`.

---

### Task 1: Add failing role launch-contract tests

**Files:**
- Modify: `tests/plugin.test.js`

**Interfaces:**
- Consumes: the four role `SKILL.md` files.
- Produces: regression coverage for inherited current models, role reasoning, leaf inheritance, and wrapper-owned selection.

- [ ] **Step 1: Add the failing test**

```js
const readText = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('roles inherit the wrapper current model and never select a model family', () => {
  const roles = {
    product: readText('skills/product-technologist/SKILL.md'),
    developer: readText('skills/software-developer/SKILL.md'),
    reviewer: readText('skills/code-reviewer/SKILL.md'),
    writer: readText('skills/technical-writer/SKILL.md'),
  };

  for (const [name, text] of Object.entries(roles)) {
    assert.match(text, /current (?:wrapper|Dispatcher) model/i, `${name}: current model inheritance missing`);
    assert.doesNotMatch(text, /gpt-5\.6-(?:sol|terra)|model allowlist/i, `${name}: fixed model selection leaked into role`);
  }

  assert.match(roles.product, /`high` reasoning/i);
  assert.match(roles.developer, /initial[\s\S]*`xhigh`[\s\S]*(?:review retry|required_fixes)[\s\S]*`max`/i);
  assert.match(roles.reviewer, /`max` reasoning/i);
  assert.match(roles.writer, /reasoning[\s\S]*supplied by (?:the )?wrapper/i);
  assert.match(roles.developer, /leaf[\s\S]*inherit[\s\S]*model and reasoning/i);
  assert.match(roles.reviewer, /leaf[\s\S]*inherit[\s\S]*model and reasoning/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test --test-name-pattern="roles inherit the wrapper current model" tests/plugin.test.js
```

Expected: FAIL because the four role contracts do not yet declare the launch profile.

- [ ] **Step 3: Commit the RED test**

```bash
git add tests/plugin.test.js
git commit -m "test: require inherited role launch profiles"
```

---

### Task 2: Implement role launch requirements

**Files:**
- Modify: `skills/product-technologist/SKILL.md`
- Modify: `skills/software-developer/SKILL.md`
- Modify: `skills/code-reviewer/SKILL.md`
- Modify: `skills/technical-writer/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: project-wrapper current model, role assignment, review-retry state, and wrapper-supplied reasoning for Technical Writer.
- Produces: role-local launch preconditions without tracker or lifecycle knowledge.

- [ ] **Step 1: Add one launch-profile section to each role**

Use these exact semantics:

```markdown
## Launch profile

The project wrapper launches this role with the wrapper/Dispatcher's current model. Do not select or require a model family inside DreamTeam.
```

Append the role-specific reasoning rule: Product Technologist `high`; Software Developer initial `xhigh` and review retry/`required_fixes` `max`; Code Reviewer `max`; Technical Writer the explicit level supplied by the wrapper. In Developer and Reviewer, require leaf agents to inherit the active parent model and reasoning.

- [ ] **Step 2: Document wrapper ownership in README**

State that wrappers launch roles on their current model and choose only reasoning; DreamTeam does not pin model families.

- [ ] **Step 3: Run focused and full tests**

```bash
node --test --test-name-pattern="roles inherit the wrapper current model" tests/plugin.test.js
npm test
```

Expected: both commands pass.

- [ ] **Step 4: Commit role contracts**

```bash
git add skills README.md
git commit -m "feat: inherit wrapper models in roles"
```

---

### Task 3: Synchronize DreamTeam version and validate

**Files:**
- Modify: `package.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: completed role launch contract.
- Produces: synchronized plugin version `1.0.1`.

- [ ] **Step 1: Set version `1.0.1` in all five declarations**

Change only existing version values and preserve JSON formatting.

- [ ] **Step 2: Run repository gates**

```bash
npm test
claude plugin validate /Users/macmini/Documents/DreamTeam
git diff --check
rg -n "gpt-5\.6-(sol|terra)|model allowlist" skills README.md
```

Expected: tests and validator pass; `git diff --check` and the obsolete-model search are silent.

- [ ] **Step 3: Commit synchronized release metadata**

```bash
git add package.json .codex-plugin/plugin.json .claude-plugin/plugin.json .agents/plugins/marketplace.json .claude-plugin/marketplace.json
git commit -m "chore: bump DreamTeam to 1.0.1"
```
