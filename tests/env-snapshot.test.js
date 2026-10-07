import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'env-snapshot', 'scripts', 'env-snapshot.mjs');

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function repo(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'env-snapshot-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const snapshot = (dir) => JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', '--skip=rules,docs'], { cwd: dir, encoding: 'utf8' }));
const byTool = (validation, tool) => validation.checks.find((check) => check.tool === tool);

test('node scripts are classified by the binary they run, not by their name', async () => {
  const dir = await repo({
    'package-lock.json': '{}',
    'package.json': {
      name: 'fixture',
      scripts: {
        'check:types': 'tsc -p tsconfig.json --noEmit',
        lint: 'eslint . --config eslint.config.mjs --max-warnings 0',
        test: 'vitest run',
        'test:watch': 'vitest --watch',
        smoke: 'bash scripts/check.sh',
      },
    },
  });
  const { validation } = snapshot(dir);

  assert.equal(byTool(validation, 'vitest').scope, 'related');
  assert.equal(byTool(validation, 'vitest').command, 'npx vitest related {paths}');
  assert.equal(byTool(validation, 'eslint').scope, 'paths');
  // The configuration the script carries survives; the target it hardcodes does not.
  assert.equal(byTool(validation, 'eslint').command, 'npx eslint --config eslint.config.mjs --max-warnings 0 {paths}');
  assert.equal(byTool(validation, 'tsc').scope, 'none');
  assert.match(byTool(validation, 'tsc').reason, /ignores tsconfig\.json/);
  // A body running an unrecognized program is no check at all.
  assert.equal(validation.checks.some((check) => check.source === 'npm run smoke'), false);
  // A watch run never returns, so it never becomes a check.
  assert.equal(validation.checks.some((check) => check.source === 'npm run test:watch'), false);
  assert.deepEqual(validation.suite, ['npm run check:types && npm run lint && npm run test']);
});

test('php scripts split into what narrows safely and what does not', async () => {
  const dir = await repo({
    'composer.json': {
      name: 'acme/fixture',
      scripts: {
        cs: 'vendor/bin/pint --test',
        analyse: '@php vendor/bin/phpstan analyse --configuration=phpstan.neon',
        'rector-dry': 'vendor/bin/rector process --dry-run',
        test: 'vendor/bin/phpunit --testdox',
      },
    },
  });
  const { validation } = snapshot(dir);

  assert.equal(byTool(validation, 'pint').command, 'vendor/bin/pint --test {paths}');
  assert.equal(byTool(validation, 'phpunit').scope, 'tests-by-path');
  assert.equal(byTool(validation, 'phpunit').command, 'vendor/bin/phpunit --testdox {test paths}');
  // Rector rewrites files, so only its dry form is a check — and the flag is never doubled.
  assert.equal(byTool(validation, 'rector').command, 'vendor/bin/rector process --dry-run {paths}');
  assert.equal(byTool(validation, 'phpstan').scope, 'none');
  assert.match(byTool(validation, 'phpstan').reason, /consume it/);
  // The runner executes the binary itself, so the wrapper configuration can replace -c.
  assert.equal(byTool(validation, 'phpstan').run, 'vendor/bin/phpstan analyse --configuration=phpstan.neon');
});

test('a script that rewrites files is never a check, and two scripts with one run are one check', async () => {
  const dir = await repo({
    'package-lock.json': '{}',
    'package.json': {
      name: 'fixture',
      scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix', 'lint:prune': 'eslint --prune-suppressions src', format: 'prettier --write .' },
    },
    'composer.json': {
      name: 'acme/fixture',
      scripts: {
        phpstan: 'vendor/bin/phpstan analyse --memory-limit=4G',
        'phpstan-baseline': 'vendor/bin/phpstan analyse --generate-baseline --memory-limit=4G',
        rector: 'vendor/bin/rector process',
        'rector-dry': 'vendor/bin/rector process --dry-run',
      },
    },
  });
  const { validation } = snapshot(dir);
  const of = (tool) => validation.checks.filter((check) => check.tool === tool);
  assert.deepEqual(of('eslint').map((check) => [check.source, check.command, check.lang]), [['npm run lint', 'npx eslint {paths}', 'node']]);
  assert.deepEqual(of('prettier').map((check) => check.command), ['npx prettier --check {paths}']);
  assert.deepEqual(of('phpstan').map((check) => [check.source, check.run]), [['composer phpstan', 'vendor/bin/phpstan analyse --memory-limit=4G']]);
  assert.deepEqual(of('rector').map((check) => [check.source, check.command, check.lang]), [['composer rector', 'vendor/bin/rector process --dry-run {paths}', 'php']]);
});

test('a target that cannot be told from a flag value is reported, never guessed', async () => {
  const dir = await repo({
    'composer.json': { name: 'acme/fixture', scripts: { test: 'vendor/bin/phpunit --configuration phpunit.xml' } },
  });
  const narrowed = byTool(snapshot(dir).validation, 'phpunit');
  assert.equal(narrowed.scope, 'none');
  assert.equal(narrowed.run, 'vendor/bin/phpunit --configuration phpunit.xml');

  const odd = await repo({
    'composer.json': { name: 'acme/fixture', scripts: { test: 'vendor/bin/phpunit --unknown-flag tests/Unit' } },
  });
  const bailed = byTool(snapshot(odd).validation, 'phpunit');
  assert.equal(bailed.scope, 'none');
  assert.equal(bailed.command, 'composer test');
  assert.match(bailed.reason, /cannot tell the target from the value of --unknown-flag tests\/Unit/);
});

test('a repository without manifests derives nothing and says so', async () => {
  const { validation } = snapshot(await repo());
  assert.deepEqual(validation.checks, []);
  assert.deepEqual(validation.suite, []);
  assert.deepEqual(validation.notes, ['no validation commands derived; check project manifests or repository docs']);
  assert.match(validation.scope_source, /git diff --name-only/);
});

test('env files are reported by name and never read', async () => {
  const dir = await repo({ '.env': 'SECRET=do-not-print\n' });
  const text = execFileSync(process.execPath, [scriptPath, '--skip=rules,docs'], { cwd: dir, encoding: 'utf8' });
  assert.match(text, /env files \(names only, contents never read\): \.env/);
  assert.equal(text.includes('do-not-print'), false);
});

const commit = (dir, message) => {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', message]);
};
const changed = (workspace) => workspace.changed_paths_vs_base.map((line) => line.split('\t')[1]);

test('a linked worktree is told from the primary checkout, with the path of the primary', async () => {
  const primary = await realpath(await repo({ 'a.txt': 'a\n' }));
  commit(primary, 'init');
  const tree = join(primary, '.worktrees', 'TASK-1');
  sh(primary, 'git', ['worktree', 'add', '-q', '-b', 'TASK-1', tree]);

  assert.equal(snapshot(primary).workspace.placement, 'primary');
  assert.equal(snapshot(primary).workspace.primary, undefined);
  const { workspace } = snapshot(tree);
  assert.equal(workspace.placement, 'worktree');
  assert.equal(workspace.primary, primary);
  assert.equal(workspace.worktrees, undefined);
});

test('the base is the remote ref, not the local branch that lags it', async () => {
  const dir = await repo({ 'a.txt': 'a\n' });
  commit(dir, 'init');
  sh(dir, 'git', ['checkout', '-q', '-b', 'upstream']);
  await writeFile(join(dir, 'theirs.txt'), 'theirs\n');
  commit(dir, 'someone else');
  sh(dir, 'git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'TASK-1']);
  await writeFile(join(dir, 'mine.txt'), 'mine\n');
  commit(dir, 'task');

  const { workspace } = snapshot(dir);
  assert.equal(workspace.detected_base, 'origin/main');
  assert.deepEqual(changed(workspace), ['mine.txt']);
});

test('--base names the parent branch of a subtask; an unknown base is reported, never replaced', async () => {
  const dir = await repo({ 'a.txt': 'a\n' });
  commit(dir, 'init');
  sh(dir, 'git', ['checkout', '-q', '-b', 'PARENT']);
  await writeFile(join(dir, 'parent.txt'), 'parent\n');
  commit(dir, 'parent');
  sh(dir, 'git', ['checkout', '-q', '-b', 'SUB']);
  await writeFile(join(dir, 'sub.txt'), 'sub\n');
  commit(dir, 'sub');
  const run = (...flags) => JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', '--skip=rules,docs', ...flags], { cwd: dir, encoding: 'utf8' })).workspace;

  assert.deepEqual(changed(run()), ['parent.txt', 'sub.txt']);
  assert.deepEqual(changed(run('--base=PARENT')), ['sub.txt']);
  const missing = run('--base=nope');
  assert.equal(missing.base_error, 'base ref not found: nope');
  assert.equal(missing.detected_base, undefined);
});

test('a run from a subdirectory reads the manifests and rules of the repository root', async () => {
  const dir = await repo({ 'package.json': { name: 'x', scripts: {} }, 'package-lock.json': '{}', 'AGENTS.md': '# rules\n' });
  await mkdir(join(dir, 'src'));
  const out = JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', '--skip=docs'], { cwd: join(dir, 'src'), encoding: 'utf8' }));
  assert.deepEqual(out.project.lockfiles, ['package-lock.json']);
  assert.deepEqual(out.rules.map((doc) => doc.path), ['AGENTS.md']);
});

test('dependency directories are reported as absent, present or a symlink with its target', async () => {
  const dir = await repo({ 'package.json': { name: 'x' }, 'composer.json': { name: 'x/y' } });
  assert.deepEqual(snapshot(dir).project.dependencies, { node_modules: 'absent', vendor: 'absent' });
  await mkdir(join(dir, 'vendor'));
  await symlink('/primary/node_modules', join(dir, 'node_modules'));
  assert.deepEqual(snapshot(dir).project.dependencies, { node_modules: 'symlink → /primary/node_modules', vendor: 'present' });
});

test('validation rides in JSON only and can be skipped; the README is listed, never embedded', async () => {
  const dir = await repo({ 'package.json': { name: 'x', scripts: { lint: 'eslint .' } }, 'README.md': 'readme-body\n' });
  const text = execFileSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' });
  assert.equal(/validation|eslint/.test(text), false);
  assert.match(text, /- README\.md \(12 bytes, content skipped\)/);
  assert.equal(text.includes('readme-body'), false);
  const out = JSON.parse(execFileSync(process.execPath, [scriptPath, '--json', '--skip=validation'], { cwd: dir, encoding: 'utf8' }));
  assert.equal(out.validation, undefined);
  assert.equal(out.tooling, undefined);
});
