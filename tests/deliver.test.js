// Behavioural suite for the project-manager deliver script: real git
// repositories in a temp directory, a bare origin where a push is tested, no
// stubs. Delivery is independent of repository hooks (a task repo's
// pre-commit shelling into docker needs host state a worktree lacks), so
// commit and merge run --no-verify; the base branch is never a task branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'project-manager', 'scripts', 'deliver.mjs');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const deliver = (args) => JSON.parse(execFileSync(process.execPath, [scriptPath, JSON.stringify(args)], { encoding: 'utf8' }));

async function withRepo(fn, { hostileHooks = false, origin = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dt-deliver-'));
  const repo = join(root, 'work');
  try {
    git(root, ['init', '-q', '--initial-branch=main', repo]);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base', '--no-verify']);
    if (hostileHooks) {
      for (const hook of ['pre-commit', 'pre-merge-commit']) {
        await writeFile(join(repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n');
        await chmod(join(repo, '.git', 'hooks', hook), 0o755);
      }
    }
    let bare = null;
    if (origin) {
      bare = join(root, 'origin.git');
      git(root, ['clone', '-q', '--bare', repo, bare]);
      git(repo, ['remote', 'add', 'origin', bare]);
      git(repo, ['fetch', '-q', 'origin']);
    }
    await fn({ repo, root, bare });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('mode commit commits despite a failing pre-commit hook', async () => {
  await withRepo(async ({ repo }) => {
    git(repo, ['checkout', '-q', '-b', 'PRJ-1']);
    await writeFile(join(repo, 'feature.txt'), 'change\n');
    const result = deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', base: 'main', paths: ['feature.txt'], message: 'PRJ-1 feature' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.committed, true);
    assert.equal(git(repo, ['log', '-1', '--format=%s']), 'PRJ-1 feature');
    assert.deepEqual(deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', paths: ['feature.txt'], message: 'again' }), { ok: true, mode: 'commit', committed: false, branch: 'PRJ-1', head: git(repo, ['rev-parse', 'HEAD']) });
  }, { hostileHooks: true });
});

test('mode subtask merges into the parent despite failing hooks and is idempotent', async () => {
  await withRepo(async ({ repo }) => {
    git(repo, ['checkout', '-q', '-b', 'PRJ-10']);
    git(repo, ['checkout', '-q', '-b', 'PRJ-11']);
    await writeFile(join(repo, 'sub.txt'), 'subtask\n');
    const result = deliver({ mode: 'subtask', workspace: repo, key: 'PRJ-11', parentKey: 'PRJ-10', base: 'main', paths: ['sub.txt'], message: 'PRJ-11 subtask' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.committed, result.merged, result.branch], [true, true, 'PRJ-10']);
    assert.equal(git(repo, ['log', '-1', '--format=%s']), 'Merge PRJ-11 into PRJ-10');
    const again = deliver({ mode: 'subtask', workspace: repo, key: 'PRJ-11', parentKey: 'PRJ-10' });
    assert.deepEqual([again.ok, again.already_merged, again.merged], [true, true, false]);
  }, { hostileHooks: true });
});

test('commit from a Result file stages its changed_paths and composes the body without retyping', async () => {
  await withRepo(async ({ repo, root }) => {
    git(repo, ['checkout', '-q', '-b', 'PRJ-1']);
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    await writeFile(join(repo, 'stray.txt'), 'not part of the result\n');
    const resultPath = join(root, 'result.json');
    await writeFile(resultPath, JSON.stringify({
      contract_version: 1, assignment_id: 'a', role: 'software-developer', status: 'done', summary: 'Сделано',
      deliverable: { kind: 'implementation_summary', content: { behavior: 'Добавлен feature.txt', why: 'Так просила задача' } },
      changed_paths: ['feature.txt'],
      verification: [{ command: 'npm test', status: 'passed', evidence: 'все зелёные' }, { command: 'php -l', status: 'skipped' }],
    }));
    assert.deepEqual(deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', resultPath }), { ok: false, code: 'subject_required' });
    assert.deepEqual(deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', resultPath: join(root, 'nope.json'), subject: 'PRJ-1 x' }), { ok: false, code: 'result_unreadable', path: join(root, 'nope.json') });
    const committed = deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', resultPath, subject: 'PRJ-1 Фича' });
    assert.equal(committed.committed, true);
    assert.equal(git(repo, ['log', '-1', '--format=%B']), 'PRJ-1 Фича\n\n## Что сделано\nДобавлен feature.txt\n\n## Почему\nТак просила задача\n\n## Проверено\n- npm test — PASSED: все зелёные\n- php -l — SKIPPED');
    assert.equal(git(repo, ['show', '--name-only', '--format=', 'HEAD']), 'feature.txt');
    assert.match(git(repo, ['status', '--porcelain']), /stray\.txt/, 'paths outside the Result stay unstaged');
  });
});

test('mode merge (delivery merge_push) merges the task branch into the base and pushes it; an in-place checkout switches first', async () => {
  await withRepo(async ({ repo, bare }) => {
    git(repo, ['checkout', '-q', '-b', 'PRJ-2']);
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'PRJ-2 feature']);
    const merged = deliver({ mode: 'merge', workspace: repo, key: 'PRJ-2', base: 'main' });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.deepEqual([merged.merged, merged.synced, merged.pushed, merged.branch], [true, true, true, 'main']);
    assert.equal(git(repo, ['log', '-1', '--format=%s']), 'Merge PRJ-2 into main');
    assert.equal(git(bare, ['rev-parse', 'main']), git(repo, ['rev-parse', 'main']), 'the base is pushed');
    git(repo, ['checkout', '-q', '-b', 'PRJ-3']);
    assert.equal(deliver({ mode: 'merge', workspace: repo, key: 'PRJ-2', base: 'main' }).code, 'not_on_base');
  }, { origin: true });
});

test('mode push (delivery branch) pushes the task branch, never the base, and may drop the run-owned worktree', async () => {
  await withRepo(async ({ repo, bare, root }) => {
    git(repo, ['checkout', '-q', '-b', 'PRJ-4']);
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'PRJ-4 feature']);
    await writeFile(join(repo, 'dirty.txt'), 'x\n');
    assert.equal(deliver({ mode: 'push', workspace: repo, key: 'PRJ-4', base: 'main' }).code, 'workspace_dirty');
    await rm(join(repo, 'dirty.txt'));
    const pushed = deliver({ mode: 'push', workspace: repo, key: 'PRJ-4', base: 'main' });
    assert.deepEqual(pushed, { ok: true, mode: 'push', pushed: true, branch: 'PRJ-4', worktree_removed: false, warnings: [] });
    assert.equal(git(bare, ['rev-parse', 'PRJ-4']), git(repo, ['rev-parse', 'PRJ-4']));
    assert.equal(git(bare, ['rev-parse', 'main']), git(repo, ['rev-parse', 'main']), 'main is untouched');
    const tree = join(root, 'tree');
    git(repo, ['worktree', 'add', '-q', '-b', 'PRJ-5', tree, 'main']);
    const removed = deliver({ mode: 'push', workspace: tree, key: 'PRJ-5', base: 'main', toplevel: repo, removeWorktree: true });
    assert.deepEqual([removed.pushed, removed.worktree_removed], [true, true]);
  }, { origin: true });
});

test('the base branch is never a task branch: commit, subtask and push refuse it; bad arguments fail closed', async () => {
  await withRepo(async ({ repo }) => {
    assert.deepEqual(deliver({ mode: 'commit', workspace: repo, key: 'main', base: 'main', paths: ['.'], message: 'x' }), { ok: false, code: 'base_forbidden', base: 'main' });
    assert.deepEqual(deliver({ mode: 'subtask', workspace: repo, key: 'PRJ-1', parentKey: 'main', base: 'main' }), { ok: false, code: 'base_forbidden', base: 'main' });
    assert.deepEqual(deliver({ mode: 'push', workspace: repo, key: 'main', base: 'main' }), { ok: false, code: 'base_forbidden', base: 'main' });
    assert.equal(deliver({ mode: 'main', workspace: repo, key: 'PRJ-1' }).code, 'bad_args');
    assert.equal(deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', paths: ['../x'] }).code, 'wrong_branch');
    git(repo, ['checkout', '-q', '-b', 'PRJ-1']);
    assert.equal(deliver({ mode: 'commit', workspace: repo, key: 'PRJ-1', paths: ['../x'] }).code, 'bad_paths');
    assert.equal(deliver({ mode: 'push', workspace: repo, key: 'PRJ-1' }).code, 'remote_missing');
  });
});
