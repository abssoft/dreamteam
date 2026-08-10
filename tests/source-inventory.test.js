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
const allowedRepositoryLocation = 'git@github.com:abssoft/dreamteam.git';
const coordinatePatterns = [
  ['legacy coordinate field', /["'`]?(?:workspace_path|head_sha|base_sha|base_branch|task_branch)["'`]?\s*[:=]/gi],
  ['structured POSIX path', /["'`]?(?:workspace|workspace_root|cwd|repository_path|root_path|path)["'`]?\s*[:=]\s*["'`]?\/(?!\/)[^\s"'`)\],}]+/gi],
  ['POSIX system path', /(?:^|[\s"'`(=:\[])\/(?:Users|home|workspace|tmp|var|opt|usr|etc|bin|sbin|Volumes|Library|Applications|private|root|srv|mnt)(?:\/[^\s"'`)\],}]+)+/gm],
  ['Windows drive path', /(?:^|[\s"'`(=:\[])[A-Za-z]:(?:[\\/]|[A-Za-z0-9._-])[^\s"'`)\],}]*/gm],
  ['Windows UNC path', /\\\\[A-Za-z0-9._$ -]+\\[A-Za-z0-9._$ -]+(?:\\[^\s"'`)\],}]*)?/g],
  ['parent traversal', /(?:^|[\s"'`(=:\[])\.\.[\\/][^\s"'`)\],}]*/gm],
  ['repository URL', /["'`]?(?:repository(?:_url|_location)?|repo_url)["'`]?\s*[:=]\s*["'`]?(?:(?:https?|ssh|file):\/\/|git@)[^\s"'`)\],}]+/gi],
  ['raw revision', /\b(?:[A-Fa-f0-9]{64}|[A-Fa-f0-9]{40})\b/g],
  ['branch field', /["'`]?(?:branch|base_branch|task_branch)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9._/-]+/gi],
  ['branch ref', /\brefs\/heads\/[A-Za-z0-9._/-]+\b/g],
  ['tracker assignment', /["'`]?assignment_id["'`]?\s*[:=]\s*["'`]?[A-Za-z][A-Za-z0-9]+-\d+(?=[:"'`\s])/gi],
];

const findSerializedCoordinates = (source) => {
  const inspected = source.replaceAll(allowedRepositoryLocation, '<allowed-repository-location>');
  const findings = [];
  for (const [kind, pattern] of coordinatePatterns) {
    for (const match of inspected.matchAll(pattern)) {
      findings.push(`${kind}: ${match[0].trim()}`);
    }
  }
  return findings;
};

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

test('public contract documentation contains no serialized repository coordinates', () => {
  const publicContractFiles = [
    'README.md',
    'docs/architecture.md',
    'docs/superpowers/specs/2026-08-08-dream-team-plugin-design.md',
    'contracts/examples/assignment.json',
    'contracts/examples/result.json',
    'skills/product-technologist/references/assignment.md',
    'skills/software-developer/references/assignment.md',
    'skills/code-reviewer/references/review.md',
    'skills/technical-writer/references/documentation.md',
  ];
  for (const relative of publicContractFiles) {
    const findings = findSerializedCoordinates(fs.readFileSync(path.join(root, relative), 'utf8'));
    assert.deepEqual(findings, [], `${relative}: ${findings.join(', ')}`);
  }
});

test('public coordinate detector rejects generic leaked literals', () => {
  const leaks = [
    ['POSIX user path', 'workspace: "/Users/alice/work/repo"'],
    ['POSIX home path', 'workspace: "/home/alice/work/repo"'],
    ['generic structured POSIX path', 'workspace: "/projects/acme/repo"'],
    ['Windows path', String.raw`workspace: "C:\work\repo"`],
    ['Windows slash path', 'workspace: "C:/work/repo"'],
    ['Windows drive-relative path', 'workspace: "C:work\\repo"'],
    ['UNC path', String.raw`workspace: "\\server\share\repo"`],
    ['parent traversal', 'path: "../outside/repo"'],
    ['repository URL', 'repository_url: "https://github.com/acme/private-repo.git"'],
    ['raw 40-hex revision', 'revision: "0123456789abcdef0123456789abcdef01234567"'],
    ['raw 64-hex revision', 'revision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"'],
    ['branch field', 'branch: "feature/example"'],
    ['branch ref', 'revision: "refs/heads/main"'],
    ['tracker assignment', 'assignment_id: "DEV-204:development:1"'],
  ];

  for (const [label, source] of leaks) {
    assert.notEqual(findSerializedCoordinates(source).length, 0, label);
  }
});

test('public coordinate detector allows approved locations and documentation syntax', () => {
  const safeSources = [
    ['approved repository', `Install ${allowedRepositoryLocation} from floating main.`],
    ['relative documentation link', '[Architecture](docs/architecture.md)'],
    ['ordinary web documentation link', '[API documentation](https://openai.com/docs)'],
    ['ordinary GitHub documentation link', '[Repository guide](https://github.com/abssoft/dreamteam/blob/main/README.md)'],
    ['application route prose', 'Open /settings/profile to edit the account.'],
    ['root-relative Markdown link', '[API reference](/api/reference)'],
    ['relative repository path', '`src/example.js` and `docs/architecture.md`'],
    ['opaque refs', 'workspace-a7f2 revision-b91c revision-a83d'],
  ];

  for (const [label, source] of safeSources) {
    assert.deepEqual(findSerializedCoordinates(source), [], label);
  }
});
