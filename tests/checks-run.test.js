import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'qa-engineer', 'scripts', 'checks-run.mjs');

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
  const line = result.stdout.trim().split('\n').pop();
  return { code: result.status, json: line ? JSON.parse(line) : null, stderr: result.stderr };
};

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'checks-run-'));
  await mkdir(join(dir, 'vendor', 'bin'), { recursive: true });
  // A phpstan stand-in that records its arguments and the wrapper it was given.
  await writeFile(join(dir, 'vendor', 'bin', 'phpstan'), '#!/bin/sh\necho "args: $*"\nfor a in "$@"; do case "$a" in *.neon) cat "$a";; esac; done\n');
  await chmod(join(dir, 'vendor', 'bin', 'phpstan'), 0o755);
  await writeFile(join(dir, 'phpstan.neon'), 'parameters:\n    level: 5\n');
  await writeFile(join(dir, 'custom.neon'), 'parameters:\n    level: 9\n');
  return dir;
}

test('--usage prints the contract; bad arguments are refused', () => {
  const usage = spawnSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' }).stdout;
  assert.ok(usage.startsWith('checks-run.mjs — '));
  assert.equal(run([], process.cwd()).json.code, 'bad_args');
  assert.equal(run(['--spec', 'a', '--wait', 'b'], process.cwd()).json.code, 'bad_args');
});

test('a spec runs in order: exit 0 passes, non-zero fails, a missing command and a timeout are broken', async () => {
  const dir = await workspace();
  const spec = join(dir, 'checks.json');
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    timeout_ms: 800,
    checks: [
      { id: 'c1', tool: 'vitest', command: 'echo green', scope: 'related', width: 'narrowed', source: 'npm run test' },
      { id: 'c2', tool: 'eslint', command: 'echo "src/a.js: 1:1 error" && exit 2', scope: 'paths', width: 'narrowed', source: 'npm run lint' },
      { id: 'c3', tool: 'assignment', command: 'no-such-command-xyz --flag', scope: 'none', width: 'as given', source: 'assignment verification' },
      { id: 'c4', tool: 'tsc', command: 'sleep 5', scope: 'none', width: 'full', source: 'npm run check:types' },
    ],
  }));
  const { json } = run(['--spec', spec], dir);
  assert.equal(json.status, 'complete');
  assert.deepEqual(json.checks.map((item) => [item.id, item.status]), [['c1', 'passed'], ['c2', 'failed'], ['c3', 'broken'], ['c4', 'broken']]);
  assert.equal(json.checks[0].exit, 0);
  assert.match(json.checks[0].tail, /green/);
  assert.equal(json.checks[1].exit, 2);
  assert.match(json.checks[1].tail, /src\/a\.js: 1:1 error/);
  assert.match(json.checks[2].reason, /tooling/);
  assert.equal(json.checks[3].reason, 'timeout');
  assert.equal(await readFile(json.checks[1].log, 'utf8'), 'src/a.js: 1:1 error\n');
  // The results file beside the spec is what --wait reads, and it is complete.
  const waited = run(['--wait', join(dir, 'checks-results.json'), '--timeout', '5'], dir);
  assert.equal(waited.json.status, 'complete');
  assert.equal(waited.json.checks.length, 4);
});

test('a test runner that selected or executed no test is broken at any exit code', async () => {
  const dir = await workspace();
  const spec = join(dir, 'checks.json');
  // [runner output, exit code, expected status]: the lines are the runners' own.
  const cases = [
    ['No test files found, exiting with code 0', 0, 'broken'], // vitest related, vitest --passWithNoTests
    ['No test files found, exiting with code 1', 1, 'broken'], // vitest run
    ['No tests found, exiting with code 1', 1, 'broken'], // jest, jest --findRelatedTests
    ['No tests found, exiting with code 0', 0, 'broken'], // jest --passWithNoTests
    ["Could not find 'nonexistent'", 1, 'broken'], // node --test <missing path>
    ['ℹ tests 0\nℹ suites 0\nℹ pass 0', 0, 'broken'], // node --test, nothing matched
    ['\x1b[34mℹ tests 0\x1b[39m\n\x1b[34mℹ pass 0\x1b[39m', 0, 'broken'], // node --test under FORCE_COLOR
    ['collected 0 items\n\n==== no tests ran in 0.01s ====', 5, 'broken'], // pytest
    ['collected 2 items / 2 deselected / 0 selected\n\n==== 2 deselected in 0.00s ====', 5, 'broken'], // pytest -k, nothing selected
    ['2 deselected in 0.00s', 5, 'broken'], // pytest -q -k, nothing selected
    ['1 warning in 0.01s', 5, 'broken'], // pytest -q, nothing collected, a warning raised
    ['1 warning, 1 error in 0.01s', 2, 'failed'], // pytest -q, a collection error
    ['No tests executed!', 0, 'broken'], // phpunit
    ['?   \tx\t[no test files]', 0, 'broken'], // go test, no package has tests
    ['ok  \tx/b\t0.337s [no tests to run]', 0, 'broken'], // go test -run, nothing matched
    ['?   \tx\t[no test files]\nok  \tx/b\t0.738s', 0, 'passed'], // go test, one package ran
    // Every selected test skipped: nothing executed.
    ['Tests:       2 skipped, 2 total', 0, 'broken'], // jest
    ['      Tests  2 skipped (2)', 0, 'broken'], // vitest
    ['ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2', 0, 'broken'], // node --test
    ['==== 2 skipped in 0.01s ====', 0, 'broken'], // pytest
    ['OK, but some tests were skipped!\nTests: 2, Assertions: 0, Skipped: 2.', 0, 'broken'], // phpunit
    // Some ran beside the skipped ones.
    ['Tests:       1 skipped, 1 passed, 2 total', 0, 'passed'],
    ['      Tests  1 passed | 1 skipped (2)', 0, 'passed'],
    ['==== 1 passed, 1 skipped in 0.00s ====', 0, 'passed'],
    ['Tests: 3, Assertions: 1, Skipped: 2.', 0, 'passed'],
    // A run that reports a failure stays failed, whatever line its output quotes.
    ["  + 'No test files found, exiting with code 0'\n  - 'green'\nℹ tests 1\nℹ pass 0\nℹ fail 1", 1, 'failed'], // assertion diff
    ['Error: expected pytest to print no tests ran in 0.01s', 1, 'failed'],
    ['ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ tests 2\nℹ pass 1\nℹ fail 1', 1, 'failed'], // npm test --workspaces, one empty
    ['ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ cancelled 1', 1, 'failed'], // node --test, a test timed out
    ['collected 0 items / 1 error', 2, 'failed'], // pytest: a collection error is a failure
    ['ℹ tests 2\nℹ pass 2', 0, 'passed'],
    ['green', 0, 'passed'],
    ['src/a.test.js: 1 failed', 1, 'failed'],
  ];
  for (const [index, [text]] of cases.entries()) await writeFile(join(dir, `out-${index}.txt`), `${text}\n`);
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    checks: cases.map(([, exit], index) => ({ id: `c${index + 1}`, tool: 'tests', command: `cat out-${index}.txt; exit ${exit}`, scope: 'related', width: 'narrowed to the change', source: 'fixture' })),
  }));
  const { json } = run(['--spec', spec], dir);
  assert.equal(json.status, 'complete');
  assert.deepEqual(json.checks.map((item) => [item.tail, item.exit, item.status]), cases.map(([text, exit, status]) => [`${text}\n`, exit, status]));
  for (const item of json.checks.filter((check) => check.status === 'broken')) assert.equal(item.reason, 'no test selected or executed: widen the run');
});

test('go test is judged on the whole log: packages without tests past the tail hide no package that ran', async () => {
  const dir = await workspace();
  const spec = join(dir, 'checks.json');
  const none = Array.from({ length: 100 }, (_, index) => `?   \texample.com/svc/cmd/tool${index}\t[no test files]`).join('\n');
  await writeFile(join(dir, 'ran.txt'), `ok  \texample.com/svc/internal/a\t0.412s\n${none}\n`);
  await writeFile(join(dir, 'failed.txt'), `FAIL\texample.com/svc/internal/a\t0.412s\n${none}\n`);
  await writeFile(join(dir, 'none.txt'), `${none}\n`);
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    checks: [['ran', 0], ['failed', 1], ['none', 0]].map(([name, exit]) => ({ id: name, tool: 'go', command: `cat ${name}.txt; exit ${exit}`, scope: 'none', width: 'full', source: 'fixture' })),
  }));
  const { json } = run(['--spec', spec], dir);
  assert.ok(!json.checks[0].tail.includes('ok  '), 'the ok line is past the tail');
  assert.deepEqual(json.checks.map((item) => item.status), ['passed', 'failed', 'broken']);
});

test('phpstan runs through a wrapper that includes the project configuration and pins tmpDir per workspace', async () => {
  const dir = await workspace();
  const spec = join(dir, 'checks.json');
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    checks: [
      { id: 'c1', tool: 'phpstan', command: 'composer analyse', run: 'vendor/bin/phpstan analyse --memory-limit=1G', scope: 'none', width: 'full', source: 'composer analyse' },
      { id: 'c2', tool: 'phpstan', command: 'composer stan', run: 'vendor/bin/phpstan analyse -c custom.neon', scope: 'none', width: 'full', source: 'composer stan' },
    ],
  }));
  const { json } = run(['--spec', spec], dir);
  assert.equal(json.status, 'complete');
  const [discovered, explicit] = json.checks;
  assert.equal(discovered.status, 'passed');
  assert.match(discovered.ran, /^vendor\/bin\/phpstan analyse --memory-limit=1G -c .*phpstan-c1\.neon$/);
  assert.match(discovered.tail, new RegExp(`includes:\\n    - ${join(dir, 'phpstan.neon').replace(/[/.]/g, '\\$&')}\\nparameters:\\n    tmpDir: ${join(tmpdir(), 'dream-team', 'phpstan').replace(/[/.]/g, '\\$&')}/[0-9a-f]{12}`));
  assert.equal(discovered.cache.startsWith(join(tmpdir(), 'dream-team', 'phpstan')), true);
  // The explicit -c is replaced, and the wrapper includes that file instead.
  assert.equal(explicit.status, 'passed');
  assert.equal(explicit.ran.includes('-c custom.neon'), false);
  assert.match(explicit.tail, /includes:\n    - .*\/custom\.neon\n/);
  assert.equal(explicit.cache, discovered.cache, 'one cache per workspace');
});

test('an executor prefix wraps every command, and phpstan keeps the project cache under it or when the project pins tmpDir', async () => {
  const dir = await workspace();
  await mkdir(join(dir, 'other'), { recursive: true });
  const spec = join(dir, 'checks.json');
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    exec: 'sh -c',
    checks: [
      { id: 'c1', tool: 'vitest', command: "echo \"it's green\"", scope: 'related', width: 'narrowed', source: 'npm run test' },
      { id: 'c2', tool: 'phpstan', command: 'composer analyse', run: 'vendor/bin/phpstan analyse', scope: 'none', width: 'full', source: 'composer analyse' },
    ],
  }));
  const { json } = run(['--spec', spec], dir);
  assert.equal(json.exec, 'sh -c');
  assert.equal(json.checks[0].ran, "sh -c 'echo \"it'\\''s green\"'");
  assert.equal(json.checks[0].status, 'passed');
  assert.match(json.checks[0].tail, /it's green/);
  assert.equal(json.checks[1].ran, "sh -c 'vendor/bin/phpstan analyse'");
  assert.equal(Object.hasOwn(json.checks[1], 'cache'), false, 'no host wrapper under an executor');

  await writeFile(join(dir, 'phpstan.neon'), 'parameters:\n    level: 5\n    tmpDir: .phpstan\n');
  const pinned = join(dir, 'pinned.json');
  await writeFile(pinned, JSON.stringify({
    cwd: dir,
    checks: [{ id: 'c1', tool: 'phpstan', command: 'composer analyse', run: 'vendor/bin/phpstan analyse', scope: 'none', width: 'full', source: 'composer analyse' }],
  }));
  const host = run(['--spec', pinned], dir).json;
  assert.equal(host.checks[0].ran, 'vendor/bin/phpstan analyse');
  assert.equal(Object.hasOwn(host.checks[0], 'cache'), false, 'the project pins tmpDir itself');
});

test('--detach starts a runner and --wait returns its complete results; a dead runner is reported as aborted', async () => {
  const dir = await workspace();
  const spec = join(dir, 'checks.json');
  await writeFile(spec, JSON.stringify({
    cwd: dir,
    checks: [{ id: 'c1', tool: 'vitest', command: 'echo ok', scope: 'related', width: 'narrowed', source: 'npm run test' }],
  }));
  const started = run(['--spec', spec, '--detach'], dir).json;
  assert.equal(started.ok, true);
  assert.equal(started.checks, 1);
  assert.equal(started.results, join(dir, 'checks-results.json'));
  const waited = run(['--wait', started.results, '--timeout', '20'], dir).json;
  assert.equal(waited.status, 'complete');
  assert.equal(waited.checks[0].status, 'passed');

  const dead = join(dir, 'dead-results.json');
  await writeFile(dead, JSON.stringify({ ok: true, status: 'running', cwd: dir, pid: 2147483646, current: 'c1', checks: [{ id: 'c1', status: 'pending' }, { id: 'c2', status: 'pending' }] }));
  const aborted = run(['--wait', dead, '--timeout', '5'], dir).json;
  assert.equal(aborted.status, 'aborted');
  assert.deepEqual(aborted.checks.map((item) => item.status), ['broken', 'broken']);
  assert.match(aborted.checks[0].reason, /runner exited/);
});
