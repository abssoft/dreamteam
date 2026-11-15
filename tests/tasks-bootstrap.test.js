// The tasks dispatcher's startup probe: the setup gates (a repository, an
// ignored .dreamteam/, the key prefix in .env), the key against the prefix,
// and a manifest the project-manager role can run — always against the
// primary checkout, whichever worktree the command came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'tasks', 'scripts', 'bootstrap.mjs');
const validatorPath = join(process.cwd(), 'contracts', 'validate-adapter.mjs');
const probe = (args) => JSON.parse(execFileSync(process.execPath, [scriptPath, JSON.stringify(args)], { encoding: 'utf8' }));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function withRepo(fn, { ignore = true, env = 'DREAMTEAM_TASKS_PREFIX=DT\n' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dt-tasks-')));
  const dir = join(root, 'repo');
  try {
    await mkdir(dir);
    git(dir, ['init', '-q', '--initial-branch=main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await writeFile(join(dir, '.gitignore'), ignore ? '.dreamteam/\n.env\n' : '.env\n');
    if (env !== null) await writeFile(join(dir, '.env'), env);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    await fn(dir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('--usage prints the contract; bad arguments are data', () => {
  assert.ok(execFileSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' }).startsWith('bootstrap.mjs — '));
  assert.equal(probe({ runtime: 'gemini', projectRoot: '/' }).code, 'bad_args');
});

test('setup gaps stop the dispatcher with the file and the line to add', async () => {
  await withRepo((dir) => {
    const line = probe({ runtime: 'claude', projectRoot: dir });
    assert.equal(line.setup.code, 'store_not_ignored');
    assert.deepEqual([line.setup.path, line.setup.add], [join(dir, '.gitignore'), '.dreamteam/']);
  }, { ignore: false });
  await withRepo((dir) => {
    const line = probe({ runtime: 'claude', projectRoot: dir });
    assert.equal(line.setup.code, 'prefix_missing');
    assert.deepEqual([line.setup.path, line.setup.add], [join(dir, '.env'), 'DREAMTEAM_TASKS_PREFIX=DT']);
  }, { env: 'OTHER=1\n' });
  await withRepo((dir) => {
    assert.equal(probe({ runtime: 'claude', projectRoot: dir }).setup.code, 'prefix_invalid');
  }, { env: 'DREAMTEAM_TASKS_PREFIX=dt\n' });
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'dt-tasks-none-')));
  try { assert.equal(probe({ runtime: 'claude', projectRoot: outside }).setup.code, 'no_repository'); } finally { await rm(outside, { recursive: true, force: true }); }
});

test('a ready project gets a runnable manifest over the primary checkout, from any worktree', async () => {
  await withRepo(async (dir, root) => {
    git(dir, ['worktree', 'add', '-q', '-b', 'DT-1', join(root, 'wt')]);
    const line = probe({ runtime: 'codex', projectRoot: join(root, 'wt'), key: 'DT-1' });
    assert.equal(line.ok, true);
    assert.equal(line.setup, null);
    assert.deepEqual(line.problems, []);
    assert.deepEqual(line.store, { root: join(dir, '.dreamteam', 'tasks'), ignored: true });
    assert.equal(line.env.prefix, 'DT');
    assert.equal(line.invoke, '$tasks');
    assert.equal(line.workflow.placement, 'repository');
    assert.ok(line.run_dir.startsWith(join(dir, '.dreamteam', 'workflow', 'DT-1', 'runs')));
    assert.ok(line.dream_team.roles.missing.length === 0, JSON.stringify(line.dream_team.roles));
    const manifest = JSON.parse(fs.readFileSync(line.manifest, 'utf8'));
    assert.deepEqual([manifest.kind, manifest.label, manifest.modes[0].token], ['file', 'tasks', 'бэклог']);

    const created = JSON.parse(execFileSync('sh', ['-c', `${manifest.command} create '{"title":"Первая"}'`], { encoding: 'utf8' }));
    assert.equal(created.key, 'DT-1');
    assert.ok(fs.existsSync(join(dir, '.dreamteam', 'tasks', 'DT-1.md')));
    const checked = JSON.parse(execFileSync(process.execPath, [validatorPath, '--manifest', line.manifest, '--check', '--key', 'DT-1', '--dir', join(line.run_dir, 'check')], { encoding: 'utf8' }));
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(git(dir, ['status', '--porcelain']), '', 'the tracker never dirties the repository');

    assert.deepEqual(probe({ runtime: 'claude', projectRoot: dir, key: 'XY-3' }).problems, ['Ключ XY-3 не из этого трекера: префикс задач проекта — DT']);
  });
});
