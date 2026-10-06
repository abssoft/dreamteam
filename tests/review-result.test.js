import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopeOf, reviewProblems } from '../skills/code-reviewer/scripts/review-result.mjs';

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

test('a review envelope is slim: no findings, self-contained fixes, verification statuses, decision content', () => {
  assert.deepEqual(envelopeOf(review()), {
    contract_version: 1,
    assignment_id: 'review-eval',
    role: 'code-reviewer',
    status: 'done',
    summary: 'Ревью завершено: одна правка.',
    deliverable: { kind: 'review_report', content: { path: '/tmp/x/result-review-eval.json', verdict: 'Нужна правка B1' } },
    verification: [{ command: 'npm test', status: 'failed' }],
    required_fixes: ['B1: починить цикл'],
  });
});

test('a done review with a failed gate item needs a required fix', () => {
  assert.deepEqual(reviewProblems(review()), []);
  assert.deepEqual(reviewProblems(review({ required_fixes: [] })), ['done with a failed verification item (npm test) and no required fix', 'B1: confirmed P1 requires a fix']);
  assert.deepEqual(reviewProblems(review({ status: 'blocked', blocker: 'b', required_fixes: [] })), [], 'only a done review is held to the invariants');
});

test('required fixes reference evidence-backed findings and critical findings have a scenario', () => {
  assert.ok(reviewProblems(review({ required_fixes: ['B404: missing'] })).some((problem) => problem.includes('has no finding')));
  const finding = review().findings[0];
  assert.ok(reviewProblems(review({ findings: [{ ...finding, evidence: '' }] })).some((problem) => problem.includes('evidence missing')));
  assert.ok(reviewProblems(review({ findings: [{ ...finding, failure_scenario: '' }] })).some((problem) => problem.includes('failure scenario')));
  assert.ok(reviewProblems(review({ findings: [{ ...finding, confidence: 'plausible' }] })).some((problem) => problem.includes('must be a confirmed')));
});

test('a refuted finding stays for audit, asks for no fix and cannot be required', () => {
  const refuted = { id: 'B2', severity: 'P1', category: 'correctness', path: 'src/a.js', line: 2, problem: 'y', impact: 'lost row', fix: 'guard', evidence: 'src/a.js:2', confidence: 'confirmed', failure_scenario: 'empty list', status: 'refuted', verdict_reason: 'the caller filters empty lists' };
  const base = review();
  assert.deepEqual(reviewProblems({ ...base, findings: [...base.findings, refuted] }), []);
  assert.ok(reviewProblems({ ...base, findings: [...base.findings, refuted], required_fixes: [...base.required_fixes, 'B2: guard'] })
    .includes('required fix B2 must be a confirmed P0/P1/P2 finding the sceptic did not refute'));
});

test('a done review carries no standing plausible P0/P1 outside the gate', () => {
  const plausible = { ...review().findings[0], confidence: 'plausible' };
  const result = (finding, overrides = {}) => review({ findings: [finding], required_fixes: [], verification: [{ command: 'npm test', status: 'passed', evidence: 'зелёный' }], ...overrides });
  assert.deepEqual(reviewProblems(result(plausible)), ['B1: done with a standing plausible P1 — confirm it, re-weigh its severity, refute it or return needs_human']);
  assert.deepEqual(reviewProblems(result({ ...plausible, category: 'verification/broken' })), [], 'a gate finding rests on the QA result');
  assert.deepEqual(reviewProblems(result({ ...plausible, status: 'refuted' })), []);
  assert.deepEqual(reviewProblems(result({ ...plausible, severity: 'P2' })), []);
  assert.deepEqual(reviewProblems(result(plausible, { status: 'needs_human', blocker: 'открытый вопрос' })), []);
});
