import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'code-reviewer', 'scripts', 'checks-run.mjs');

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
