import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attribute, deriveChecks } from '../skills/qa-engineer/scripts/qa-run.mjs';

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
