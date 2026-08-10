# Adaptive Product-Technologist Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `product-technologist` internally assess assignment impact and scale its existing product-and-technical specification without changing DreamTeam contracts.

**Architecture:** Keep the behavior entirely inside `skills/product-technologist/SKILL.md`. Add one static contract test and one paired evaluation scenario that prove pre-analysis precedes drafting, uses three impact dimensions, selects an internal `small`/`medium`/`large` level, and shapes the existing required sections without emitting the classification.

**Tech Stack:** Markdown skills, Node.js built-in test runner, Claude/Codex plugin manifests.

## Global Constraints

- Change only the existing `product-technologist` role and its direct tests/evaluations.
- Preserve Assignment v1, Result v1, `role: product-technologist`, terminal statuses, and `changed_paths: []`.
- Preserve tracker-neutral behavior; add no workflow, tracker, Git, delivery, or publication rules.
- Keep all four existing required specification sections at every adaptive level.
- Keep impact classification internal; add no output field, heading, summary label, or finding.
- Do not change versions, schemas, other roles, or `agents/openai.yaml`.

---

### Task 1: Add adaptive specification depth to product-technologist

**Files:**
- Modify: `tests/source-inventory.test.js`
- Create: `evals/product-technologist/baseline/bounded-small-change.md`
- Create: `evals/product-technologist/skill-enabled/bounded-small-change.md`
- Modify: `skills/product-technologist/SKILL.md`

**Interfaces:**
- Consumes: existing Assignment v1 inputs, verified repository evidence, requested output language/density, and the existing `product_technical_spec` Result v1 deliverable.
- Produces: the same `product_technical_spec` sections with internally selected `small`, `medium`, or `large` content density; no schema or metadata change.

- [ ] **Step 1: Read the test-quality rules**

Read `superpowers:test-driven-development/writing-good-tests.md` before editing `tests/source-inventory.test.js`. Name the production change that makes the test pass: add the adaptive impact contract to `skills/product-technologist/SKILL.md`.

- [ ] **Step 2: Add the failing contract test**

Append this test to `tests/source-inventory.test.js`:

```js
test('product-technologist scales specification density after internal impact pre-analysis', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/product-technologist/SKILL.md'), 'utf8');
  const preAnalysis = skill.indexOf('## Impact Pre-analysis');
  const requiredWork = skill.indexOf('## Required Work');

  assert.ok(preAnalysis > -1, 'impact pre-analysis is missing');
  assert.ok(requiredWork > -1, 'required work is missing');
  assert.ok(preAnalysis < requiredWork, 'impact pre-analysis must precede drafting');

  for (const dimension of ['Code impact', 'Interface impact', 'Business-process and data impact']) {
    assert.match(skill, new RegExp(dimension, 'i'), dimension);
  }
  for (const level of ['small', 'medium', 'large']) {
    assert.match(skill, new RegExp(`\\b${level}\\b`, 'i'), level);
  }

  assert.match(skill, /wording length[^\n]*(?:weak|not)/i);
  assert.match(skill, /raw file count[^\n]*(?:weak|not)/i);
  assert.match(skill, /schema|migration/i);
  assert.match(skill, /security|permission/i);
  assert.match(skill, /public[^\n]*(?:API|contract)|integration/i);
  assert.match(skill, /material ambiguity[^\n]*`needs_human`/i);
  assert.match(skill, /classification[^\n]*internal/i);
  assert.match(skill, /(?:not|never)[^\n]*(?:heading|field|summary label|finding)/i);
  assert.match(skill, /all four[^\n]*required[^\n]*sections/i);
  assert.match(skill, /small output[^\n]*material behavior/i);
  assert.match(skill, /do not separately enumerate[^\n]*audience[^\n]*value[^\n]*scenarios/i);
  assert.match(skill, /every point[^\n]*(?:decision|boundary)[^\n]*(?:implementation|verification)/i);
  assert.match(skill, /(?:do not|not)[^\n]*repeat[^\n]*across sections/i);
});
```

- [ ] **Step 3: Add the bounded-small evaluation pair**

Create `evals/product-technologist/baseline/bounded-small-change.md`:

```markdown
# Baseline scenario: bounded removal

Without the adaptive-depth contract, process an otherwise valid Assignment v1 whose accepted decision removes one existing UI listing and its exclusive read path while preserving every other page behavior and contract.

The current role contract requires problem, audience, scenarios, value, UX mechanics, standard components, and internal analogues for every assignment. This makes a bounded removal susceptible to boilerplate that adds no decision, constraint, or verification obligation.
```

Create `evals/product-technologist/skill-enabled/bounded-small-change.md`:

```markdown
# Enabled-skill expectation

The role performs internal impact pre-analysis and treats the assignment as small only after repository evidence confirms bounded code, interface, and business-process/data impact. The returned artifact keeps all required sections but states only the material removed and preserved behavior, exact affected entry points/contracts, and the smallest observable regression-proof QA set. It does not emit the impact level or separately enumerate audience, value, scenarios, components, or analogues that add no decision.
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
node --test tests/source-inventory.test.js
```

Expected: FAIL at `impact pre-analysis is missing`. Existing inventory tests remain green.

- [ ] **Step 5: Add the minimal impact pre-analysis contract**

In `skills/product-technologist/SKILL.md`, insert `## Impact Pre-analysis` immediately before `## Required Work`. Require verified evidence across code, interface, and business-process/data impact; define `small`, `medium`, and `large`; state that wording length and raw file count are weak signals; elevate large-risk signals; return `needs_human` for material ambiguity; and keep classification internal and absent from output.

Update `## Required Work` so product and technical topics are included only when they add a decision, boundary, implementation constraint, or verification obligation. Add the positive density recipe from the design:

```markdown
- Small output: material behavior and boundaries, exact changed and unchanged behavior, minimal verified Scope, and the smallest observable regression-proof QA set.
- Medium output: main actor or caller flow, states, boundaries, affected contracts, compatibility behavior, and meaningful edge cases.
- Large output: affected roles and flows, interfaces and integrations, data and migration behavior, permissions, failure and recovery, operational risk, compatibility, boundaries, and useful decomposition.
```

State explicitly that all four required sections remain present, that output density cannot remove material obligations or force boilerplate, that every point must carry a decision/boundary/implementation/verification obligation, and that facts are not repeated across sections. Preserve the existing split rule; `large` triggers consideration, not an automatic split.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/source-inventory.test.js
```

Expected: all source-inventory tests PASS.

- [ ] **Step 7: Validate the changed skill**

Run:

```bash
UV_CACHE_DIR=/tmp/dreamteam-uv-cache uv run --with pyyaml python /Users/macmini/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/product-technologist
```

Expected: skill validation succeeds with no frontmatter or structure error.

- [ ] **Step 8: Run complete verification**

Run:

```bash
npm test
claude plugin validate .
git diff --check
```

Expected: every command exits 0; no tracker-specific vocabulary leaks into public role instructions.

- [ ] **Step 9: Re-read the diff and remove nonessential content**

Confirm that only the planned skill, test, and evaluation files changed; schemas, manifests, versions, UI metadata, and other roles are untouched. Confirm the internal classification is not added to `Output Deliverable` as a returned field or section.

- [ ] **Step 10: Commit the verified behavior**

```bash
git add tests/source-inventory.test.js \
  evals/product-technologist/baseline/bounded-small-change.md \
  evals/product-technologist/skill-enabled/bounded-small-change.md \
  skills/product-technologist/SKILL.md
git commit -m "feat: scale product technologist depth by impact"
```
