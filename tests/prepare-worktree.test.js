// Behavioural suite for the project-manager prepare-worktree script: real git
// repositories in a temp directory, a bare origin, no stubs. Covers the ensure
// mode that owns every branch and worktree mutation of a run, placement by the
// project profile, and the re-entry sign prior_commits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'project-manager', 'scripts', 'prepare-worktree.mjs');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = (args) => JSON.parse(execFileSync(process.execPath, [scriptPath, JSON.stringify(args)], { encoding: 'utf8' }));

// A bare origin plus a clone whose local main deliberately lags behind: the
// shape that once made a dispatcher branch off a stale base.
async function withRepo(fn, { stale = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dt-prepare-'));
  const origin = join(root, 'origin.git');
  const clone = join(root, 'work');
  try {
    const seed = join(root, 'seed');
    await mkdir(seed);
    git(seed, ['init', '-q', '--initial-branch=main']);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test']);
    await writeFile(join(seed, 'README.md'), 'base\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'base']);
    git(root, ['clone', '-q', '--bare', seed, origin]);
    git(root, ['clone', '-q', origin, clone]);
    git(clone, ['config', 'user.email', 'test@example.com']);
    git(clone, ['config', 'user.name', 'Test']);
    if (stale) {
      await writeFile(join(seed, 'README.md'), 'moved on\n');
      git(seed, ['commit', '-q', '-am', 'advance main']);
      git(seed, ['push', '-q', origin, 'main']);
    }
    await fn({ root, origin, clone });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitProfile(clone, profile) {
  await writeFile(join(clone, 'dreamteam.json'), JSON.stringify({ version: 1, ...profile }));
  await writeFile(join(clone, '.gitignore'), '.worktrees/\n.dreamteam/\ndocker-compose.dev.yml\nvendor/\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-q', '-m', 'profile']);
}

test('--usage prints the contract; a plain call inspects without mutating', async () => {
  assert.ok(execFileSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' }).startsWith('prepare-worktree.mjs — '));
  await withRepo(async ({ clone }) => {
    const result = inspect({ repo: clone, key: 'PRJ-2', base: 'main', sync: true });
    assert.equal(result.ok, true);
    assert.equal(result.prepared, undefined);
    assert.equal(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });
});

test('ensure:develop cuts the task branch from the synchronized origin base, never a stale local one', async () => {
  await withRepo(async ({ clone, origin }) => {
    const remoteHead = git(clone, ['ls-remote', origin, 'refs/heads/main']).split('\t')[0];
    assert.notEqual(git(clone, ['rev-parse', 'main']), remoteHead, 'the fixture starts with a stale local main');
    const result = inspect({ repo: clone, key: 'PRJ-1', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(result.prepared.error, null, JSON.stringify(result.prepared));
    assert.deepEqual([result.prepared.branch, result.prepared.created_branch, result.prepared.head], ['PRJ-1', true, remoteHead]);
    assert.equal(result.prepared.prior_commits, 0);
    assert.equal(git(result.prepared.workspace, ['rev-parse', '--abbrev-ref', 'HEAD']), 'PRJ-1');
    const again = inspect({ repo: clone, key: 'PRJ-1', base: 'main', sync: true, ensure: 'develop' });
    assert.deepEqual([again.prepared.created_branch, again.prepared.created_worktree, again.prepared.workspace], [false, false, result.prepared.workspace]);
  }, { stale: true });
});

test('ensure:review refuses to invent a branch; a dirty primary falls back to a dedicated worktree', async () => {
  await withRepo(async ({ clone }) => {
    assert.equal(inspect({ repo: clone, key: 'PRJ-4', base: 'main', sync: true, ensure: 'review' }).prepared.error, 'review_requires_branch');
    await writeFile(join(clone, 'README.md'), 'uncommitted work\n');
    const result = inspect({ repo: clone, key: 'PRJ-5', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(result.prepared.error, null, JSON.stringify(result.prepared));
    assert.equal(result.prepared.created_worktree, true);
    assert.notEqual(result.prepared.workspace, clone);
    assert.equal(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the dirty primary is neither repaired nor moved');
  });
});

test('the task branch parked in the primary is used in place: placement primary, its dirt is run-owned', async () => {
  await withRepo(async ({ clone }) => {
    git(clone, ['checkout', '-q', '-b', 'PRJ-22']);
    await writeFile(join(clone, 'README.md'), 'work in progress\n');
    const result = inspect({ repo: clone, key: 'PRJ-22', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(result.prepared.error, null, JSON.stringify(result.prepared));
    assert.equal(result.prepared.placement, 'primary');
    assert.equal(result.prepared.workspace, result.primary.path);
    assert.equal(result.prepared.created_worktree, false);
  });
});

test('a subtask is cut from its parent branch inside the parent workspace; a parked unmerged sibling blocks', async () => {
  await withRepo(async ({ clone }) => {
    const first = inspect({ repo: clone, key: 'PRJ-11', parentKey: 'PRJ-10', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(first.prepared.error, null, JSON.stringify(first.prepared));
    assert.equal(first.prepared.branch, 'PRJ-11');
    assert.ok(first.prepared.base_ref.endsWith('PRJ-10'), first.prepared.base_ref);
    assert.equal(git(clone, ['rev-parse', 'PRJ-10']), git(clone, ['rev-parse', 'PRJ-11']));
    await writeFile(join(first.prepared.workspace, 'feature.txt'), 'subtask work\n');
    git(first.prepared.workspace, ['add', '.']);
    git(first.prepared.workspace, ['commit', '-q', '-m', 'PRJ-11 work']);
    const blocked = inspect({ repo: clone, key: 'PRJ-12', parentKey: 'PRJ-10', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(blocked.prepared.error, 'parent_worktree_occupied');
    assert.equal(blocked.prepared.occupied_by, 'PRJ-11');
    // Merged and left parked: the next subtask adopts the workspace at the merged tip.
    git(first.prepared.workspace, ['checkout', '-q', 'PRJ-10']);
    git(first.prepared.workspace, ['merge', '-q', '--no-ff', 'PRJ-11', '-m', 'Merge PRJ-11 into PRJ-10']);
    git(first.prepared.workspace, ['checkout', '-q', 'PRJ-11']);
    const next = inspect({ repo: clone, key: 'PRJ-12', parentKey: 'PRJ-10', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(next.prepared.error, null, JSON.stringify(next.prepared));
    assert.equal(next.prepared.workspace, first.prepared.workspace);
    assert.equal(git(clone, ['rev-parse', 'PRJ-12']), git(clone, ['rev-parse', 'PRJ-10']));
    const reentry = inspect({ repo: clone, key: 'PRJ-11', parentKey: 'PRJ-10', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(reentry.prepared.prior_commits, 1, 'a delivered subtask still counts its own commit');
  });
});

test('the profile worktree block pins the path, links and copies into a fresh tree and runs setup; a failing setup keeps the tree', async () => {
  await withRepo(async ({ clone }) => {
    await commitProfile(clone, { worktree: { root: '.worktrees', copy: ['docker-compose.dev.yml'], link: ['vendor'], setup: ['touch setup.marker'] } });
    await writeFile(join(clone, 'docker-compose.dev.yml'), 'services: {}\n');
    await mkdir(join(clone, 'vendor'));
    const result = inspect({ repo: clone, key: 'PRJ-9', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(result.prepared.error, null, JSON.stringify(result.prepared));
    const workspace = result.prepared.workspace;
    assert.equal(workspace, join(result.primary.path, '.worktrees', 'PRJ-9'));
    assert.equal(readFileSync(join(workspace, 'docker-compose.dev.yml'), 'utf8'), 'services: {}\n');
    assert.ok(lstatSync(join(workspace, 'vendor')).isSymbolicLink());
    assert.ok(existsSync(join(workspace, 'setup.marker')));
    assert.equal(result.prepared.ran_setup, true);
    assert.equal(git(workspace, ['status', '--porcelain']), '?? setup.marker');

    await writeFile(join(clone, 'dreamteam.json'), JSON.stringify({ version: 1, worktree: { root: '.worktrees', setup: ['exit 5'] } }));
    git(clone, ['commit', '-q', '-am', 'failing setup']);
    const failed = inspect({ repo: clone, key: 'PRJ-13', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(failed.prepared.error, 'setup_failed');
    assert.ok(existsSync(failed.prepared.workspace), 'the tree is preserved for inspection');

    await writeFile(join(clone, 'dreamteam.json'), JSON.stringify({ version: 1, worktree: { root: '../out' } }));
    git(clone, ['commit', '-q', '-am', 'bad profile']);
    const bad = inspect({ repo: clone, key: 'PRJ-14', base: 'main', sync: true, ensure: 'develop' });
    assert.equal(bad.prepared.error, 'profile_invalid');
    assert.equal(bad.prepared.error_key, 'worktree.root');
  });
});
