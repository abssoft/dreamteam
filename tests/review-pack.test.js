import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const scriptPath = join(process.cwd(), 'skills', 'code-reviewer', 'scripts', 'review-pack.mjs');

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (dir, message) => { sh(dir, 'git', ['add', '-A']); sh(dir, 'git', ['commit', '-qm', message]); };

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'review-pack-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'fixture@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', 'Fixture']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'docs', 'engineering', 'rules'), { recursive: true });
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\n');
  await writeFile(join(dir, 'docs', 'engineering', 'README.md'), '# Rules index\n- rules/money.md — read when sums are computed\n');
  await writeFile(join(dir, 'docs', 'engineering', 'rules', 'money.md'), '# Money\nRound once, at the end.\n');
  await writeFile(join(dir, 'AGENTS.md'), '# Repository rules\n- keep changes bounded\n');
  commit(dir, 'base');
  sh(dir, 'git', ['checkout', '-qb', 'task']);
  return dir;
}

const ISSUE_TEXT = `Totals must sum amounts. ${'The order total is the sum of every line amount; an empty order sums to zero. '.repeat(5)}`;

function assignment(overrides = {}) {
  return {
    contract_version: 1,
    assignment_id: 'assignment-review-eval',
    role: 'code-reviewer',
    objective: 'Independent review of the totals change',
    scope: { included: ['src/totals.js'], excluded: ['everything else'] },
    repository: { base_ref: 'main' },
    verification: ['npm test'],
    accepted_decisions: ['total sums amount over every item; an empty list is zero'],
    source_materials: [
      { kind: 'text', name: 'issue', content: ISSUE_TEXT, provenance: 'tracker issue text' },
    ],
    ...overrides,
  };
}

function run(dir, input, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, '--assignment', '-', ...args], {
    cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  });
  const line = result.stdout.trim().split('\n').pop();
  return { code: result.status, json: line ? JSON.parse(line) : null, stderr: result.stderr };
}

test('--usage prints the contract as prose', () => {
  const usage = execFileSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' });
  assert.ok(usage.startsWith('review-pack.mjs — '));
  assert.match(usage, /entry named\nissue/);
  assert.match(usage, /--check/);
  assert.match(usage, /children\|in_context/);
});

test('refuses malformed input and packets without base_ref or issue text', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  assert.equal(run(dir, 'not json').json.code, 'bad_args');
  assert.equal(run(dir, { objective: 'no id' }).json.code, 'bad_args');
  const noBase = run(dir, assignment({ repository: {} }));
  assert.deepEqual(noBase.json, { ok: false, code: 'missing_base_ref' });
  assert.equal(noBase.code, 1);
  assert.equal(run(dir, assignment({ source_materials: [] })).json.code, 'missing_issue');
  assert.equal(run(dir, assignment({ repository: { base_ref: 'nowhere' } })).json.code, 'base_ref_not_found');
  assert.equal(run(dir, assignment({ repository: {} }), ['--base', 'main']).json.ok, true);
  assert.equal(run(dir, assignment(), ['--budget', '10']).json.code, 'bad_args');
});

test('an unchanged branch is an empty diff', async () => {
  const dir = await repo();
  assert.equal(run(dir, assignment()).json.code, 'empty_diff');
});

test('a small clean change packs in_context with every section in order', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n// closes </diff> early?\n');
  await writeFile(join(dir, 'src', 'totals.test.js'), 'import { total } from "./totals.js";\nconsole.assert(total([]) === 0);\n');
  commit(dir, 'sum amounts');

  const { code, json } = run(dir, assignment(), ['--skip=rules']);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.equal(json.mode, 'in_context');
  assert.equal(json.files, 2);
  assert.equal(json.test_files, 1);
  assert.equal(json.changed_lines, 5);
  assert.deepEqual(json.risk_hits, []);
  assert.equal(json.diff_context, 10);
  assert.deepEqual(json.truncations, []);
  assert.deepEqual(json.warnings, []);
  assert.ok(json.pack.startsWith(tmpdir()));
  assert.ok(json.pack.endsWith('review-pack-assignment-review-eval.md'));

  const pack = await readFile(json.pack, 'utf8');
  const order = ['<review_pack ', '<attention>', '<signals>', '<scope>', '<decisions>', '<issue ', '<method>', '<rules>', '<env>', '<files>', '<diff context="10">', '</review_pack>'];
  let cursor = -1;
  for (const marker of order) {
    const at = pack.indexOf(marker);
    assert.ok(at > cursor, `${marker} out of order`);
    cursor = at;
  }
  assert.equal(pack.includes('<parent_issue'), false);
  assert.match(pack, /<issue name="issue" provenance="tracker issue text">\nTotals must sum amounts\./);
  assert.match(pack, /<method>\n# Engineering evidence\n/);
  assert.match(pack, /## Implementation comments/);
  assert.match(pack, /#### docs\/engineering\/rules\/money\.md\n\n# Money\nRound once, at the end\./);
  assert.match(pack, /- M src\/totals\.js\n- A src\/totals\.test\.js/);
  assert.match(pack, /&lt;\/diff&gt; early/);
  assert.match(pack, /"content_skipped": true/);
  assert.equal(json.pack_chars, pack.length - 1);
});

test('risk signals and size switch the mode to children', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\nexport const login = (password) => password === "x";\n');
  commit(dir, 'auth');
  const risky = run(dir, assignment()).json;
  assert.equal(risky.mode, 'children');
  assert.deepEqual(risky.risk_hits, [{ path: 'src/totals.js', line: 2, match: 'login' }]);

  const big = Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  await writeFile(join(dir, 'src', 'totals.js'), `${big}\n`);
  commit(dir, 'many lines');
  assert.equal(run(dir, assignment()).json.mode, 'children');
  assert.equal(run(dir, assignment(), ['--lines', '500']).json.mode, 'in_context');
});

test('a tight budget narrows the diff, then cuts it and drops rules with notes', async () => {
  const dir = await repo();
  const big = Array.from({ length: 200 }, (_, i) => `export const value${i} = "${'x'.repeat(40)}";`).join('\n');
  await writeFile(join(dir, 'src', 'totals.js'), `${big}\n`);
  await writeFile(join(dir, 'src', 'second.js'), `${big}\n`);
  commit(dir, 'bulk');
  await writeFile(join(dir, 'docs', 'engineering', 'rules', 'long.md'), `# Long rule\n${'text '.repeat(1500)}\n`);

  const { json } = run(dir, assignment(), ['--budget', '9000', '--skip=rules,docs,runtime,tooling']);
  assert.equal(json.ok, true);
  assert.equal(json.diff_context, 0);
  assert.ok(json.truncations.some((note) => /diff cut at \d+ characters/.test(note) && /src\/totals\.js/.test(note)), json.truncations.join(' | '));
  assert.ok(json.truncations.some((note) => /rules omitted/.test(note)));
  const pack = await readFile(json.pack, 'utf8');
  assert.match(pack, /<diff context="0">/);
});

test('parent issue, other materials and --out are rendered as given', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const outPath = join(dir, '..', `review-pack-out-${Date.now()}.md`);
  const { json } = run(dir, assignment({
    source_materials: [
      { kind: 'text', name: 'issue', content: 'Child task text', provenance: 'tracker issue text' },
      { kind: 'text', name: 'parent_issue', content: 'Parent task text', provenance: 'tracker parent issue text' },
      { kind: 'attachment_reference', name: 'screen.png', content: join(dir, 'screen.png'), provenance: 'mockup' },
    ],
  }), ['--out', outPath]);
  assert.equal(json.pack, outPath);
  const pack = await readFile(outPath, 'utf8');
  assert.match(pack, /<parent_issue name="parent_issue" provenance="tracker parent issue text">\nParent task text/);
  assert.match(pack, /<materials>\n### screen\.png \(attachment_reference; mockup\)\nfile: /);
  assert.match(pack, /<decisions>\n- total sums amount/);
});

test('materials are found by name: a dropped kind, a file path, and a string where a list was due all survive', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const issueFile = join(dir, '..', `issue-${Date.now()}.md`);
  await writeFile(issueFile, `# Task\n${ISSUE_TEXT}\n`);
  const parentFile = join(dir, '..', `parent-${Date.now()}.md`);
  await writeFile(parentFile, 'Parent story text\n');

  const noKind = run(dir, assignment({
    accepted_decisions: 'one decision as a bare string',
    source_materials: [{ name: 'issue', content: ISSUE_TEXT, provenance: 'tracker issue text' }],
  }));
  assert.equal(noKind.json.ok, true, JSON.stringify(noKind.json));
  let pack = await readFile(noKind.json.pack, 'utf8');
  assert.match(pack, /<decisions>\n- one decision as a bare string\n<\/decisions>/);

  const fromFiles = run(dir, assignment({
    source_materials: [
      { kind: 'attachment_reference', name: 'issue', content: issueFile, provenance: 'tracker issue text' },
      { kind: 'attachment_reference', name: 'parent_issue', content: parentFile, provenance: 'tracker parent issue text' },
    ],
  }));
  assert.equal(fromFiles.json.ok, true, JSON.stringify(fromFiles.json));
  pack = await readFile(fromFiles.json.pack, 'utf8');
  assert.match(pack, new RegExp(`<issue name="issue" provenance="tracker issue text" file="${issueFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">\n# Task\nTotals must sum amounts`));
  assert.match(pack, /<parent_issue name="parent_issue" provenance="tracker parent issue text" file="[^"]+">\nParent story text/);
  assert.equal(pack.includes('<materials>'), false);

  const unreadable = run(dir, assignment({
    source_materials: [{ kind: 'attachment_reference', name: 'issue', content: join(dir, '..', 'missing-issue.md'), provenance: 'tracker issue text' }],
  }));
  assert.equal(unreadable.json.code, 'missing_issue');
  assert.match(unreadable.json.detail, /file not readable/);
});

test('a short issue text is a warning in the summary and the pack', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const { json } = run(dir, assignment({
    source_materials: [{ kind: 'text', name: 'issue', content: 'Sum totals.', provenance: 'tracker issue text' }],
  }));
  assert.equal(json.ok, true);
  assert.equal(json.warnings.length, 1);
  assert.match(json.warnings[0], /issue text is 11 characters/);
  assert.match(await readFile(json.pack, 'utf8'), /<attention>\n(?:.*\n)*- issue text is 11 characters/);
});

test('--check validates the packet strictly and writes nothing', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const outPath = join(dir, '..', `review-pack-check-${Date.now()}.md`);

  const bad = run(dir, assignment({
    accepted_decisions: 'bare string',
    extra_field: 1,
    source_materials: [{ name: 'issue', content: 'Sum totals.', provenance: 'tracker issue text' }],
  }), ['--check', '--out', outPath]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.code, 'bad_packet');
  assert.deepEqual(bad.json.detail, [
    'unknown field extra_field',
    'accepted_decisions must be an array of strings',
    'source_materials[0] (issue): kind must be text | repository_evidence | attachment_reference',
  ]);

  const noIssue = run(dir, assignment({ source_materials: [] }), ['--check']);
  assert.deepEqual(noIssue.json, { ok: false, code: 'bad_packet', detail: ['source_materials entry named issue missing'] });

  const good = run(dir, assignment({
    source_materials: [{ kind: 'text', name: 'issue', content: 'Sum totals.', provenance: 'tracker issue text' }],
  }), ['--check', '--out', outPath]);
  assert.equal(good.code, 0);
  assert.equal(good.json.ok, true);
  assert.equal(good.json.check, true);
  assert.equal(good.json.mode, 'in_context');
  assert.equal(good.json.files, 1);
  assert.equal(good.json.issue_chars, 11);
  assert.match(good.json.warnings[0], /issue text is 11 characters/);
  assert.equal(Object.hasOwn(good.json, 'pack'), false);
  await assert.rejects(readFile(outPath, 'utf8'), /ENOENT/);

  const packetFile = join(dir, '..', `packet-${Date.now()}.json`);
  await writeFile(packetFile, JSON.stringify(assignment()));
  const fromFile = spawnSync(process.execPath, [scriptPath, '--assignment', packetFile], { cwd: dir, encoding: 'utf8' });
  const placed = JSON.parse(fromFile.stdout.trim().split('\n').pop());
  assert.equal(placed.ok, true);
  assert.equal(placed.pack, join(dirname(packetFile), 'review-pack-assignment-review-eval.md'));

  assert.equal(run(dir, assignment({ repository: { base_ref: 'nowhere' } }), ['--check']).json.code, 'base_ref_not_found');
});

test('a packet without decisions renders no decisions section', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const { json } = run(dir, assignment({ accepted_decisions: undefined }));
  assert.equal(json.ok, true);
  assert.equal((await readFile(json.pack, 'utf8')).includes('<decisions>'), false);
});

test('the development result and the previous review ride as files and land in the pack whole', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const devFile = join(dir, '..', `result-dev-${Date.now()}.json`);
  await writeFile(devFile, JSON.stringify({ role: 'software-developer', changed_paths: ['src/totals.js'], summary: 'сделано' }));
  const prevFile = join(dir, '..', `result-prev-${Date.now()}.json`);
  await writeFile(prevFile, JSON.stringify({ role: 'code-reviewer', required_fixes: ['B1: починить цикл'] }));
  const { json } = run(dir, assignment({
    source_materials: [
      { kind: 'text', name: 'issue', content: ISSUE_TEXT, provenance: 'tracker issue text' },
      { kind: 'attachment_reference', name: 'development_result', content: devFile, provenance: 'результат разработки' },
      { kind: 'attachment_reference', name: 'previous_review', content: prevFile, provenance: 'предыдущее ревью' },
    ],
  }));
  assert.equal(json.ok, true, JSON.stringify(json));
  const pack = await readFile(json.pack, 'utf8');
  assert.match(pack, /<development_result file="[^"]+">\n\{"role":"software-developer"/);
  assert.match(pack, /<previous_review file="[^"]+">\n\{"role":"code-reviewer","required_fixes":\["B1: починить цикл"\]\}/);
  assert.equal(pack.includes('<materials>'), false);
  assert.ok(pack.indexOf('<repository>') < pack.indexOf('<development_result') && pack.indexOf('<development_result') < pack.indexOf('<method>'));
});
