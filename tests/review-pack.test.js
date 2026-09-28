import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resultProblems } from '../contracts/validate-result.mjs';

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
  await writeFile(join(dir, 'AGENTS.md'), '# Repository rules\n- keep changes bounded\n- naming lives in docs/style.md\n');
  await writeFile(join(dir, 'docs', 'style.md'), '# Style\nName a total after what it sums.\n');
  commit(dir, 'base');
  sh(dir, 'git', ['checkout', '-qb', 'task']);
  return dir;
}

const ISSUE_TEXT = `Totals must sum amounts. ${'The order total is the sum of every line amount; an empty order sums to zero. '.repeat(5)}`;
const QA_MATERIAL = { kind: 'text', name: 'qa_result', content: JSON.stringify({ kind: 'qa_result', verdict: 'green', checks: [{ id: 'c1', tool: 'vitest', command: 'npx vitest related src/totals.js', width: 'narrowed to the change', status: 'passed' }], obstacles: [], summary: { passed: 1, failed: 0, broken: 0, skipped: 0 } }), provenance: 'результат QA' };

// Every packet carries the QA result unless a test hands over an empty list on purpose.
function assignment(overrides = {}) {
  const packet = base(overrides);
  const materials = packet.source_materials;
  if (Array.isArray(materials) && materials.length && !materials.some((item) => item?.name === 'qa_result')) packet.source_materials = [...materials, QA_MATERIAL];
  return packet;
}

function base(overrides) {
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
      QA_MATERIAL,
    ],
    ...overrides,
  };
}

// The host's own lsd must not start an index over every fixture repository.
const hasLsd = (directory) => { try { accessSync(join(directory, 'lsd'), constants.X_OK); return true; } catch { return false; } };
const PLAIN_PATH = process.env.PATH.split(':').filter((directory) => !hasLsd(directory)).join(':');

function run(dir, input, args = [], path = PLAIN_PATH) {
  const result = spawnSync(process.execPath, [scriptPath, '--assignment', '-', ...args], {
    cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PATH: path },
  });
  const line = result.stdout.trim().split('\n').pop();
  return { code: result.status, json: line ? JSON.parse(line) : null, stderr: result.stderr };
}

test('--usage prints the contract as prose', () => {
  const usage = execFileSync(process.execPath, [scriptPath, '--usage'], { encoding: 'utf8' });
  assert.ok(usage.startsWith('review-pack.mjs — '));
  assert.match(usage, /entry named issue/);
  assert.match(usage, /named qa_result/);
  assert.match(usage, /--check/);
  assert.match(usage, /depth\{level,reason\}/);
});

test('refuses malformed input and packets without base_ref, issue text or the QA result', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  assert.equal(run(dir, 'not json').json.code, 'bad_args');
  assert.equal(run(dir, { objective: 'no id' }).json.code, 'bad_args');
  const noBase = run(dir, assignment({ repository: {} }));
  assert.deepEqual(noBase.json, { ok: false, code: 'missing_base_ref' });
  assert.equal(noBase.code, 1);
  assert.equal(run(dir, assignment({ source_materials: [] })).json.code, 'missing_issue');
  assert.equal(run(dir, base({ source_materials: [{ kind: 'text', name: 'issue', content: ISSUE_TEXT, provenance: 'tracker issue text' }] })).json.code, 'missing_qa_result');
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
  assert.deepEqual(json.depth, { level: 2, reason: 'behavior change without a risk signal' });
  assert.equal(json.navigation, 'none');
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
  const order = ['<review_pack ', '<attention>', '<signals>', '<scope>', '<decisions>', '<issue ', '<qa_result ', '<method>', '<rules>', '<env>', '<files>', '<diff context="10">', '</review_pack>'];
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
  assert.equal(pack.includes('"content_skipped"'), false, 'the compact env omits rules entirely');
  assert.equal(json.pack_chars, pack.length - 1);
});

test('depth follows the most expensive hunk, never the size, and a cut diff stays with the one reviewer', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\nexport const login = (password) => password === "x";\n');
  commit(dir, 'auth');
  const risky = run(dir, assignment()).json;
  assert.deepEqual(risky.risk_hits, [{ path: 'src/totals.js', line: 2, match: 'login' }]);
  assert.deepEqual(risky.depth, { level: 4, reason: 'risk category: access' });

  await writeFile(join(dir, 'src', 'totals.js'), 'export const login = (password) => password === "x";\nexport const purge = () => db.query("delete from orders");\n');
  commit(dir, 'destructive');
  assert.deepEqual(run(dir, assignment()).json.depth, { level: 5, reason: 'risk categories: access, data' });

  const big = Array.from({ length: 300 }, (_, i) => `export const value${i} = "${'x'.repeat(40)}";`).join('\n');
  await writeFile(join(dir, 'src', 'totals.js'), `${big}\n`);
  commit(dir, 'many lines');
  assert.equal(run(dir, assignment()).json.depth.level, 2);
  const cut = run(dir, assignment(), ['--budget', '9000', '--skip=rules,docs,runtime,tooling']).json;
  assert.equal(Object.hasOwn(cut, 'lens_pack'), false);
  assert.ok(cut.truncations.some((note) => /diff cut .*page through the rest with `git diff [0-9a-f]+\.\.HEAD -- <path>`/.test(note)), cut.truncations.join(' | '));
});

test('documentation, generated, whitespace-only and test changes buy the lowest depth, one lower again on a repeat', async () => {
  const dir = await repo();
  await mkdir(join(dir, 'src', 'generated'), { recursive: true });
  await writeFile(join(dir, 'docs', 'style.md'), '# Style\nName a total after what it sums; drop the password field.\n');
  await writeFile(join(dir, 'src', 'generated', 'Model.php'), '<?php class Model { public $password; }\n');
  await writeFile(join(dir, 'src', 'totals.js'), 'export  const total = (items) =>  items.length;\n');
  await writeFile(join(dir, 'src', 'auth.test.js'), 'it("rejects a bad password", () => {});\n');
  commit(dir, 'inert');
  assert.deepEqual(run(dir, assignment()).json.depth, { level: 1, reason: 'documentation, generated, formatting or test files only' });

  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'behavior');
  const previous = { kind: 'text', name: 'previous_review', content: JSON.stringify({ role: 'code-reviewer', required_fixes: [] }), provenance: 'previous review' };
  const repeat = run(dir, assignment({ source_materials: [...assignment().source_materials, previous] }), ['--check']).json;
  assert.deepEqual(repeat.depth, { level: 1, reason: 'behavior change without a risk signal; repeat review, one level lower' });
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
  assert.deepEqual(noIssue.json, { ok: false, code: 'bad_packet', detail: ['source_materials entry named issue missing', 'source_materials entry named qa_result missing (code-reviewer)'] });

  const good = run(dir, assignment({
    source_materials: [{ kind: 'text', name: 'issue', content: 'Sum totals.', provenance: 'tracker issue text' }],
  }), ['--check', '--out', outPath]);
  assert.equal(good.code, 0);
  assert.equal(good.json.ok, true);
  assert.equal(good.json.check, true);
  assert.equal(good.json.depth.level, 2);
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

test('rules carry the instruction chain whole and route to the documents it names', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  const { json } = run(dir, assignment(), ['--skip=rules']);
  const pack = await readFile(json.pack, 'utf8');
  const rules = pack.slice(pack.indexOf('<rules>'), pack.indexOf('</rules>'));
  assert.deepEqual(
    [...rules.matchAll(/^#### (.+)$/gm)].map((match) => match[1]),
    ['AGENTS.md', 'docs/engineering/README.md', 'docs/engineering/rules/money.md', 'routed by the entry files — open the one your doubt names'],
  );
  // The document an entry file names is a route, not a body: one line, with the line that named it.
  assert.match(rules, /\n- docs\/style\.md — naming lives in docs\/style\.md\n/);
  assert.equal(rules.includes('Name a total after what it sums.'), false);
});

test('without an entry file the rules section falls back to documentation paths', async () => {
  const dir = await repo();
  sh(dir, 'git', ['rm', '-q', 'AGENTS.md', 'docs/engineering/README.md']);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  const { json } = run(dir, assignment(), ['--skip=rules']);
  const pack = await readFile(json.pack, 'utf8');
  assert.match(pack, /<rules>\nNo AGENTS\.md, CLAUDE\.md, docs\/engineering\/README\.md; documentation paths to route reads:\n- docs\/engineering\/rules\/money\.md/);
});

test('the QA result rides in the pack whole, as a file or inline, between the review files and the method', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => 0;\n');
  commit(dir, 'stub');
  const qaFile = join(dir, '..', `qa-result-${Date.now()}.json`);
  await writeFile(qaFile, JSON.stringify({ kind: 'qa_result', verdict: 'red', checks: [{ id: 'c1', tool: 'vitest', status: 'failed', attribution: 'in_change' }] }));
  const { json } = run(dir, assignment({
    source_materials: [
      { kind: 'text', name: 'issue', content: ISSUE_TEXT, provenance: 'tracker issue text' },
      { kind: 'attachment_reference', name: 'qa_result', content: qaFile, provenance: 'результат QA' },
    ],
  }), ['--skip=rules,docs']);
  assert.equal(json.ok, true, JSON.stringify(json));
  const pack = await readFile(json.pack, 'utf8');
  assert.match(pack, /<qa_result note="the gate, run once by the QA role[^"]*" file="[^"]+">\n\{"kind":"qa_result","verdict":"red"/);
  assert.ok(pack.indexOf('<repository>') < pack.indexOf('<qa_result') && pack.indexOf('<qa_result') < pack.indexOf('<method>'));
  assert.equal(pack.includes('<checks'), false);
  assert.equal(pack.includes('"validation"'), false, 'the snapshot rides without its check templates');
  assert.equal(Object.hasOwn(json, 'checks'), false);

  const inline = run(dir, assignment(), ['--skip=rules,docs']);
  assert.match(await readFile(inline.json.pack, 'utf8'), /<qa_result note="[^"]+">\n\{"kind":"qa_result","verdict":"green"/);
});

test('rules that declare paths ride whole only when a changed file matches them', async () => {
  const dir = await repo();
  await mkdir(join(dir, '.claude', 'rules', 'db'), { recursive: true });
  await writeFile(join(dir, 'docs', 'engineering', 'rules', 'sql.md'), '---\npaths: ["db/**/*.sql", "migrations/*"]\n---\n# SQL\nNo raw deletes.\n');
  await writeFile(join(dir, '.claude', 'rules', 'db', 'money.md'), '---\npaths:\n  - "src/**/{totals,prices}.js"\n---\n# Totals\nRound at the end.\n');
  await writeFile(join(dir, '.claude', 'rules', 'always.md'), '# Always\nKeep changes bounded.\n');
  await writeFile(join(dir, 'docs', 'style.md'), '---\npaths: src/*.js\n---\n# Style\nName a total after what it sums.\n');
  await writeFile(join(dir, 'docs', 'ui.md'), '---\npaths: ["web/**"]\n---\n# UI\nNo inline styles.\n');
  await writeFile(join(dir, 'AGENTS.md'), '# Repository rules\n- naming lives in docs/style.md\n- screens follow docs/ui.md\n');
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'rules with paths');

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-paths' }), ['--skip=rules']);
  const pack = await readFile(json.pack, 'utf8');
  const rules = pack.slice(pack.indexOf('<rules>'), pack.indexOf('</rules>'));
  assert.deepEqual(
    [...rules.matchAll(/^#### (.+)$/gm)].map((match) => match[1]),
    ['AGENTS.md', 'docs/engineering/README.md', 'docs/engineering/rules/money.md', '.claude/rules/always.md', '.claude/rules/db/money.md', 'docs/style.md'],
  );
  assert.match(rules, /#### docs\/style\.md\n\n# Style\nName a total/, 'an applicable routed document rides whole, without its front matter');
  assert.equal(rules.includes('No raw deletes'), false);
  assert.equal(rules.includes('No inline styles') || /^- docs\/ui\.md/m.test(rules), false, 'a routed document whose paths miss the change is neither body nor route');
  assert.match(pack, /rules: 6 carried whole, 2 left out by their paths/);
});

test('the pack seeds an empty journal and hands over the harness bound to it', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-harness' }), ['--skip=rules']);
  const manifest = JSON.parse(await readFile(json.review_manifest, 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(manifest.journal, 'utf8')), { findings: [], coverage: {}, phases: {}, fix_resolution: {} });
  assert.equal(manifest.result, join(tmpdir(), 'result-assignment-review-harness.json'));
  assert.deepEqual(manifest.qa_checks, [{ id: 'c1', command: 'npx vitest related src/totals.js', status: 'passed', width: 'narrowed to the change' }]);
  assert.equal(json.harness, `node '${join(dirname(scriptPath), 'review-findings.mjs')}' --manifest '${json.review_manifest}'`);
  assert.match(await readFile(json.pack, 'utf8'), /<harness note="[^"]+">\nnode '/);
});

test('with the navigation lsd on the PATH the pack starts its index and says so', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');
  const bin = await mkdtemp(join(tmpdir(), 'lsd-bin-'));
  const marker = join(bin, 'reindexed');
  await writeFile(join(bin, 'lsd'), `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "  def   Where a symbol is declared"; exit 0; fi\necho "$@" > '${marker}'\n`);
  await chmod(join(bin, 'lsd'), 0o755);

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-lsd' }), ['--skip=rules'], `${bin}:${PLAIN_PATH}`);
  assert.equal(json.navigation, 'lsd');
  assert.match(await readFile(json.pack, 'utf8'), /navigation: lsd — its index was started/);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { accessSync(marker); break; } catch { await new Promise((done) => { setTimeout(done, 20); }); }
  }
  assert.equal((await readFile(marker, 'utf8')).trim(), `reindex ${sh(dir, 'git', ['rev-parse', '--show-toplevel']).trim()}`);

  // The ls replacement of the same name is not a navigator.
  await writeFile(join(bin, 'lsd'), '#!/bin/sh\necho "An ls command with a lot of pretty colors"\n');
  assert.equal(run(dir, assignment({ assignment_id: 'assignment-review-lsd' }), ['--skip=rules'], `${bin}:${PLAIN_PATH}`).json.navigation, 'none');
});

test('routes past the cap are named in the truncations, never dropped in silence', async () => {
  const dir = await repo();
  const names = Array.from({ length: 45 }, (_, i) => `docs/note${i}.md`);
  for (const name of names) await writeFile(join(dir, name), `# Note\nrule text\n`);
  await writeFile(join(dir, 'AGENTS.md'), `# Repository rules\n${names.map((name) => `- see ${name}`).join('\n')}\n`);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'many rules');

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-routes' }), ['--skip=rules']);
  const pack = await readFile(json.pack, 'utf8');
  const rules = pack.slice(pack.indexOf('<rules>'), pack.indexOf('</rules>'));
  assert.equal([...rules.matchAll(/^- docs\/note\d+\.md — /gm)].length, 40);
  const note = json.truncations.find((line) => /rule routes past the cap of 40/.test(line));
  assert.ok(note, json.truncations.join(' | '));
  assert.match(note, /docs\/note44\.md/);
  assert.match(pack, /<attention>[\s\S]*rule routes past the cap of 40/);
});

test('tests ride as a digest of declared cases, and their fixtures raise no risk signal', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  await writeFile(join(dir, 'src', 'totals.test.js'), [
    'import { total } from "./totals.js";',
    'const password = "hunter2"; // fixture, not a change to authorization',
    'describe("total", () => {',
    '  it("sums every amount", () => {});',
    '  it("is zero for an empty order", () => {});',
    '});',
  ].join('\n'));
  commit(dir, 'sum amounts with tests');

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-digest' }), ['--skip=rules']);
  assert.deepEqual(json.risk_hits, [], 'a fixture password is not a risk signal of the change');
  assert.equal(json.test_files, 1);
  const pack = await readFile(json.pack, 'utf8');
  const digest = pack.slice(pack.indexOf('<tests '), pack.indexOf('</tests>'));
  assert.match(digest, /A src\/totals\.test\.js \+6 -0/);
  assert.match(digest, /\n- total\n- sums every amount\n- is zero for an empty order/);
  // The bodies stay out of the diff; the code they exercise stays in.
  const diff = pack.slice(pack.indexOf('<diff '), pack.indexOf('</diff>'));
  assert.equal(diff.includes('totals.test.js'), false);
  assert.match(diff, /src\/totals\.js/);
  assert.match(pack, /- A src\/totals\.test\.js \(test\)/);
});

test('a change that is only tests keeps them as the diff', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.test.js'), 'import { total } from "./totals.js";\nit("counts", () => {});\n');
  commit(dir, 'tests only');

  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-tests-only' }), ['--skip=rules']);
  const pack = await readFile(json.pack, 'utf8');
  assert.equal(pack.includes('<tests '), false);
  assert.match(pack.slice(pack.indexOf('<diff ')), /src\/totals\.test\.js/);
});

test('repeat packs omit duplicate phase reports, passing logs and environment rules', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = () => 0;\n');
  commit(dir, 'change');
  const large = 'REDUNDANT_HISTORY'.repeat(5000);
  const { json } = run(dir, assignment({ source_materials: [...assignment().source_materials, { name: 'previous_review', kind: 'text', provenance: 'review', content: JSON.stringify({ role: 'code-reviewer', required_fixes: ['B1: preserve me'], findings: [{ id: 'B1', evidence: 'keep proof' }], deliverable: { content: { phases: { behavior: large }, coverage: [{ item: 'src/totals.js', status: 'reviewed', evidence: 'keep coverage' }] } } }) }] }));
  const text = await readFile(json.pack, 'utf8');
  assert.equal(text.includes('REDUNDANT_HISTORY'), false);
  assert.match(text, /keep proof/);
  assert.match(text, /keep coverage/);
  const env = text.slice(text.indexOf('<env>'), text.indexOf('</env>'));
  assert.equal(env.includes('AGENTS.md'), false);
  assert.equal(env.includes('docs_index'), false);
  assert.equal(text.split('# Repository rules').length, 2);
});

test('QA-only review reuses verified code coverage and refuses changed inputs or stale evidence', async () => {
  const dir = await repo();
  await writeFile(join(dir, '.git', 'info', 'exclude'), 'CLAUDE.md\n');
  await writeFile(join(dir, 'CLAUDE.md'), '# Local rules\nRead the changed code.\n');
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = () => 0;\n');
  commit(dir, 'change');
  const head = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  const initial = run(dir, assignment({ assignment_id: 'review-initial' }));
  const result = {
    contract_version: 1, assignment_id: 'review-initial', role: 'code-reviewer', status: 'done', summary: 'Code reviewed',
    deliverable: { kind: 'review_report', content: { review_complete: true, review_manifest: initial.json.review_manifest, coverage: [{ item: 'src/totals.js', status: 'reviewed', evidence: 'src/totals.js:1 read' }] } },
    verification: [{ command: 'tests', status: 'broken', evidence: 'runner unavailable' }], findings: [], required_fixes: [],
  };
  assert.deepEqual(resultProblems(result), []);
  const savedManifest = await readFile(initial.json.review_manifest, 'utf8');
  await writeFile(initial.json.review_manifest, JSON.stringify({ ...JSON.parse(savedManifest), files: [] }));
  assert.ok(resultProblems(result).some((problem) => problem.includes('manifest files differ')));
  await writeFile(initial.json.review_manifest, savedManifest);
  const incomplete = { ...result, deliverable: { ...result.deliverable, content: { ...result.deliverable.content, coverage: [] } } };
  assert.ok(resultProblems(incomplete).some((problem) => problem.includes('coverage must contain')));
  const blocked = { ...result, deliverable: { ...result.deliverable, content: { ...result.deliverable.content, coverage: [{ item: 'src/totals.js', status: 'blocked', evidence: 'unread' }] } } };
  assert.ok(resultProblems(blocked).some((problem) => problem.includes('contradicts blocked')));
  const wrongLine = { ...result, findings: [{ id: 'B1', severity: 'P2', confidence: 'confirmed', category: 'correctness', path: 'src/totals.js', line: 999, problem: 'wrong', impact: 'wrong result', fix: 'correct bound', evidence: 'read source' }], required_fixes: ['B1: correct bound'] };
  assert.ok(resultProblems(wrongLine).some((problem) => problem.includes('coordinates outside')));
  const qa = { ...QA_MATERIAL, content: JSON.stringify({ kind: 'qa_result', workspace: { head }, verdict: 'green', checks: [] }) };
  const previous = { kind: 'text', name: 'previous_review', content: JSON.stringify(result), provenance: 'previous review' };
  const packet = assignment({ assignment_id: 'review-evidence', repository: { base_ref: head }, source_materials: [assignment().source_materials[0], qa, previous] });
  const check = run(dir, packet, ['--check']);
  assert.equal(check.json.review_kind, 'evidence_only', JSON.stringify(check));
  const next = run(dir, packet);
  assert.equal(next.json.review_kind, 'evidence_only', JSON.stringify(next));
  assert.equal(next.json.files, 0);
  assert.deepEqual(JSON.parse(await readFile(next.json.review_manifest, 'utf8')).files, ['src/totals.js']);
  assert.equal(run(dir, { ...packet, accepted_decisions: ['different contract'] }).json.code, 'review_state_mismatch');
  const stale = { ...packet, source_materials: [packet.source_materials[0], QA_MATERIAL, previous] };
  assert.equal(run(dir, stale).json.code, 'review_state_mismatch');
  await writeFile(join(dir, 'CLAUDE.md'), '# Local rules\nAdditional security constraint.\n');
  assert.equal(sh(dir, 'git', ['status', '--porcelain']).trim(), '');
  assert.equal(run(dir, packet).json.code, 'review_state_mismatch', 'ignored local rules must also invalidate reuse');
  await writeFile(join(dir, 'CLAUDE.md'), '# Local rules\nRead the changed code.\n');
  await writeFile(join(dir, 'docs', 'style.md'), 'Changed rules without commit\n');
  assert.equal(run(dir, packet).json.code, 'review_state_mismatch');

  // A new network path in a fix delta is examined even after earlier coverage.
  await writeFile(join(dir, 'docs', 'style.md'), sh(dir, 'git', ['show', 'HEAD:docs/style.md']));
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = () => fetch(url);\n');
  commit(dir, 'new network path');
  const delta = run(dir, { ...packet, assignment_id: 'review-delta' });
  assert.equal(delta.json.review_kind, 'fix_delta');
  assert.ok(delta.json.risk_hits.some((hit) => hit.rule === 'outbound_url'));
  assert.match(await readFile(delta.json.pack, 'utf8'), /central validator/);
});

test('bounded reader preserves long lines and page boundaries without omissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-read-'));
  const file = join(dir, 'evidence.md');
  const source = 'Ж'.repeat(30001) + '\n' + 'short line\n'.repeat(401);
  await writeFile(file, source);
  let offset = 0;
  let restored = '';
  do {
    const page = JSON.parse(sh(process.cwd(), process.execPath, [join(dirname(scriptPath), 'review-read.mjs'), '--file', file, '--offset', String(offset), '--limit', '50000']));
    assert.ok(page.text.length <= 12000);
    assert.ok(page.text.split('\n').length <= 200);
    restored += page.text;
    if (!page.complete) assert.ok(page.next_offset > offset);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(restored, source);
  const second = JSON.parse(sh(process.cwd(), process.execPath, [join(dirname(scriptPath), 'review-read.mjs'), '--file', file, '--line', '2']));
  assert.equal(second.start_line, 2);
  assert.ok(second.text.startsWith('short line\n'));
});
