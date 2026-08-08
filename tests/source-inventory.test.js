import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const roles = [
  {
    id: 'product-technologist',
    source: 'plugins/stroyberry/skills/stroyberry-workflow/prompts/prd.prompt.md'
  },
  {
    id: 'software-developer',
    source: 'plugins/stroyberry/skills/stroyberry-workflow/prompts/developer.prompt.md'
  },
  {
    id: 'code-reviewer',
    source: 'plugins/stroyberry/skills/stroyberry-workflow/prompts/reviewer.prompt.md'
  },
  {
    id: 'technical-writer',
    source: 'plugins/stroyberry/skills/stroyberry-workflow/prompts/docs.prompt.md'
  }
];

const forbidden = /Plane|YouTrack|plane_report|youtrack_report|macrodom|PLANE_|YOUTRACK_|\b(?:SB|DEV)-\d+\b/i;

test('the four Plane professional source prompts are present', () => {
  const sourceRoot = process.env.DREAMTEAM_SOURCE_ROOT;
  if (!sourceRoot) {
    return;
  }

  for (const role of roles) {
    assert.equal(fs.existsSync(path.join(sourceRoot, role.source)), true, role.source);
  }
});

test('each Plane-derived role has a skill and UI metadata', () => {
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
