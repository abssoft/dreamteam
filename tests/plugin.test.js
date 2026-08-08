import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

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
