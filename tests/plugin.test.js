import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const readText = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const assignmentSchema = readJson('contracts/assignment-v1.schema.json');
const resultSchema = readJson('contracts/result-v1.schema.json');
const validateAssignment = ajv.compile(assignmentSchema);
const validateResult = ajv.compile(resultSchema);
const assertValid = (validate, value, label) => {
  assert.equal(validate(value), true, `${label}: ${ajv.errorsText(validate.errors)}`);
};

test('plugin metadata is synchronized across package, manifests, and marketplaces', () => {
  const packageJson = readJson('package.json');
  const codex = readJson('.codex-plugin/plugin.json');
  const claude = readJson('.claude-plugin/plugin.json');
  const codexMarketplace = readJson('.agents/plugins/marketplace.json');
  const claudeMarketplace = readJson('.claude-plugin/marketplace.json');

  assert.equal(packageJson.name, 'dream-team');
  assert.equal(codex.name, packageJson.name);
  assert.equal(claude.name, packageJson.name);
  assert.equal(codex.version, packageJson.version);
  assert.equal(claude.version, packageJson.version);
  assert.equal(codexMarketplace.plugins[0].name, packageJson.name);
  assert.equal(claudeMarketplace.plugins[0].name, packageJson.name);
  assert.equal(codexMarketplace.plugins[0].version, packageJson.version);
  assert.equal(claudeMarketplace.plugins[0].version, packageJson.version);
  assert.equal(packageJson.version, '1.1.0');
});

test('assignment fixture validates accepted neutral inputs', () => {
  const value = readJson('contracts/examples/assignment.json');
  assertValid(validateAssignment, value, 'assignment fixture');
  assert.deepEqual(Object.keys(value.inputs), [
    'accepted_decisions',
    'source_materials',
    'output',
  ]);
  assert.equal(value.inputs.output.language, 'ru');
});

test('result fixture validates one tagged neutral deliverable', () => {
  const value = readJson('contracts/examples/result.json');
  assertValid(validateResult, value, 'result fixture');
  assert.equal(value.deliverables[0].kind, 'implementation_summary');
  for (const key of ['next_stage', 'changed_sections', 'split_recommendation', 'plane_report']) {
    assert.equal(Object.hasOwn(value, key), false, key);
  }
});

const roleDeliverables = {
  'product-technologist': 'product_technical_spec',
  'software-developer': 'implementation_summary',
  'code-reviewer': 'review_report',
  'technical-writer': 'documentation_proposal',
};

test('each role returns its neutral tagged Result v1 deliverable', () => {
  for (const [role, kind] of Object.entries(roleDeliverables)) {
    const skill = readText(`skills/${role}/SKILL.md`);
    const handoff = skill.match(/```json\s*([\s\S]*?)\s*```/);
    assert.ok(handoff, `${role}: Result v1 example missing`);
    const result = JSON.parse(handoff[1]);
    assertValid(validateResult, result, role);
    assert.equal(result.role, role);
    assert.equal(result.deliverables[0].kind, kind);
    for (const field of ['next_stage', 'changed_sections', 'split_recommendation', 'plane_report']) {
      assert.equal(Object.hasOwn(result, field), false, `${role}: ${field}`);
    }
  }
});
