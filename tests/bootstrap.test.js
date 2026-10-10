// The DreamTeam half of the startup probe: the role-model table and the
// launcher parameters a dispatcher copies verbatim, and the project profile
// read into a policy with the tracker check. Codex support is verified
// against a models_cache.json fixture; the Claude ladder needs none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'project-manager', 'scripts', 'bootstrap.mjs');
const DEVELOPER_ROWS = ['xs', 's', 'm', 'l', 'xl'].map((size) => `developer_${size}`);
const REVIEWER_ROWS = [1, 2, 3, 4, 5].map((level) => `reviewer_depth_${level}`);
const RESEARCH_ROWS = ['xs', 's', 'm', 'l', 'xl'].map((size) => `research_${size}`);
const LAUNCH_ROWS = [...DEVELOPER_ROWS, 'developer_ultra', ...REVIEWER_ROWS, 'reviewer_ultra'];
const ROWS = ['research', ...RESEARCH_ROWS, 'research_ultra', ...LAUNCH_ROWS];

const probe = (args) => JSON.parse(execFileSync(process.execPath, [scriptPath, JSON.stringify(args)], { encoding: 'utf8' }));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function withDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dt-bootstrap-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function repo(root, profile) {
  const dir = join(root, 'repo');
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'docs', 'terms.md'), '# Terms\n');
  await writeFile(join(dir, '.gitignore'), '.worktrees/\n.dreamteam/\n');
  if (profile) await writeFile(join(dir, 'dreamteam.json'), JSON.stringify(profile));
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

const levels = (...efforts) => efforts.map((effort) => ({ effort }));
const CACHE_MODELS = [
  { slug: 'gpt-6.1-sol', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-6-sol', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-6-astra', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-5.5', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh') },
];
async function writeCache(root, models) {
  const path = join(root, 'models_cache.json');
  await writeFile(path, JSON.stringify({ models }));
  return path;
}

test('--usage prints the contract; bad arguments are data, never a crash', async () => {
  assert.ok(execFileSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' }).startsWith('bootstrap.mjs — '));
  assert.equal(probe({ runtime: 'gemini', projectRoot: '/' }).code, 'bad_args');
  assert.equal(JSON.parse(execFileSync(process.execPath, [scriptPath, 'nope'], { encoding: 'utf8' })).code, 'bad_args');
});

test('claude default resolves development and research by size on sonnet then opus, ultra only on the ultra rows', async () => {
  await withDir(async (root) => {
    const result = probe({ runtime: 'claude', projectRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.models.source, 'default_ceiling');
    assert.deepEqual(result.models.research, { model: 'opus', effort: 'think' });
    assert.deepEqual(DEVELOPER_ROWS.map((row) => result.models[row]), [
      { model: 'sonnet', effort: null }, { model: 'sonnet', effort: 'think' }, { model: 'sonnet', effort: 'think hard' }, { model: 'opus', effort: 'think hard' }, { model: 'opus', effort: 'think harder' },
    ]);
    assert.deepEqual(result.models.developer_ultra, { model: 'opus', effort: 'ultracode' });
    assert.deepEqual(REVIEWER_ROWS.map((row) => result.models[row]), [
      { model: 'sonnet', effort: null }, { model: 'sonnet', effort: 'think hard' }, { model: 'opus', effort: null }, { model: 'opus', effort: 'think hard' }, { model: 'opus', effort: 'think harder' },
    ]);
    assert.deepEqual(result.models.reviewer_ultra, { model: 'opus', effort: 'ultrathink' });
    assert.deepEqual(Object.keys(result.spawn_args), LAUNCH_ROWS);
    for (const row of LAUNCH_ROWS) assert.deepEqual(result.spawn_args[row], { model: result.models[row].model });
    const override = probe({ runtime: 'claude', projectRoot: root, model: 'sonnet' });
    assert.equal(override.models.source, 'override');
    for (const row of ROWS) assert.equal(override.models[row].model, 'sonnet');
    assert.equal(probe({ runtime: 'claude', projectRoot: root, model: 42 }).models.source, 'default_ceiling');
  });
});

test('codex default runs developer and research rows on gpt-6.1-sol by size, review on gpt-6-sol, astra at depth 5 and ultra', async () => {
  await withDir(async (root) => {
    const cache = await writeCache(root, CACHE_MODELS);
    const result = probe({ runtime: 'codex', projectRoot: root, modelsCachePath: cache });
    assert.equal(result.models.warning_reason, null);
    const ladder = ['medium', 'medium', 'high', 'xhigh', 'xhigh'];
    assert.deepEqual(DEVELOPER_ROWS.map((row) => result.models[row]), ladder.map((effort) => ({ model: 'gpt-6.1-sol', effort })));
    assert.deepEqual(RESEARCH_ROWS.map((row) => result.models[row]), ladder.map((effort) => ({ model: 'gpt-6.1-sol', effort })));
    assert.deepEqual(REVIEWER_ROWS.map((row) => result.models[row]), [
      { model: 'gpt-6-sol', effort: 'medium' }, { model: 'gpt-6-sol', effort: 'high' }, { model: 'gpt-6-sol', effort: 'xhigh' }, { model: 'gpt-6-sol', effort: 'xhigh' }, { model: 'gpt-6-astra', effort: 'xhigh' },
    ]);
    assert.deepEqual(result.models.reviewer_ultra, { model: 'gpt-6-astra', effort: 'ultra' });
    assert.deepEqual(result.spawn_args.developer_ultra, { fork_turns: 'none', model: 'gpt-6.1-sol', reasoning_effort: 'ultra' });
    // An override clamps to the model's levels; a default missing from the cache inherits the session model.
    const clamped = probe({ runtime: 'codex', projectRoot: root, model: 'gpt-5.5', modelsCachePath: cache });
    assert.deepEqual([clamped.models.developer_ultra.effort, clamped.models.developer_m.effort], ['xhigh', 'high']);
    const inherited = probe({ runtime: 'codex', projectRoot: root, modelsCachePath: await writeCache(root, [CACHE_MODELS[3]]) });
    assert.equal(inherited.models.warning_reason, 'ceiling_not_in_models_cache');
    assert.deepEqual(inherited.spawn_args.developer_ultra, { fork_turns: 'none', reasoning_effort: 'ultra' });
    const unknown = probe({ runtime: 'codex', projectRoot: root, model: 'gpt-9-future', modelsCachePath: cache });
    assert.equal(unknown.models.warning_reason, 'override_not_in_models_cache');
    assert.equal(probe({ runtime: 'codex', projectRoot: root, modelsCachePath: join(root, 'absent.json') }).models.reviewer_depth_5.model, 'gpt-6-astra');
  });
});

test('the profile becomes the policy, rung by rung, with the tracker check and the terminology path', async () => {
  await withDir(async (root) => {
    const dir = await repo(root, { version: 1, tracker: { kind: 'file', prefix: 'PRJ' }, delivery: 'merge_push', references: { terminology: 'docs/terms.md' }, checks: ['npm test'], worktree: { root: '.worktrees' } });
    const result = probe({ runtime: 'claude', projectRoot: dir, key: 'PRJ-7', defaults: { base: 'develop', returns: 5 }, tracker: { kind: 'file', label: 'file-dispatcher' } });
    assert.equal(result.ok, true);
    assert.equal(result.version, JSON.parse(execFileSync('cat', ['package.json'], { encoding: 'utf8' })).version);
    assert.deepEqual(result.policy, { base: 'develop', delivery: 'merge_push', returns: 5, source: { base: 'adapter', delivery: 'profile', returns: 'adapter' } });
    assert.deepEqual(result.tracker, { declared: true, kind: 'file', prefix: 'PRJ', problems: [] });
    assert.deepEqual([result.profile.present, result.profile.checks, result.profile.worktree, result.profile.stage, result.profile.error], [true, true, true, false, null]);
    assert.equal(result.references.terminology, join(await realpath(dir), 'docs', 'terms.md'));
    assert.deepEqual(result.references_missing, []);
    assert.equal(result.repo.default_branch, 'main');
    assert.ok(result.run_dir.includes(join('dream-team', 'PRJ-7')));
    assert.equal(typeof result.scripts.validate_profile, 'string');
    assert.ok(result.roles.present.includes('code-reviewer'));

    const wrong = probe({ runtime: 'claude', projectRoot: dir, key: 'SB-1', tracker: { kind: 'plane', label: 'plane-dispatcher' } });
    assert.deepEqual(wrong.tracker.problems, [
      'Профиль проекта объявляет трекер file с префиксом PRJ, а команда пришла из plane-dispatcher. Запусти задачу через её диспетчер или поправь блок tracker',
      'Ключ SB-1 не из проекта PRJ, который объявляет dreamteam.json',
    ]);

    const bare = await repo(join(root, 'two'), null);
    const none = probe({ runtime: 'claude', projectRoot: bare, key: 'PRJ-1' });
    assert.deepEqual(none.policy, { base: 'main', delivery: 'branch', returns: 2, source: { base: 'repository', delivery: 'dream-team', returns: 'dream-team' } });
    assert.deepEqual([none.profile.present, none.profile.checks, none.tracker.declared], [false, false, false]);

    const broken = await repo(join(root, 'three'), { version: 1, delivery: 'push' });
    const invalid = probe({ runtime: 'claude', projectRoot: broken, key: 'PRJ-1' });
    assert.equal(invalid.profile.error.code, 'profile_invalid');
    assert.equal(invalid.profile.error.key, 'delivery');
    assert.deepEqual(invalid.profile.error.detail, ['dreamteam.json: delivery принимает merge_push или branch, получено "push"']);
  });
});
