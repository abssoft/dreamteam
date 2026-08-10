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
