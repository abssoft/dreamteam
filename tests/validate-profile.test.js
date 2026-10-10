import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { checkItems, normalizeProfile, profileProblems, resolvePolicy, trackerProblems } from '../contracts/validate-profile.mjs';

const root = process.cwd();
const scriptPath = join(root, 'contracts', 'validate-profile.mjs');
const schema = JSON.parse(fs.readFileSync(join(root, 'contracts', 'profile-v1.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

function run(args, input) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', input });
  return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').pop()) };
}

// The shapes of the profiles in use: a bare gate, a gate with trees and a
// compose stage, trees with a start stage and no gate.
const LIVE = [
  { version: 1, checks: ["sh scripts/worktree-exec.sh 'composer test'", 'sh scripts/noverify.sh'] },
  { version: 1, checks: ['make check', 'make check-build'], worktree: { root: '.worktrees', link: ['docker-compose.dev.yml'], copy: ['.env'], setup: [] }, stage: { ports: ['app', 'vite'], up: 'bin/stage up', down: 'bin/stage down', status: 'bin/stage status', health: '/up', env: { APP_PORT: '{port.app}' }, migrations: { pending: 'bin/stage pending', apply: 'bin/stage apply' }, cleanup: ['bin/stage cleanup'] } },
  { version: 1, worktree: { root: '.worktrees', link: ['.env'], copy: [], setup: ['pnpm install'] }, stage: { ports: ['app'], start: 'pnpm exec next dev --port {port.app}', health: '/api/health', env: { APP_BASE_URL: '{url}' }, migrations: { pending: 'pnpm -s migrations:pending', apply: 'pnpm prisma migrate deploy' }, cleanup: [] } },
];

test('the live profile shapes and the example pass the validator and the schema alike', () => {
  const example = JSON.parse(fs.readFileSync(join(root, 'contracts', 'examples', 'profile.json'), 'utf8'));
  for (const profile of [...LIVE, example]) {
    assert.deepEqual(profileProblems(profile), []);
    assert.equal(validate(profile), true, JSON.stringify(validate.errors));
  }
  const normalized = normalizeProfile(LIVE[2]);
  assert.equal(normalized.checks, null);
  assert.deepEqual(normalized.worktree, { root: '.worktrees', link: ['.env'], copy: [], setup: ['pnpm install'] });
  assert.equal(normalized.stage.scheme, 'http');
  assert.deepEqual(normalized.references, { terminology: null });
  assert.deepEqual(checkItems(example), [
    { run: 'npm test', baseline: null, diagnostic: null },
    { run: 'vendor/bin/noverify check ./src', baseline: 'files_outside_diff', diagnostic: '^(?<file>\\S+\\.php):\\d+' },
  ]);
});

test('every violation is named with its key, in the words the role prints', () => {
  const broken = { version: 1, foo: 1, delivery: 'push', returns: 99, base: 'bad branch', tracker: { kind: 'YouTrack', prefix: 'dev', token: 'x', nested: { api_key: 'y' } }, references: { terminology: '/abs/terms.md', other: 1 }, checks: [{ run: 'x', baseline: 'files_outside_diff' }, { run: 'y', baseline: 'files_outside_diff', diagnostic: '(' }, { run: 'z', diagnostic: 'no group' }, 42], worktree: { root: '../out' }, stage: { ports: ['app', 'app'], health: 'up' } };
  const problems = profileProblems(broken);
  for (const expected of [
    'dreamteam.json: неизвестный ключ foo',
    'dreamteam.json: delivery принимает merge_push или branch, получено "push"',
    'dreamteam.json: returns — целое число от 0 до 20',
    'dreamteam.json: base — имя ветки',
    'dreamteam.json: tracker.kind — имя трекера строчными буквами',
    'dreamteam.json: tracker.prefix — префикс ключей заглавными буквами',
    'dreamteam.json: ключ tracker.token похож на секрет; секреты живут в .env',
    'dreamteam.json: ключ tracker.nested.api_key похож на секрет; секреты живут в .env',
    'dreamteam.json: неизвестный ключ references.other',
    'dreamteam.json: references.terminology — относительный путь внутри репозитория',
    'dreamteam.json: checks[0].baseline требует diagnostic',
    'dreamteam.json: checks[2].diagnostic — нужна именованная группа (?<file>…)',
    'dreamteam.json: checks[3] — команда строкой или объект {run, baseline, diagnostic}',
    'dreamteam.json: worktree.root — относительный путь внутри репозитория',
    'dreamteam.json: stage.ports — уникальные имена слотов',
    'dreamteam.json: stage.start или stage.up/down/status',
    'dreamteam.json: stage.health — путь, начинающийся с /',
  ]) assert.ok(problems.includes(expected), `${expected}\n${problems.join('\n')}`);
  assert.ok(problems.some((item) => item.startsWith('dreamteam.json: checks[1].diagnostic — регулярка не компилируется')));
  assert.equal(validate(broken), false);
  assert.deepEqual(profileProblems({ version: 2 }), ['dreamteam.json: version должен быть 1']);
  assert.deepEqual(profileProblems({ version: 1, stage: { ports: ['app'], start: 'x', health: '/' } }), ['dreamteam.json: stage требует блок worktree']);
  assert.deepEqual(profileProblems([]), ['dreamteam.json: ожидается объект']);
});

test('policy resolves profile → adapter defaults → DreamTeam defaults, with the rung of every value', () => {
  const profile = normalizeProfile({ version: 1, delivery: 'merge_push' });
  assert.deepEqual(resolvePolicy(profile, { base: 'develop', returns: 5 }), { base: 'develop', delivery: 'merge_push', returns: 5, source: { base: 'adapter', delivery: 'profile', returns: 'adapter' } });
  assert.deepEqual(resolvePolicy(normalizeProfile({ version: 1 }), {}), { base: null, delivery: 'branch', returns: 2, source: { base: 'repository', delivery: 'dream-team', returns: 'dream-team' } });
  assert.deepEqual(resolvePolicy(null, { delivery: 'merge_push' }).source, { base: 'repository', delivery: 'adapter', returns: 'dream-team' });
});

test('the tracker block is checked against the dispatcher and the key; a profile without it passes silently', () => {
  const profile = normalizeProfile({ version: 1, tracker: { kind: 'youtrack', prefix: 'DEV' } });
  assert.deepEqual(trackerProblems(profile, { kind: 'plane', caller: 'plane-dispatcher', key: 'SB-12' }), [
    'Профиль проекта объявляет трекер youtrack с префиксом DEV, а команда пришла из plane-dispatcher. Запусти задачу через её диспетчер или поправь блок tracker',
    'Ключ SB-12 не из проекта DEV, который объявляет dreamteam.json',
  ]);
  assert.deepEqual(trackerProblems(profile, { kind: 'youtrack', key: 'DEV-7' }), []);
  assert.deepEqual(trackerProblems(profile, { kind: 'plane' }), ['Профиль проекта объявляет трекер youtrack с префиксом DEV, а команда пришла из диспетчера plane. Запусти задачу через её диспетчер или поправь блок tracker']);
  assert.deepEqual(trackerProblems(normalizeProfile({ version: 1 }), { kind: 'plane', key: 'SB-1' }), []);
});

test('the CLI validates a file or stdin, resolves the policy and exits 1 on a bad profile', () => {
  const ok = run(['--profile', join(root, 'contracts', 'examples', 'profile.json'), '--defaults', '{"returns":1}', '--tracker', 'plane', '--key', 'PRJ-3']);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.policy, { base: 'main', delivery: 'merge_push', returns: 5, source: { base: 'profile', delivery: 'profile', returns: 'profile' } });
  assert.equal(ok.json.checks.length, 2);
  assert.deepEqual(ok.json.tracker, { declared: true, kind: 'file', prefix: 'PRJ', problems: ['Профиль проекта объявляет трекер file с префиксом PRJ, а команда пришла из диспетчера plane. Запусти задачу через её диспетчер или поправь блок tracker'] });
  assert.deepEqual(ok.json.references, { terminology: 'docs/terms.md' });
  const bad = run(['--profile', '-'], JSON.stringify({ version: 1, delivery: 'push' }));
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.json, { ok: false, code: 'bad_profile', detail: ['dreamteam.json: delivery принимает merge_push или branch, получено "push"'] });
  assert.equal(run(['--profile', '-'], '{ nope').json.code, 'bad_profile');
  assert.equal(run([]).json.code, 'bad_args');
  assert.equal(run(['--profile', '-', '--defaults', 'x'], '{}').json.code, 'bad_args');
  const usage = execFileSync(process.execPath, [scriptPath, '--profile', join(root, 'contracts', 'examples', 'profile.json')], { encoding: 'utf8' });
  assert.ok(usage.startsWith('{"ok":true'));
});
