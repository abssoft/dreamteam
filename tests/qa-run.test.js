import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attribute, deriveChecks, executedTestPaths, skippedCases, skippedCount } from '../skills/qa-engineer/scripts/qa-run.mjs';

const scriptPath = join(process.cwd(), 'skills', 'qa-engineer', 'scripts', 'qa-run.mjs');

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (dir, message) => { sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', message]); };

function run(dir, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: dir, encoding: 'utf8' });
  const line = result.stdout.trim().split('\n').pop();
  return { code: result.status, json: line ? JSON.parse(line) : null, stderr: result.stderr };
}

// A node project whose scripts resolve to stand-ins: eslint fails on the
// changed file, vitest passes, and the lint:fix script would rewrite files.
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'qa-run-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'fixture@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'Fixture']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\necho "$PWD/src/totals.js: 1:1 error no-unused-vars"\nexit 1\n');
  await writeFile(join(dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\necho "vitest $*"\n');
  await chmod(join(dir, 'node_modules', '.bin', 'eslint'), 0o755);
  await chmod(join(dir, 'node_modules', '.bin', 'vitest'), 0o755);
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
  await writeFile(join(dir, 'package-lock.json'), '{}');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix', test: 'vitest run' } }));
  await writeFile(join(dir, 'AGENTS.md'), '# Rules\n- tests run through the container, see docs/gate.md\n');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs', 'gate.md'), '# Gate\nRun `npm run lint` and `npm test` inside the php service.\n');
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\n');
  await writeFile(join(dir, 'README.md'), '# Fixture\n');
  commit(dir, 'base');
  sh(dir, 'git', ['checkout', '-qb', 'task']);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  await writeFile(join(dir, 'src', 'totals.test.js'), 'test("sums", () => {});\n');
  await writeFile(join(dir, 'src', 'style.php'), '<?php\n');
  commit(dir, 'sum amounts');
  return dir;
}

test('--usage prints the contract; bad arguments are refused', () => {
  const usage = spawnSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' }).stdout;
  assert.ok(usage.startsWith('qa-run.mjs — '));
  assert.equal(run(process.cwd(), []).json.code, 'bad_args');
  assert.equal(run(process.cwd(), ['--plan']).json.code, 'bad_args');
  assert.equal(run(process.cwd(), ['--run']).json.code, 'bad_args');
});

test('deriveChecks fills paths of the tool\'s language, refuses rewrites and runs identical commands once', () => {
  const env = { validation: { checks: [
    { tool: 'eslint', lang: 'node', source: 'npm run lint', scope: 'paths', command: 'npx eslint {paths}' },
    { tool: 'eslint', lang: 'node', source: 'npm run lint:all', scope: 'paths', command: 'npx eslint {paths}' },
    { tool: 'rector', lang: 'php', source: 'composer rector', scope: 'paths', command: 'vendor/bin/rector process --dry-run {paths}' },
    { tool: 'phpunit', lang: 'php', source: 'composer test', scope: 'tests-by-path', command: 'vendor/bin/phpunit {test paths}' },
    { tool: 'prettier', lang: 'node', source: 'npm run format', scope: 'paths', command: 'npx prettier --write {paths}' },
    { tool: 'phpstan', lang: 'php', source: 'composer phpstan', scope: 'none', command: 'composer phpstan', run: 'vendor/bin/phpstan analyse' },
  ] } };
  const items = deriveChecks(env, ['src/a.js', 'src/b.php', 'docs/x.md'], ['src/a.test.js']);
  assert.deepEqual(items.map((item) => [item.id, item.command, item.width, item.runnable, item.reason ?? null]), [
    ['c1', 'npx eslint src/a.js', 'narrowed to the change', true, null],
    ['c2', 'vendor/bin/rector process --dry-run src/b.php', 'narrowed to the change', true, null],
    ['c3', 'vendor/bin/phpunit {test paths}', 'not run', false, 'the change carries no test path this tool reads (php)'],
    ['c4', 'npx prettier --write {paths}', 'not run', false, 'rewrites files: not a check'],
    ['c5', 'composer phpstan', 'full', true, null],
  ]);
});

test('attribute names the change from the output paths, or from a narrowed width', () => {
  const changed = ['src/totals.js', 'src/other.js'];
  assert.equal(attribute({ status: 'passed' }, changed), null);
  assert.equal(attribute({ status: 'failed', width: 'narrowed to the change', tail: '' }, changed), 'in_change');
  assert.equal(attribute({ status: 'failed', width: 'full', tail: '/abs/repo/src/totals.js:3:1 error' }, changed), 'in_change');
  assert.equal(attribute({ status: 'failed', width: 'full', tail: 'Line  lib/legacy.php\n  12  Call to undefined method' }, changed), 'outside_change');
  assert.equal(attribute({ status: 'failed', width: 'full', tail: 'Error: something broke' }, changed), 'unknown');
  // An empty run is broken, so a narrowed width never blames the change for it.
  assert.equal(attribute({ status: 'broken', width: 'narrowed to the change', tail: 'No tests found, exiting with code 1' }, changed), null);
});

test('skips are read from JUnit for the selected files, else from the runner\'s summary line', () => {
  const junit = '<testsuite><testcase name="testSums" file="/repo/tests/TotalsTest.php"/>'
    + '<testcase name="testRounds &quot;half&quot;" file="/repo/tests/TotalsTest.php"><skipped/></testcase>'
    + '<testcase name="testOther" file="/repo/tests/OtherTest.php"><skipped/></testcase></testsuite>';
  assert.deepEqual(skippedCases(junit, ['tests/TotalsTest.php']), [{ file: 'tests/TotalsTest.php', name: 'testRounds "half"' }]);
  assert.deepEqual(skippedCases('OK (2 tests)', ['tests/TotalsTest.php']), []);
  // The tests line wins over the files line; colour codes do not hide it.
  assert.equal(skippedCount(' Test Files  1 passed | 1 skipped (2)\n      Tests  4 passed | 3 skipped (7)\n'), 3);
  assert.equal(skippedCount('\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m6 skipped\x1b[39m\x1b[90m (7)\x1b[39m'), 6);
  assert.equal(skippedCount('Test Suites: 1 skipped, 1 passed, 1 of 2 total\nTests:       2 skipped, 5 passed, 7 total\n'), 2);
  assert.equal(skippedCount('==== 6 passed, 4 skipped in 0.12s ====\n'), 4);
  assert.equal(skippedCount('OK, but some tests were skipped!\nTests: 9, Assertions: 12, Skipped: 5.\n'), 5);
  assert.equal(skippedCount('ℹ tests 2\nℹ pass 1\nℹ skipped 1\nℹ todo 0\n'), 1);
  assert.equal(skippedCount('ℹ tests 2\nℹ pass 2\nℹ skipped 0\n'), 0);
  assert.equal(skippedCount('      Tests  7 passed (7)\n'), 0);
  assert.equal(skippedCount(null), 0);
});

test('--report carries the skips into the result and leaves every status as it was', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-report-'));
  const item = (id, tail) => ({ id, tool: 'tests', command: `run ${id}`, ran: `run ${id}`, scope: 'none', width: 'full', source: 'fixture', status: 'passed', exit: 0, seconds: 0.1, log: join(dir, `${id}.log`), tail });
  await writeFile(join(dir, 'c1.log'), '<testsuite><testcase name="testSums" file="/repo/tests/TotalsTest.php"/>'
    + '<testcase name="testRounds" file="/repo/tests/TotalsTest.php"><skipped/></testcase>'
    + '<testcase name="testOther" file="/repo/tests/OtherTest.php"><skipped/></testcase></testsuite>\n');
  // A data provider skipped case by case: the names stop at 20, the total rides beside them.
  await writeFile(join(dir, 'c7.log'), `<testsuite><testcase name="testPersists" file="/repo/tests/OrderTest.php"/>${Array.from({ length: 25 }, (_, index) => `<testcase name="testPersists with data set #${index}" file="/repo/tests/OrderTest.php"><skipped/></testcase>`).join('')}</testsuite>\n`);
  await writeFile(join(dir, 'qa-spec-skips.json'), JSON.stringify({ cwd: dir, changed_paths: ['src/Totals.php', 'tests/TotalsTest.php'], checks: [{ id: 'c1', expected_test_paths: ['tests/TotalsTest.php'] }, { id: 'c7', expected_test_paths: ['tests/OrderTest.php'] }] }));
  const results = join(dir, 'qa-checks-skips-results.json');
  await writeFile(results, JSON.stringify({ ok: true, status: 'complete', cwd: dir, exec: null, pid: null, checks: [
    item('c1', 'Tests: 3, Assertions: 1, Skipped: 2.'),
    item('c2', ' Test Files  1 passed | 1 skipped (2)\n      Tests  4 passed | 3 skipped (7)\n'),
    item('c3', 'Tests:       2 skipped, 5 passed, 7 total\n'),
    item('c4', '==== 6 passed, 4 skipped in 0.12s ====\n'),
    item('c5', 'Tests: 9, Assertions: 12, Skipped: 5.\n'),
    item('c6', '      Tests  7 passed (7)\n'),
    item('c7', 'Tests: 26, Assertions: 1, Skipped: 25.'),
  ] }));
  const reported = run(dir, ['--report', '--results', results, '--timeout', '5']);
  assert.equal(reported.json.verdict, 'green', JSON.stringify(reported));
  assert.deepEqual([reported.json.passed, reported.json.failed, reported.json.broken], [7, 0, 0]);
  const result = JSON.parse(await readFile(reported.json.result, 'utf8'));
  assert.deepEqual(result.checks.map((check) => [check.id, check.skipped_cases ?? null, check.skipped_count ?? null]), [
    ['c1', [{ file: 'tests/TotalsTest.php', name: 'testRounds' }], null],
    ['c2', null, 3],
    ['c3', null, 2],
    ['c4', null, 4],
    ['c5', null, 5],
    ['c6', null, null],
    ['c7', Array.from({ length: 20 }, (_, index) => ({ file: 'tests/OrderTest.php', name: `testPersists with data set #${index}` })), 25],
  ]);
  assert.equal(Object.hasOwn(result.checks[5], 'skipped_count'), false);
  assert.equal(Object.hasOwn(result.checks[5], 'skipped_cases'), false);
});

test('a gate where no check ran is unconfirmed, unless the change is documentation only', async () => {
  assert.deepEqual(deriveChecks({ ok: false, error: 'env-snapshot failed' }, ['app/job.py'], []), []);
  const dir = await mkdtemp(join(tmpdir(), 'qa-empty-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'fixture@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'Fixture']);
  await writeFile(join(dir, 'README.md'), '# Fixture\n');
  commit(dir, 'base');
  const gate = (id) => {
    const { json: planned } = run(dir, ['--plan', '--base', 'main', '--out', join(dir, '..', `qa-empty-out-${Date.now()}`), '--id', id]);
    assert.equal(planned.checks, 0, JSON.stringify(planned));
    const started = run(dir, ['--run', '--spec', planned.spec]);
    assert.equal(started.json.checks, 0, JSON.stringify(started));
    return run(dir, ['--report', '--results', started.json.results, '--timeout', '5']).json;
  };

  sh(dir, 'git', ['checkout', '-qb', 'code']);
  await mkdir(join(dir, 'app'), { recursive: true });
  await writeFile(join(dir, 'app', 'job.py'), 'print("job")\n');
  commit(dir, 'a job');
  const code = gate('code');
  assert.equal(code.verdict, 'unconfirmed');
  assert.deepEqual([code.passed, code.failed, code.broken, code.skipped], [0, 0, 0, 0]);
  assert.deepEqual(JSON.parse(await readFile(code.result, 'utf8')).obstacles, ['gate: no check ran over the change']);

  // One code path beside the documentation is enough to need a check.
  await writeFile(join(dir, 'README.md'), '# Fixture\n\nRuns a job.\n');
  commit(dir, 'describe the job');
  assert.equal(gate('mixed').verdict, 'unconfirmed');

  // A .txt manifest is not prose: the dependencies changed.
  sh(dir, 'git', ['checkout', '-q', 'main']);
  sh(dir, 'git', ['checkout', '-qb', 'deps']);
  await writeFile(join(dir, 'requirements.txt'), 'requests==2.32.3\n');
  commit(dir, 'pin requests');
  assert.equal(gate('deps').verdict, 'unconfirmed');

  sh(dir, 'git', ['checkout', '-q', 'main']);
  sh(dir, 'git', ['checkout', '-qb', 'docs']);
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# Fixture\n\nHow to run.\n');
  await writeFile(join(dir, 'docs', 'guide.md'), '# Guide\n');
  commit(dir, 'docs only');
  const docs = gate('docs');
  assert.equal(docs.verdict, 'green');
  assert.deepEqual(JSON.parse(await readFile(docs.result, 'utf8')).obstacles, []);
});

test('PHPUnit gets one invocation per file and JUnit proves executed targets', () => {
  const paths = ['tests/FirstTest.php', "tests/a'bTest.php"];
  const items = deriveChecks({ validation: { checks: [{ tool: 'phpunit', scope: 'tests-by-path', command: 'vendor/bin/phpunit {test paths}' }] } }, [], paths);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.expected_test_paths), paths.map((path) => [path]));
  assert.ok(!items[0].command.includes(paths[1]));
  assert.equal(sh(process.cwd(), '/bin/sh', ['-c', `printf '%s' ${items[1].command.slice('vendor/bin/phpunit '.length)}`]), paths[1]);
  assert.deepEqual(executedTestPaths('<testcase file="/repo/tests/FirstTest.php"/><testcase file="/repo/tests/a&apos;bTest.php"><skipped/></testcase>', paths), [paths[0]]);
  assert.deepEqual(executedTestPaths('OK (1 test)', paths), []);
});

test('configured PHPUnit keeps its suite while separate targets really execute through the executor', async () => {
  const dir = await repo();
  await mkdir(join(dir, 'vendor', 'bin'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  for (const name of ['FirstTest', 'SecondTest']) await writeFile(join(dir, 'tests', `${name}.php`), '<?php\n');
  await writeFile(join(dir, 'composer.json'), JSON.stringify({ name: 'fixture/php', scripts: { test: 'vendor/bin/phpunit', 'test-rector': 'vendor/bin/phpunit -c phpunit.rector.xml.dist rector/tests' } }));
  const executable = join(dir, 'vendor', 'bin', 'phpunit');
  await writeFile(executable, '#!/usr/bin/env node\n' + `
const fs = require('node:fs');
const args = process.argv.slice(2);
const target = args.find((arg) => arg.endsWith('Test.php'));
const report = args[args.indexOf('--log-junit') + 1];
if (target && report) fs.writeFileSync(report, '<testsuites><testsuite><testcase file="' + process.cwd() + '/' + target + '"/></testsuite></testsuites>');
process.exit(target?.endsWith('SecondTest.php') ? 1 : 0);
`);
  await chmod(executable, 0o755);
  commit(dir, 'php tests');
  const { json: planned } = run(dir, ['--plan', '--base', 'main', '--out', join(dir, '..', `qa-php-${Date.now()}`)]);
  const spec = JSON.parse(await readFile(planned.spec, 'utf8'));
  const suite = spec.checks.find((item) => item.source === 'composer test-rector');
  assert.equal(suite.run, 'vendor/bin/phpunit -c phpunit.rector.xml.dist rector/tests');
  assert.equal(suite.scope, 'none');
  const drop = spec.checks.filter((item) => !item.expected_test_paths).map((item) => item.id).join(',');
  const started = run(dir, ['--run', '--spec', planned.spec, '--exec', 'sh -c', '--drop', drop]);
  assert.equal(started.json.ok, true, JSON.stringify(started));
  const reported = run(dir, ['--report', '--results', started.json.results, '--timeout', '30']);
  assert.equal(reported.json.verdict, 'red');
  const result = JSON.parse(await readFile(reported.json.result, 'utf8'));
  assert.deepEqual(result.checks.map((item) => item.status), ['passed', 'failed']);
  assert.deepEqual(result.checks.map((item) => item.executed_test_paths), [['tests/FirstTest.php'], ['tests/SecondTest.php']]);

  // Exit 0 with no JUnit must never claim either target passed.
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  const empty = run(dir, ['--run', '--spec', planned.spec]);
  const unconfirmed = run(dir, ['--report', '--results', empty.json.results, '--timeout', '30']);
  assert.equal(unconfirmed.json.verdict, 'unconfirmed');
  assert.equal(unconfirmed.json.broken, 2);
});

test('--plan derives the checks at the width of the change, writes the plan with the rules and a ready spec', async () => {
  const dir = await repo();
  const out = join(dir, '..', `qa-out-${Date.now()}`);
  const { code, json } = run(dir, ['--plan', '--base', 'main', '--out', out, '--id', 'eval']);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.ok, true);
  assert.equal(json.files, 3);
  assert.equal(json.checks, 2);
  assert.deepEqual(json.not_runnable, []);
  assert.equal(json.rules_routes, 1);
  const plan = await readFile(json.plan, 'utf8');
  assert.match(plan, /^<qa_plan id="eval" base="main" head="[0-9a-f]+">/);
  assert.match(plan, /<files>\n- A src\/style\.php\n- M src\/totals\.js\n- A src\/totals\.test\.js \(test\)/);
  assert.match(plan, /\[c1\] npx eslint src\/totals\.js — eslint, narrowed to the change, from npm run lint/);
  assert.match(plan, /\[c2\] npx vitest related src\/totals\.js — vitest, narrowed to the change, from npm run test/);
  assert.equal(plan.includes('lint:fix'), false, 'the rewrite script is not a check');
  assert.match(plan, /#### AGENTS\.md\n\n# Rules/);
  assert.match(plan, /- docs\/gate\.md — tests run through the container, see docs\/gate\.md/);
  assert.ok(plan.endsWith('</qa_plan>\n'));
  const spec = JSON.parse(await readFile(json.spec, 'utf8'));
  assert.equal(spec.cwd, await realpath(dir));
  assert.equal(spec.exec, null);
  assert.deepEqual(spec.changed_paths, ['src/style.php', 'src/totals.js', 'src/totals.test.js']);
  assert.deepEqual(spec.checks.map((check) => check.id), ['c1', 'c2']);

  assert.equal(run(dir, ['--plan', '--base', 'nowhere']).json.code, 'base_ref_not_found');
  sh(dir, 'git', ['checkout', '-q', 'main']);
  assert.equal(run(dir, ['--plan', '--base', 'main']).json.code, 'empty_diff');
});

test('--run refuses prose and rewrites, applies additions and drops, and --report attributes and settles the verdict', async () => {
  const dir = await repo();
  const out = join(dir, '..', `qa-out-${Date.now()}`);
  const { json: planned } = run(dir, ['--plan', '--base', 'main', '--out', out, '--id', 'eval']);

  const prose = run(dir, ['--run', '--spec', planned.spec, '--add', 'php -l по изменённым файлам']);
  assert.equal(prose.json.code, 'not_a_command');
  assert.equal(run(dir, ['--run', '--spec', planned.spec, '--add', 'npx eslint --fix src']).json.code, 'not_a_command');
  assert.equal(run(dir, ['--run', '--spec', planned.spec, '--add', 'vendor/bin/rector process src']).json.code, 'not_a_command');

  const started = run(dir, ['--run', '--spec', planned.spec, '--drop', 'c2', '--add', 'echo "Line  lib/legacy.php" && exit 3', '--add', 'true']);
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.deepEqual(started.json.executor, { status: 'host' });
  assert.equal(started.json.checks, 3);
  const spec = JSON.parse(await readFile(planned.spec, 'utf8'));
  assert.deepEqual(spec.checks.map((check) => [check.id, check.source]), [['c1', 'npm run lint'], ['r1', 'repository rules'], ['r2', 'repository rules']]);

  const reported = run(dir, ['--report', '--results', started.json.results, '--timeout', '30']);
  assert.equal(reported.json.ok, true, JSON.stringify(reported.json));
  assert.equal(reported.json.verdict, 'red');
  assert.deepEqual([reported.json.passed, reported.json.failed, reported.json.broken], [1, 2, 0]);
  const result = JSON.parse(await readFile(reported.json.result, 'utf8'));
  assert.equal(result.kind, 'qa_result');
  assert.equal(result.workspace.base, 'main');
  assert.deepEqual(result.checks.map((item) => [item.id, item.status, item.attribution ?? null]), [['c1', 'failed', 'in_change'], ['r1', 'failed', 'outside_change'], ['r2', 'passed', null]]);
  assert.match(result.checks[0].tail, /no-unused-vars/);
  assert.equal(result.checks[0].exit, 1);

  // The role judged r1 baseline: it turns broken, the verdict falls to unconfirmed, the obstacle names it.
  const settled = run(dir, ['--report', '--results', started.json.results, '--timeout', '30', '--baseline', 'r1=lib/legacy.php is untouched and names no changed identifier']);
  assert.equal(settled.json.verdict, 'red', 'c1 still fails on the change');
  const again = run(dir, ['--report', '--results', started.json.results, '--timeout', '30', '--baseline', 'r1=legacy', '--baseline', 'c1=it is not']);
  assert.equal(again.json.verdict, 'unconfirmed');
  const file = JSON.parse(await readFile(again.json.result, 'utf8'));
  assert.deepEqual(file.checks.map((item) => [item.status, item.attribution ?? null]), [['broken', 'baseline'], ['broken', 'baseline'], ['passed', null]]);
  assert.deepEqual(file.obstacles, ['c1: baseline: it is not', 'r1: baseline: legacy']);
  assert.equal(run(dir, ['--report', '--results', started.json.results, '--baseline', 'r2=x']).json.code, 'bad_args');
});

test('--run proves the executor sees this workspace before anything runs', async () => {
  const dir = await repo();
  const out = join(dir, '..', `qa-out-${Date.now()}`);
  const { json: planned } = run(dir, ['--plan', '--base', 'main', '--out', out, '--id', 'exec']);

  // An executor that runs in another checkout of the same files: the changed file differs.
  const other = join(dir, '..', `qa-other-${Date.now()}`);
  await mkdir(join(other, 'src'), { recursive: true });
  await writeFile(join(other, 'src', 'style.php'), '<?php\n');
  await writeFile(join(other, 'src', 'totals.js'), 'export const total = (items) => items.length;\n');
  await writeFile(join(other, 'src', 'totals.test.js'), 'test("sums", () => {});\n');
  const mismatch = run(dir, ['--run', '--spec', planned.spec, '--exec', `sh -c 'cd ${other} && exec sh -c "$0"'`]);
  assert.equal(mismatch.json.ok, true, JSON.stringify(mismatch.json));
  assert.equal(mismatch.json.executor.status, 'mismatch');
  assert.match(mismatch.json.executor.detail, /src\/totals\.js differs between the host and the executor/);
  const reported = run(dir, ['--report', '--results', mismatch.json.results, '--timeout', '10']);
  assert.equal(reported.json.verdict, 'unconfirmed');
  const result = JSON.parse(await readFile(reported.json.result, 'utf8'));
  assert.ok(result.checks.every((item) => item.status === 'broken' && /^executor: /.test(item.reason)));
  assert.equal(result.executor.status, 'mismatch');

  // An executor that does not start.
  const dead = run(dir, ['--run', '--spec', planned.spec, '--exec', 'no-such-docker-xyz exec app sh -c']);
  assert.equal(dead.json.executor.status, 'failed');

  // A transparent executor passes the probe and wraps every command.
  const ok = run(dir, ['--run', '--spec', planned.spec, '--exec', 'sh -c', '--drop', 'c1']);
  assert.equal(ok.json.executor.status, 'ok');
  const green = run(dir, ['--report', '--results', ok.json.results, '--timeout', '30']);
  assert.equal(green.json.verdict, 'green');
  const file = JSON.parse(await readFile(green.json.result, 'utf8'));
  assert.equal(file.checks[0].ran, "sh -c 'npx vitest related src/totals.js'");
  assert.equal(file.executor.status, 'ok');
});
