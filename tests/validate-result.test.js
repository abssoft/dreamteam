import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelopeOf, resultProblems } from '../contracts/validate-result.mjs';

const scriptPath = join(process.cwd(), 'contracts', 'validate-result.mjs');

function review(overrides = {}) {
  return {
    contract_version: 1,
    assignment_id: 'review-eval',
    role: 'code-reviewer',
    status: 'done',
    summary: 'Ревью завершено: одна правка.',
    deliverable: {
      kind: 'review_report',
      content: { verdict: 'Нужна правка B1', lenses_mode: 'children', path: '/tmp/x/result-review-eval.json', coverage: [{ item: 'a', status: 'reviewed' }] },
    },
    verification: [{ command: 'npm test', status: 'failed', evidence: 'один тест красный' }],
    findings: [{ id: 'B1', severity: 'P1', problem: 'x' }],
    required_fixes: ['B1: починить цикл', 'починить без идентификатора'],
    ...overrides,
  };
}

function run(input, args = ['--result', '-']) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  });
  return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').pop()) };
}

test('a valid review result yields its envelope: no findings, fix IDs, verification statuses, decision content', () => {
  const ok = run(review(), ['--result', '-', '--expect-id', 'review-eval', '--expect-role', 'code-reviewer']);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json, {
    ok: true,
    envelope: {
      contract_version: 1,
      assignment_id: 'review-eval',
      role: 'code-reviewer',
      status: 'done',
      summary: 'Ревью завершено: одна правка.',
      deliverable: { kind: 'review_report', content: { path: '/tmp/x/result-review-eval.json', verdict: 'Нужна правка B1', lenses_mode: 'children' } },
      verification: [{ command: 'npm test', status: 'failed' }],
      required_fixes: ['B1', 'починить без идентификатора'],
      findings: [{ count: 1 }],
    },
  });
});

test('problems are listed at once, identity mismatches included', () => {
  const bad = run(review({
    role: 'software-developer',
    status: 'shipped',
    changed_paths: ['a.js'],
    verification: [{ command: 'npm test', status: 'green' }, 'nope'],
    required_fixes: 'B1',
    extra: 1,
  }), ['--result', '-', '--expect-id', 'other']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.code, 'bad_result');
  assert.deepEqual(bad.json.detail, [
    'unknown field extra',
    'assignment_id "review-eval" does not match the launched "other"',
    'status must be done | blocked | needs_human | failed',
    'deliverable.kind must be implementation_summary for software-developer, got "review_report"',
    'verification[0] (npm test): status must be passed | failed | skipped | broken',
    'verification[1] must be {command, status, evidence}',
    'required_fixes must be an array of strings',
  ]);
});

test('done gates: evidence required; a failed item needs a required fix (review) or fails the developer', () => {
  assert.deepEqual(resultProblems(review({ verification: [] })), ['done requires verification evidence']);
  assert.deepEqual(resultProblems(review({ required_fixes: [] })), ['done with a failed verification item (npm test) and no required fix']);
  assert.deepEqual(resultProblems(review({ changed_paths: ['x'] })), ['changed_paths must be empty for code-reviewer']);
  const developer = {
    contract_version: 1, assignment_id: 'dev-eval', role: 'software-developer', status: 'done', summary: 'ok',
    deliverable: { kind: 'implementation_summary', content: { behavior: 'сделано', why: 'потому', coverage: [] } },
    changed_paths: ['src/a.js'], verification: [{ command: 'npm test', status: 'failed', evidence: 'red' }],
  };
  assert.deepEqual(resultProblems(developer), ['done with a failed verification item (npm test)']);
  developer.verification[0].status = 'passed';
  assert.deepEqual(resultProblems(developer), []);
  assert.deepEqual(envelopeOf(developer).deliverable.content, { behavior: 'сделано', why: 'потому' });
  assert.deepEqual(envelopeOf(developer).changed_paths, ['src/a.js']);
  assert.equal(resultProblems({ ...developer, status: 'blocked', verification: [] }).length, 0, 'blocked needs no evidence');
});

test('reads a file and rejects malformed input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-result-'));
  const file = join(dir, 'result.json');
  await writeFile(file, JSON.stringify(review()));
  assert.equal(run('', ['--result', file]).json.ok, true);
  assert.equal(run('not json').json.code, 'bad_args');
  assert.equal(run('{}', ['--nope']).json.code, 'bad_args');
});
