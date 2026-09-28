import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultProblems } from '../contracts/validate-result.mjs';
import { changedLineMap } from '../skills/code-reviewer/scripts/review-findings.mjs';

const scripts = join(process.cwd(), 'skills', 'code-reviewer', 'scripts');
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (dir, message) => { sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', message]); };
const hasLsd = (directory) => { try { accessSync(join(directory, 'lsd'), constants.X_OK); return true; } catch { return false; } };
const env = { ...process.env, PATH: process.env.PATH.split(':').filter((directory) => !hasLsd(directory)).join(':') };

const ISSUE = `Totals must sum amounts. ${'The order total is the sum of every line amount; an empty order sums to zero. '.repeat(5)}`;
const qa = (checks) => ({ kind: 'text', name: 'qa_result', provenance: 'QA', content: JSON.stringify({ kind: 'qa_result', verdict: 'green', checks }) });
const PASSED = [{ id: 'c1', command: 'npm test', width: 'full', status: 'passed' }];

async function review(id, { checks = PASSED, previous = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'review-findings-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'fixture@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'Fixture']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), '# Rules\n- keep changes bounded\n');
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\nexport const legacy = 1;\n');
  commit(dir, 'base');
  sh(dir, 'git', ['checkout', '-qb', 'task']);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n// sums\nexport const count = (items) => items.length;\n');
  commit(dir, 'sum amounts');
  const packet = {
    contract_version: 1, assignment_id: id, role: 'code-reviewer', objective: 'review', scope: { included: ['src'] },
    repository: { base_ref: 'main' },
    source_materials: [{ kind: 'text', name: 'issue', content: ISSUE, provenance: 'issue' }, qa(checks), ...(previous ? [previous] : [])],
  };
  const pack = spawnSync(process.execPath, [join(scripts, 'review-pack.mjs'), '--assignment', '-', '--skip=rules,docs,runtime,tooling'], { cwd: dir, input: JSON.stringify(packet), encoding: 'utf8', env });
  const json = JSON.parse(pack.stdout.trim().split('\n').pop());
  assert.equal(json.ok, true, pack.stdout);
  const call = (...args) => {
    const result = spawnSync(process.execPath, [join(scripts, 'review-findings.mjs'), '--manifest', json.review_manifest, ...args], { cwd: dir, encoding: 'utf8', env });
    return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').pop()) };
  };
  return { dir, json, call };
}

const FINDING = ['--phase', 'behavior', '--severity', 'P1', '--category', 'correctness', '--file', 'src/totals.js', '--line', '1', '--problem', 'Пустой item.amount даёт NaN.', '--impact', 'Итог заказа становится NaN.', '--fix', 'Считать отсутствующую сумму нулём.', '--related', 'src/totals.js:1', '--scenario', 'Строка без amount: ожидается 0, получается NaN.', '--confidence', 'confirmed'];
const closePhases = (call) => {
  for (const name of ['behavior', 'rules', 'quality', 'comments', 'sceptic']) assert.equal(call('phase', '--name', name, '--status', 'done').code, 0);
};

test('changed lines per file come from the zero-context diff, both sides', () => {
  const map = changedLineMap([
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -2,2 +2,3 @@', '-old', '-old2', '+new', '+new2', '+new3',
    'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
  ].join('\n'));
  assert.deepEqual([...map.get('a.js').added], [2, 3, 4]);
  assert.deepEqual([...map.get('a.js').deleted], [2, 3]);
  assert.deepEqual([...map.get('gone.js').deleted], [1, 2]);
});

test('a finding is anchored to changed lines, rests on evidence and names one consequence', async () => {
  const { call } = await review('review-anchor');
  const outside = call('finding', ...FINDING.map((arg) => (arg === 'src/totals.js' ? 'src/other.js' : arg)));
  assert.equal(outside.code, 1);
  assert.match(outside.json.refused, /src\/other\.js is not among the lines this change added; code outside the change goes into --related/);
  const unchanged = call('finding', ...FINDING.slice(0, 8), '--line', '9', ...FINDING.slice(10));
  assert.match(unchanged.json.refused, /line 9 of src\/totals\.js was not changed by this change — changed lines: 1-3/);
  const noScenario = FINDING.slice(0, FINDING.indexOf('--scenario')).concat('--confidence', 'confirmed');
  assert.match(call('finding', ...noScenario).json.refused, /--scenario is required at P1/);
  const restated = call('finding', ...FINDING.map((arg) => (arg === 'Итог заказа становится NaN.' ? 'Пустой item.amount даёт NaN.' : arg)));
  assert.match(restated.json.refused, /--impact restates --problem/);
  assert.match(call('finding', ...FINDING.map((arg) => (arg === 'src/totals.js:1' ? 'see above' : arg))).json.refused, /--related is required/);
  const deleted = call('finding', ...FINDING.slice(0, 8), '--line', '2', '--deleted', ...FINDING.slice(10));
  assert.equal(deleted.json.ok, true, JSON.stringify(deleted.json));
  assert.equal(call('finding', ...FINDING).json.id, 'B2');
});

test('summary refuses gaps, then writes a Result the contract accepts and prints its envelope', async () => {
  const { call, json } = await review('review-summary');
  assert.equal(call('finding', ...FINDING).json.id, 'B1');
  const quality = call('finding', '--phase', 'quality', '--severity', 'P2', '--category', 'design', '--file', 'src/totals.js', '--line', '3', '--problem', 'count дублирует length.', '--impact', 'Два имени одного значения.', '--fix', 'Убрать count.', '--related', 'src/totals.js:3', '--confidence', 'confirmed', '--optional', 'Критерии приёмки не затронуты.');
  assert.equal(quality.json.id, 'Q1');
  const refuted = call('finding', ...FINDING.map((arg) => (arg === '1' ? '2' : arg)));
  assert.equal(refuted.json.id, 'B2');

  const early = call('summary', '--status', 'done', '--summary', 'Готово.', '--verdict', 'Нужна правка B1.');
  assert.equal(early.code, 1);
  assert.match(early.json.refused, /uncovered files: src\/totals\.js; phases not closed: behavior, rules, quality, comments, sceptic; findings without a sceptic verdict: B1, Q1, B2/);

  assert.equal(call('covered', '--item', 'src/totals.js', '--status', 'reviewed', '--evidence', 'все ханки прочитаны').code, 0);
  closePhases(call);
  const batch = call('batch', '--json', JSON.stringify([
    { type: 'verdict', id: 'B1', holds: true, reason: 'src/totals.js:1 без проверки amount' },
    { type: 'verdict', id: 'Q1', holds: true, reason: 'count не используется' },
    { type: 'verdict', id: 'B2', refuted: true, reason: 'строка 2 — комментарий, не вычисление' },
    { type: 'verdict', id: 'X9', holds: true, reason: 'нет такой' },
  ]));
  assert.equal(batch.code, 1);
  assert.deepEqual(batch.json.refused, [{ index: 3, type: 'verdict', refused: 'no finding X9; list prints the IDs' }]);
  assert.equal(batch.json.recorded.length, 3);

  const done = call('summary', '--status', 'done', '--summary', 'Ревью завершено: одна правка.', '--verdict', 'Нужна правка B1.');
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.deepEqual(done.json.required_fixes, ['B1']);
  assert.equal(done.json.deliverable.content.path, JSON.parse(await readFile(json.review_manifest, 'utf8')).result);
  const result = JSON.parse(await readFile(done.json.deliverable.content.path, 'utf8'));
  assert.deepEqual(resultProblems(result), []);
  assert.deepEqual(result.required_fixes, ['B1: Пустой item.amount даёт NaN. — Считать отсутствующую сумму нулём.']);
  assert.equal(result.findings.find((item) => item.id === 'B2').status, 'refuted');
  assert.equal(result.deliverable.content.review_complete, true);
  assert.deepEqual(result.verification, [{ command: 'npm test', status: 'passed', evidence: 'по результату QA: full', width: 'full' }]);
});

test('a failed gate check becomes a gate finding; the sceptic may move severity with a reason', async () => {
  const { call } = await review('review-gate', { checks: [{ id: 'c1', command: 'npm test', status: 'failed', width: 'full' }, { id: 'c2', command: 'lint', status: 'passed' }] });
  assert.match(call('finding', '--phase', 'gate', '--check', 'c2', '--severity', 'P1', '--category', 'verification/failed', '--problem', 'a', '--impact', 'b', '--fix', 'c', '--related', 'src/totals.js:1', '--scenario', 'd', '--confidence', 'confirmed').json.refused, /check c2 is passed/);
  const gate = call('finding', '--phase', 'gate', '--check', 'c1', '--severity', 'P1', '--category', 'verification/failed', '--problem', 'Тест итога падает.', '--impact', 'Итог неверен.', '--fix', 'Суммировать amount.', '--related', 'src/totals.js:1', '--scenario', 'npm test: ожидалось 20, получено 2.', '--confidence', 'confirmed');
  assert.equal(gate.json.id, 'G1', JSON.stringify(gate.json));
  const quality = call('finding', '--phase', 'quality', '--severity', 'P3', '--category', 'design', '--file', 'src/totals.js', '--line', '3', '--problem', 'count лишний.', '--impact', 'Лишнее имя.', '--fix', 'Убрать.', '--related', 'src/totals.js:3', '--confidence', 'confirmed');
  assert.match(call('verdict', '--id', quality.json.id, '--holds', '--reason', 'r', '--severity', 'P1').json.refused, /needs its failure scenario first/);
  assert.equal(call('verdict', '--id', quality.json.id, '--holds', '--reason', 'дубль ломает API', '--severity', 'P2').json.severity, 'P2');
  call('verdict', '--id', 'G1', '--holds', '--reason', 'хвост лога');
  call('covered', '--item', 'src/totals.js', '--status', 'reviewed', '--evidence', 'прочитан');
  closePhases(call);
  const done = call('summary', '--status', 'done', '--summary', 's', '--verdict', 'v');
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.deepEqual(done.json.required_fixes, ['G1', 'Q1']);
  const result = JSON.parse(await readFile(done.json.deliverable.content.path, 'utf8'));
  assert.equal(result.findings.find((item) => item.id === 'Q1').severity_from, 'P3');
});

test('a repeat review resolves every previous fix, keeps an open one under its ID and requires only P0/P1', async () => {
  const previous = { kind: 'text', name: 'previous_review', provenance: 'previous review', content: JSON.stringify({ role: 'code-reviewer', findings: [{ id: 'B1' }, { id: 'Q1' }], required_fixes: ['B1: sum amounts', 'Q1: drop count'] }) };
  const { call } = await review('review-repeat', { previous });
  assert.equal(call('resolve', '--id', 'Q1', '--status', 'resolved', '--evidence', 'count удалён').code, 0);
  assert.match(call('resolve', '--id', 'Z1', '--status', 'resolved', '--evidence', 'x').json.refused, /previous required fix: B1, Q1/);
  assert.equal(call('resolve', '--id', 'B1', '--status', 'unresolved', '--evidence', 'amount всё ещё без нуля').json.next, 'record the open defect with finding --reopens B1');
  const p2 = call('finding', '--phase', 'quality', '--severity', 'P2', '--category', 'design', '--file', 'src/totals.js', '--line', '3', '--problem', 'count лишний.', '--impact', 'Лишнее имя.', '--fix', 'Убрать.', '--related', 'src/totals.js:3', '--confidence', 'confirmed');
  assert.equal(p2.json.id, 'Q2', 'new IDs never reuse a previous one');
  call('covered', '--item', 'src/totals.js', '--status', 'reviewed', '--evidence', 'прочитан');
  closePhases(call);
  call('verdict', '--id', 'Q2', '--holds', '--reason', 'r');
  assert.match(call('summary', '--status', 'done', '--summary', 's', '--verdict', 'v').json.refused, /unresolved previous fixes without a finding --reopens: B1/);
  assert.equal(call('finding', ...FINDING, '--reopens', 'B1').json.id, 'B1');
  call('verdict', '--id', 'B1', '--holds', '--reason', 'r');
  const done = call('summary', '--status', 'done', '--summary', 's', '--verdict', 'v');
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.deepEqual(done.json.required_fixes, ['B1']);
});

test('a blocked summary needs its cause and keeps what was established', async () => {
  const { call } = await review('review-blocked');
  call('finding', ...FINDING);
  assert.match(call('summary', '--status', 'blocked', '--summary', 's', '--verdict', 'v').json.refused, /--blocker is required for blocked/);
  const blocked = call('summary', '--status', 'blocked', '--summary', 'Ревью не завершено.', '--verdict', 'Покрытие неполное.', '--blocker', 'контекст исчерпан на src/totals.js');
  assert.equal(blocked.code, 0, JSON.stringify(blocked.json));
  const result = JSON.parse(await readFile(blocked.json.deliverable.content.path, 'utf8'));
  assert.equal(result.deliverable.content.review_complete, false);
  assert.equal(result.findings[0].status, 'unjudged');
});
