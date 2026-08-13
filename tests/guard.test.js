import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const readText = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateAssignment = ajv.compile(readJson('contracts/assignment-v1.schema.json'));
const validateResult = ajv.compile(readJson('contracts/result-v1.schema.json'));
const assertValid = (validate, value, label) => {
  assert.equal(validate(value), true, `${label}: ${ajv.errorsText(validate.errors)}`);
};

const roleDeliverables = {
  'product-technologist': 'product_technical_spec',
  'software-developer': 'implementation_summary',
  'code-reviewer': 'review_report',
  'technical-writer': 'documentation_proposal',
};

test('contract examples validate against their schemas', () => {
  assertValid(validateAssignment, readJson('contracts/examples/assignment.json'), 'assignment example');
  assertValid(validateResult, readJson('contracts/examples/result.json'), 'result example');
});

test('each role SKILL.md embeds a valid neutral Result v1 handoff', () => {
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

const forbiddenVocabulary = /Plane|YouTrack|plane_report|youtrack_report|macrodom|PLANE_|YOUTRACK_|\b(?:SB|DEV)-\d+\b/i;
const allowedRepositoryLocations = [
  'git@github.com:abssoft/dreamteam.git',
  'https://github.com/abssoft/dreamteam.git',
];
const nonPublicTrackedPath = /(?:^|\/)(?:\.git|node_modules|vendor|dist|build|coverage)(?:\/|$)/;
const generatedLockfiles = new Set(['package-lock.json']);
const publicContractFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--', '*.md', '*.json', '*.yaml', '*.yml'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter((relative) => !nonPublicTrackedPath.test(relative) && !generatedLockfiles.has(relative));
const coordinatePatterns = [
  ['legacy coordinate field', /["'`]?(?:workspace_path|head_sha|base_sha|base_branch|task_branch)["'`]?\s*[:=]/gi],
  ['absolute POSIX path', /(?:^|[\s"'`(=:\[])\/(?:Users|home|tmp|var|opt|usr|etc|Volumes|private|root|srv|mnt)(?:\/[^\s"'`)\],}]+)+/gm],
  ['Windows drive path', /(?:^|[\s"'`(=:\[])[A-Za-z]:(?:[\\/]|[A-Za-z0-9._-])[^\s"'`)\],}]*/gm],
  ['Windows UNC path', /\\\\[A-Za-z0-9._$ -]+\\[A-Za-z0-9._$ -]+(?:\\[^\s"'`)\],}]*)?/g],
  ['parent traversal', /(?:^|[\s"'`(=:\[])\.\.[\\/][^\s"'`)\],}]*/gm],
  ['raw revision', /\b(?:[A-Fa-f0-9]{64}|[A-Fa-f0-9]{40})\b/g],
  ['branch field', /["'`]?(?:branch|base_branch|task_branch)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9._/-]+/gi],
  ['branch ref', /\brefs\/heads\/[A-Za-z0-9._/-]+\b/g],
  ['tracker token', /(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9]*-\d+(?![A-Za-z0-9_]|\\?\.\d)/g],
];
const structuredValuePattern = /(?:^|[\s{,])["'`]?([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,}\]\r\n]+))/gm;
const repositoryKeyPattern = /(?:^|_)(?:repo|repository|location|origin|source)(?:_|$)/i;
const repositoryUrlPattern = /^(?:git@|(?:git|https?|ssh|file):\/\/)/i;
const locationPattern = /^(?:\/(?!\/)|[A-Za-z]:(?:[\\/]|[A-Za-z0-9._-])|\\\\|\.\.[\\/])/;

const findSerializedCoordinates = (source) => {
  const findings = [];
  for (const [kind, pattern] of coordinatePatterns) {
    for (const match of source.matchAll(pattern)) {
      findings.push(`${kind}: ${match[0].trim()}`);
    }
  }
  for (const match of source.matchAll(structuredValuePattern)) {
    const [, key, doubleQuoted, singleQuoted, backtickQuoted, unquoted] = match;
    const value = doubleQuoted ?? singleQuoted ?? backtickQuoted ?? unquoted;
    if (locationPattern.test(value)) {
      findings.push(`structured location: ${key}: ${value}`);
    }
    if (
      repositoryKeyPattern.test(key)
      && repositoryUrlPattern.test(value)
      && !allowedRepositoryLocations.includes(value)
    ) {
      findings.push(`repository URL: ${key}: ${value}`);
    }
  }
  return findings;
};

test('role instructions do not leak tracker or private project vocabulary', () => {
  for (const role of Object.keys(roleDeliverables)) {
    assert.equal(forbiddenVocabulary.test(readText(`skills/${role}/SKILL.md`)), false, role);
  }
});

test('tracked public sources contain no private coordinates', () => {
  const violations = publicContractFiles.flatMap((relative) => {
    const findings = findSerializedCoordinates(fs.readFileSync(path.join(root, relative), 'utf8'));
    return findings.map((finding) => `${relative}: ${finding}`);
  });
  assert.deepEqual(violations, []);
});
