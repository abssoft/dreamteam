import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const readText = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

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
});

test('assignment fixture contains the stable dispatcher-to-professional boundary', () => {
  const assignment = readJson('contracts/examples/assignment.json');
  for (const key of ['contract_version', 'assignment_id', 'role', 'objective', 'scope', 'repository', 'permissions', 'verification', 'return_contract']) {
    assert.ok(Object.hasOwn(assignment, key), key);
  }
});

test('result fixture is tracker-neutral and terminal', () => {
  const result = readJson('contracts/examples/result.json');
  assert.ok(['done', 'blocked', 'needs_human', 'failed'].includes(result.status));
  assert.equal(Object.hasOwn(result, 'next_stage'), false);
  assert.equal(Object.hasOwn(result, 'plane_report'), false);
  assert.equal(Object.hasOwn(result, 'youtrack_report'), false);
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
