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
  assert.equal(packageJson.version, '1.0.1');
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
  assert.match(roles.developer, /initial[^\n]*`xhigh`[^\n]*(?:review retry|required_fixes)[^\n]*`max`/i);
  assert.match(roles.reviewer, /`max` reasoning/i);
  assert.match(roles.writer, /reasoning[^\n]*supplied by (?:the )?wrapper/i);
  assert.match(roles.developer, /leaf[^\n]*inherit[^\n]*model and reasoning/i);
  assert.match(roles.reviewer, /leaf[^\n]*inherit[^\n]*model and reasoning/i);
});
