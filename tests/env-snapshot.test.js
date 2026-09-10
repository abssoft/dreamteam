import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

test('a target that cannot be told from a flag value is reported, never guessed', async () => {
  const dir = await repo({
    'composer.json': { name: 'acme/fixture', scripts: { test: 'vendor/bin/phpunit --configuration phpunit.xml' } },
  });
  const narrowed = byTool(snapshot(dir).validation, 'phpunit');
  assert.equal(narrowed.command, 'vendor/bin/phpunit --configuration phpunit.xml {test paths}');

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
