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
      content: { verdict: 'Нужна правка B1', path: '/tmp/x/result-review-eval.json', coverage: [{ item: 'a', status: 'reviewed' }] },
    },
    verification: [{ command: 'npm test', status: 'failed', evidence: 'один тест красный' }],
    findings: [{ id: 'B1', severity: 'P1', category: 'correctness', path: 'src/a.js', line: 1, problem: 'x', impact: 'wrong result', fix: 'correct bound', evidence: 'src/a.js:1', confidence: 'confirmed', failure_scenario: 'two items skip the last' }],
    required_fixes: ['B1: починить цикл'],
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
      deliverable: { kind: 'review_report', content: { path: '/tmp/x/result-review-eval.json', verdict: 'Нужна правка B1' } },
      verification: [{ command: 'npm test', status: 'failed' }],
      required_fixes: ['B1'],
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
  assert.deepEqual(resultProblems(review({ required_fixes: [] })), ['done with a failed verification item (npm test) and no required fix', 'B1: confirmed P1 requires a fix']);
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

test('required fixes reference evidence-backed findings and critical findings have a scenario', () => {
  assert.ok(resultProblems(review({ required_fixes: ['B404: missing'] })).some((problem) => problem.includes('has no finding')));
  const finding = review().findings[0];
  assert.ok(resultProblems(review({ findings: [{ ...finding, evidence: '' }] })).some((problem) => problem.includes('evidence missing')));
  assert.ok(resultProblems(review({ findings: [{ ...finding, failure_scenario: '' }] })).some((problem) => problem.includes('failure scenario')));
  assert.ok(resultProblems(review({ findings: [{ ...finding, confidence: 'plausible' }] })).some((problem) => problem.includes('must be a confirmed')));
});

test('a refuted finding stays for audit, asks for no fix and cannot be required', () => {
  const refuted = { id: 'B2', severity: 'P1', category: 'correctness', path: 'src/a.js', line: 2, problem: 'y', impact: 'lost row', fix: 'guard', evidence: 'src/a.js:2', confidence: 'confirmed', failure_scenario: 'empty list', status: 'refuted', verdict_reason: 'the caller filters empty lists' };
  const base = review();
  assert.deepEqual(resultProblems({ ...base, findings: [...base.findings, refuted] }), []);
  assert.ok(resultProblems({ ...base, findings: [...base.findings, refuted], required_fixes: [...base.required_fixes, 'B2: guard'] })
    .includes('required fix B2 must be a confirmed P0/P1/P2 finding the sceptic did not refute'));
});

test('a done review carries no standing plausible P0/P1 outside the gate', () => {
  const plausible = { ...review().findings[0], confidence: 'plausible' };
  const result = (finding, overrides = {}) => review({ findings: [finding], required_fixes: [], verification: [{ command: 'npm test', status: 'passed', evidence: 'зелёный' }], ...overrides });
  assert.deepEqual(resultProblems(result(plausible)), ['B1: done with a standing plausible P1 — confirm it, re-weigh its severity, refute it or return needs_human']);
  assert.deepEqual(resultProblems(result({ ...plausible, category: 'verification/broken' })), [], 'a gate finding rests on the QA result');
  assert.deepEqual(resultProblems(result({ ...plausible, status: 'refuted' })), []);
  assert.deepEqual(resultProblems(result({ ...plausible, severity: 'P2' })), []);
  assert.deepEqual(resultProblems(result(plausible, { status: 'needs_human', blocker: 'открытый вопрос' })), []);
});
