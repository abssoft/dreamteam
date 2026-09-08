import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packetProblems } from '../contracts/validate-assignment.mjs';

const scriptPath = join(process.cwd(), 'contracts', 'validate-assignment.mjs');

function packet(overrides = {}) {
  return {
    contract_version: 1,
    assignment_id: 'assignment-validate-eval',
    role: 'code-reviewer',
    objective: 'Review the change',
    scope: { included: ['the change'], excluded: ['everything else'] },
    repository: { base_ref: 'main' },
    source_materials: [{ kind: 'text', name: 'issue', content: 'Sum the totals.', provenance: 'tracker issue text' }],
    ...overrides,
  };
}

function run(input, args = ['--assignment', '-']) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  });
  return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').pop()) };
}

test('a well-formed packet passes and lists its materials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-assignment-'));
  const issue = join(dir, 'issue.md');
  await writeFile(issue, '# KEY Title\nSum the totals.\n');
  const good = run(packet({
    source_materials: [{ kind: 'attachment_reference', name: 'issue', content: issue, provenance: 'текст задачи из трекера' }],
  }));
  assert.equal(good.code, 0);
  assert.deepEqual(good.json, {
    ok: true, role: 'code-reviewer', assignment_id: 'assignment-validate-eval',
    materials: [{ name: 'issue', kind: 'attachment_reference', path: issue }],
  });

  const file = join(dir, 'packet.json');
  await writeFile(file, JSON.stringify(packet()));
  assert.equal(run('', ['--assignment', file]).json.ok, true);
});

test('shape problems are all listed at once', () => {
  const bad = run(packet({
    role: 'product-technologist',
    extra_field: 1,
    accepted_decisions: 'bare string',
    scope: { included: 'x' },
    source_materials: [{ name: 'issue', content: 'x', provenance: 'y', surprise: true }, 'nope'],
  }));
  assert.equal(bad.code, 1);
  assert.equal(bad.json.code, 'bad_packet');
  assert.deepEqual(bad.json.detail, [
    'unknown field extra_field',
    'role must be software-developer | code-reviewer, got "product-technologist"',
    'scope.included and scope.excluded must be arrays',
    'accepted_decisions must be an array of strings',
    'source_materials[0] (issue): kind must be text | repository_evidence | attachment_reference',
    'source_materials[0] (issue): unknown field surprise',
    'source_materials[1] (unnamed) must be an object',
  ]);
});

test('role rules: the reviewer needs base_ref, both roles need an issue material', () => {
  assert.deepEqual(packetProblems(packet({ repository: {} })), ['repository.base_ref missing (code-reviewer)']);
  assert.deepEqual(packetProblems(packet({ role: 'software-developer', repository: {} })), []);
  assert.deepEqual(packetProblems(packet({ source_materials: [] })), ['source_materials entry named issue missing']);
  assert.deepEqual(packetProblems(packet({ source_materials: undefined })), ['source_materials entry named issue missing']);
});

test('file materials must exist; issue and parent_issue files must be non-empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-assignment-'));
  const empty = join(dir, 'issue.md');
  await writeFile(empty, '');
  const shot = join(dir, 'shot.png');
  await writeFile(shot, 'png');
  const problems = packetProblems(packet({
    source_materials: [
      { kind: 'attachment_reference', name: 'issue', content: empty, provenance: 'p' },
      { kind: 'attachment_reference', name: 'parent_issue', content: join(dir, 'missing.md'), provenance: 'p' },
      { kind: 'attachment_reference', name: 'shot.png', content: shot, provenance: 'p' },
      { kind: 'attachment_reference', name: 'relative.png', content: 'relative/path.png', provenance: 'p' },
    ],
  }));
  assert.deepEqual(problems, [
    `source_materials[0] (issue): empty file: ${empty}`,
    `source_materials[1] (parent_issue): file not found: ${join(dir, 'missing.md')}`,
    'source_materials[3] (relative.png): attachment_reference content must be an absolute path',
  ]);
});

test('malformed input is bad_args', () => {
  assert.equal(run('not json').json.code, 'bad_args');
  assert.equal(run('{}', []).json.code, 'bad_args');
});
