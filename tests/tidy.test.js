// Behavioural suite for the project-manager tidy script: real git repositories
// in a temp directory, trees made by prepare-worktree itself, no stubs. Covers
// the verdict per tree, and what `remove` takes and keeps. PATH is narrowed so the machine's own lsd is never asked or cleaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const scripts = join(process.cwd(), 'skills', 'project-manager', 'scripts');
const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const call = (script, args) => JSON.parse(execFileSync(process.execPath, [join(scripts, script), JSON.stringify(args)], { encoding: 'utf8', env }));
const tidy = (args) => call('tidy.mjs', { base: 'main', ...args });

async function withProject(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dt-tidy-')));
  const origin = join(root, 'origin.git');
  const clone = join(root, 'work');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', origin]);
    git(root, ['clone', '-q', origin, clone]);
    git(clone, ['config', 'user.email', 'test@example.com']);
    git(clone, ['config', 'user.name', 'Test']);
    await writeFile(join(clone, 'dreamteam.json'), JSON.stringify({ version: 1, worktree: { root: '.worktrees', copy: [], link: [], setup: [] } }));
    await writeFile(join(clone, '.gitignore'), '.worktrees/\n.dreamteam/\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '-q', '-m', 'base']);
    git(clone, ['push', '-q', 'origin', 'HEAD:main']);
    await fn({ root, clone });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A task tree as a development run leaves it; `commits` adds work of its own.
async function taskTree(clone, key, { commits = 1 } = {}) {
  const prepared = call('prepare-worktree.mjs', { repo: clone, key, base: 'main', sync: true, ensure: 'develop' }).prepared;
  assert.equal(prepared.error, null, JSON.stringify(prepared));
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(prepared.workspace, `${key}-${index}.txt`), 'work\n');
    git(prepared.workspace, ['add', '.']);
    git(prepared.workspace, ['commit', '-q', '-m', `${key} work`]);
  }
  return prepared.workspace;
}

async function workflowDir(clone, key) {
  const dir = join(clone, '.dreamteam', 'workflow', key);
  await mkdir(join(dir, 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, 'journal.md'), '## entry\n');
  return dir;
}

const verdicts = (report) => Object.fromEntries(report.trees.map((tree) => [tree.key ?? 'foreign', tree.verdict]));

test('--usage prints the contract; a bad call is bad_args', () => {
  assert.ok(execFileSync(process.execPath, [join(scripts, 'tidy.mjs'), '--usage'], { encoding: 'utf8' }).startsWith('tidy.mjs — '));
  assert.equal(tidy({ op: 'sweep', repo: '.' }).code, 'bad_args');
});

test('the verdict joins what git proves with the tracker stage', async () => {
  await withProject(async ({ root, clone }) => {
    await taskTree(clone, 'PRJ-1');
    git(clone, ['merge', '-q', '--no-ff', '-m', 'PRJ-1', 'PRJ-1']);
    await taskTree(clone, 'PRJ-2');
    await taskTree(clone, 'PRJ-3', { commits: 0 });
    const dirty = await taskTree(clone, 'PRJ-4');
    git(clone, ['merge', '-q', '--no-ff', '-m', 'PRJ-4', 'PRJ-4']);
    await writeFile(join(dirty, 'left.txt'), 'uncommitted\n');
    git(clone, ['worktree', 'add', '-q', '-b', 'scratch', join(root, 'elsewhere')]);

    assert.deepEqual(tidy({ op: 'keys', repo: clone }).keys.sort(), ['PRJ-1', 'PRJ-2', 'PRJ-3', 'PRJ-4']);

    // Git alone: only the delivered branch is proven; a branch that never left the base proves nothing.
    const bare = tidy({ op: 'scan', repo: clone });
    assert.deepEqual(verdicts(bare), { 'PRJ-1': 'remove', 'PRJ-2': 'keep', 'PRJ-3': 'keep', 'PRJ-4': 'dirty', foreign: 'foreign' });
    assert.deepEqual(bare.removable, ['PRJ-1']);
    assert.deepEqual([bare.trees.find((tree) => tree.key === 'PRJ-3').merged, bare.trees.find((tree) => tree.key === 'PRJ-3').own_commits], [true, 0]);
    assert.match(bare.rendered, /PRJ-1 — можно удалить: ветка влита в main/);
    assert.match(bare.rendered, /PRJ-4 — решает человек: незакоммиченные изменения/);

    // Accepted and not delivered waits for its delivery; cancelled goes; delivered and back in work stays.
    const staged = tidy({ op: 'scan', repo: clone, stages: { 'PRJ-1': 'dev', 'PRJ-2': { stage: 'done', status: 'Готово' }, 'PRJ-3': 'cancelled' } });
    assert.deepEqual(verdicts(staged), { 'PRJ-1': 'keep', 'PRJ-2': 'deliver', 'PRJ-3': 'remove', 'PRJ-4': 'dirty', foreign: 'foreign' });
    assert.match(staged.rendered, /PRJ-2 — доставить: принята, не доставлена · трекер: Готово/);

    // A pushed branch of a closed item is delivered outside the base (a merge request).
    git(clone, ['push', '-q', 'origin', 'PRJ-2']);
    assert.equal(verdicts(tidy({ op: 'scan', repo: clone, stages: { 'PRJ-2': 'done' } }))['PRJ-2'], 'remove');
  });
});

test('remove takes the trees the verdict covers, keeps branches, dirty trees and the workflow directories', async () => {
  await withProject(async ({ clone }) => {
    const merged = await taskTree(clone, 'PRJ-1');
    git(clone, ['merge', '-q', '--no-ff', '-m', 'PRJ-1', 'PRJ-1']);
    const active = await taskTree(clone, 'PRJ-2');
    const dirty = await taskTree(clone, 'PRJ-4');
    git(clone, ['merge', '-q', '--no-ff', '-m', 'PRJ-4', 'PRJ-4']);
    await writeFile(join(dirty, 'left.txt'), 'uncommitted\n');
    const vanished = await taskTree(clone, 'PRJ-5');
    await rm(vanished, { recursive: true, force: true });

    const journal = await workflowDir(clone, 'PRJ-1');

    const stages = { 'PRJ-2': 'dev' };
    const done = tidy({ op: 'remove', repo: clone, stages });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.deepEqual(done.removed.trees.map((tree) => [tree.key, tree.removed]), [['PRJ-1', true]]);
    assert.deepEqual([existsSync(merged), existsSync(active), existsSync(dirty)], [false, true, true]);
    assert.equal(git(clone, ['rev-parse', '--verify', '--quiet', 'refs/heads/PRJ-1']).length, 40, 'the task branch stays');
    assert.equal(existsSync(journal), true, 'the history of the item stays');
    assert.equal(done.removed.pruned, true);
    assert.doesNotMatch(git(clone, ['worktree', 'list']), /PRJ-5/);
    assert.match(done.rendered, /PRJ-1 — дерево удалено/);
    assert.match(done.rendered, /PRJ-2 — оставить: в работе/);
    assert.match(done.rendered, /PRJ-4 — решает человек/);

    // A named key is the human's decision: the tree goes under any verdict; a dirty tree still stays.
    const named = tidy({ op: 'remove', repo: clone, stages, keys: ['PRJ-2', 'PRJ-4', 'PRJ-9'] });
    assert.deepEqual(named.removed.trees.map((tree) => [tree.key, tree.removed]), [['PRJ-2', true], ['PRJ-4', false]]);
    assert.deepEqual([existsSync(active), existsSync(dirty)], [false, true]);
    assert.match(named.rendered, /PRJ-4 — дерево оставлено: незакоммиченные изменения/);
    assert.match(named.rendered, /PRJ-9 — дерева задачи нет/);

    assert.equal(tidy({ op: 'scan', repo: clone, stages }).totals.items, 0);
  });
});
