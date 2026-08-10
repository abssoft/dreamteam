import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const roles = [
  {
    id: 'product-technologist'
  },
  {
    id: 'software-developer'
  },
  {
    id: 'code-reviewer'
  },
  {
    id: 'technical-writer'
  }
];

const forbidden = /Plane|YouTrack|plane_report|youtrack_report|macrodom|PLANE_|YOUTRACK_|\b(?:SB|DEV)-\d+\b/i;

test('DreamTeam role sources are self-contained', () => {
  for (const role of roles) {
    const skill = fs.readFileSync(path.join(root, 'skills', role.id, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /plugins\/stroyberry|prompts\/(?:prd|developer|reviewer|docs)\.prompt\.md/i, role.id);
    assert.match(skill, /Assignment v1/i, role.id);
    assert.match(skill, /Result v1/i, role.id);
  }
});

test('each public role has a skill and UI metadata', () => {
  for (const role of roles) {
    assert.equal(fs.existsSync(path.join(root, 'skills', role.id, 'SKILL.md')), true, role.id);
    assert.equal(fs.existsSync(path.join(root, 'skills', role.id, 'agents', 'openai.yaml')), true, role.id);
  }
});

test('public role instructions do not leak tracker or private project vocabulary', () => {
  for (const role of roles) {
    const skill = fs.readFileSync(path.join(root, 'skills', role.id, 'SKILL.md'), 'utf8');
    assert.equal(forbidden.test(skill), false, role.id);
  }
});
