import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('all tracked public contract, documentation, skill, and manifest sources contain no coordinates', () => {
  const violations = publicContractFiles.flatMap((relative) => {
    const findings = findSerializedCoordinates(fs.readFileSync(path.join(root, relative), 'utf8'));
    return findings.map((finding) => `${relative}: ${finding}`);
  });
  assert.deepEqual(violations, []);
});

test('public coordinate detector rejects generic leaked literals', () => {
  const leaks = [
    ['POSIX user path', 'workspace: "/Users/alice/work/repo"'],
    ['POSIX home path', 'workspace: "/home/alice/work/repo"'],
    ['generic structured POSIX path', 'workspace: "/projects/acme/repo"'],
    ['arbitrary-key unquoted POSIX path', 'artifact: /projects/acme/repo'],
    ['Windows path', String.raw`workspace: "C:\work\repo"`],
    ['Windows slash path', 'workspace: "C:/work/repo"'],
    ['Windows drive-relative path', 'workspace: "C:work\\repo"'],
    ['UNC path', String.raw`workspace: "\\server\share\repo"`],
    ['parent traversal', 'path: "../outside/repo"'],
    ['repository URL', 'repository_url: "https://github.com/acme/private-repo.git"'],
    ['repository https', 'repository: "https://github.com/acme/private-repo.git"'],
    ['canonical-prefix malicious HTTPS', 'repository: "https://github.com/abssoft/dreamteam.git.evil/private.git"'],
    ['canonical-prefix malicious SSH', 'repository: "git@github.com:abssoft/dreamteam.git.evil/private.git"'],
    ['repository git URL', 'repository=git://example.com/private-repo.git'],
    ['location http URL', 'location=http://example.com/private-repo.git'],
    ['origin ssh', 'origin: "ssh://git@example.com/private-repo.git"'],
    ['source https', 'source: "https://github.com/acme/private-repo.git"'],
    ['source file URL', 'source=file:///private/private-repo.git'],
    ['raw 40-hex revision', 'revision: "0123456789abcdef0123456789abcdef01234567"'],
    ['raw 64-hex revision', 'revision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"'],
    ['branch field', 'branch: "feature/example"'],
    ['branch ref', 'revision: "refs/heads/main"'],
    ['tracker assignment', 'assignment_id: "DEV-204:development:1"'],
    ['assignment_id A-1', 'assignment_id: "A-1"'],
    ['issue_id PROJ-1', 'issue_id: "PROJ-1"'],
    ['prose PROJ-1', 'Complete PROJ-1 before release.'],
    ['origin POSIX path', 'origin: "/projects/acme/repo"'],
  ];

  const missed = leaks
    .filter(([, source]) => findSerializedCoordinates(source).length === 0)
    .map(([label]) => label);
  assert.deepEqual(missed, []);
});

test('public coordinate detector allows approved locations and documentation syntax', () => {
  const safeSources = [
    ['approved SSH install URI', `repository: "${allowedRepositoryLocations[0]}"`],
    ['canonical HTTPS install URI', `repository: "${allowedRepositoryLocations[1]}"`],
    ['relative documentation link', '[Architecture](docs/architecture.md)'],
    ['ordinary web documentation link', '[API documentation](https://openai.com/docs)'],
    ['ordinary GitHub documentation link', '[Repository guide](https://github.com/abssoft/dreamteam/blob/main/README.md)'],
    ['SPDX license identifier', 'Licensed under Apache-2.0.'],
    ['schema regex range', 'pattern: "^[a-z0-9-]+$"'],
    ['escaped model version', String.raw`assert.doesNotMatch(text, /gpt-5\.6-sol/);`],
    ['application route prose', 'Open /settings/profile to edit the account.'],
    ['root-relative Markdown link', '[API reference](/api/reference)'],
    ['relative repository path', '`src/example.js` and `docs/architecture.md`'],
    ['opaque refs', 'workspace-a7f2 revision-b91c revision-a83d'],
  ];

  for (const [label, source] of safeSources) {
    assert.deepEqual(findSerializedCoordinates(source), [], label);
  }
});
