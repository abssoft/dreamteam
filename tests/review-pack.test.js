import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
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
  await writeFile(join(dir, 'AGENTS.md'), '# Repository rules\n- keep changes bounded\n- naming lives in docs/style.md\n');
  await writeFile(join(dir, 'docs', 'style.md'), '# Style\nName a total after what it sums.\n');
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

// Tests list the checks without starting them; the one test of the runner
// passes --run-checks instead.
function run(dir, input, args = []) {
  const flags = args.includes('--run-checks') ? args.filter((arg) => arg !== '--run-checks') : ['--no-checks', ...args];
  const result = spawnSync(process.execPath, [scriptPath, '--assignment', '-', ...flags], {
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

test('a fitting diff stays in_context whatever its size or risk; only a cut diff goes to children', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.length;\nexport const login = (password) => password === "x";\n');
  commit(dir, 'auth');
  const risky = run(dir, assignment()).json;
  assert.equal(risky.mode, 'in_context');
  assert.deepEqual(risky.risk_hits, [{ path: 'src/totals.js', line: 2, match: 'login' }]);

  const big = Array.from({ length: 300 }, (_, i) => `export const value${i} = "${'x'.repeat(40)}";`).join('\n');
  await writeFile(join(dir, 'src', 'totals.js'), `${big}\n`);
  commit(dir, 'many lines');
  assert.equal(run(dir, assignment()).json.mode, 'in_context');
  const cut = run(dir, assignment(), ['--budget', '9000', '--skip=rules,docs,runtime,tooling']).json;
  assert.equal(cut.mode, 'children');
  assert.ok(cut.truncations.some((note) => /diff cut/.test(note)), cut.truncations.join(' | '));
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

test('the checks section carries the snapshot templates with this diff\'s paths already in them', async () => {
  const dir = await repo();
  sh(dir, 'git', ['checkout', '-q', 'main']);
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { 'check:types': 'tsc -p tsconfig.json --noEmit', lint: 'eslint . --max-warnings 0', test: 'vitest run' },
  }));
  commit(dir, 'tooling');
  sh(dir, 'git', ['checkout', '-q', 'task']);
  sh(dir, 'git', ['rebase', '-q', 'main']);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  await writeFile(join(dir, 'src', 'totals.test.js'), 'test("sums amounts", () => {});\n');
  commit(dir, 'totals');

  const { json } = run(dir, assignment(), ['--skip=rules,docs']);
  const pack = await readFile(json.pack, 'utf8');
  // The narrowed command names the changed source; the tool that cannot narrow
  // says so instead of arriving as a path-less template.
  assert.match(pack, /<checks note="scope is the diff of this pack/);
  assert.match(pack, /npx vitest related src\/totals\.js — vitest, from npm run test/);
  assert.match(pack, /npx eslint --max-warnings 0 src\/totals\.js — eslint/);
  assert.match(pack, /npm run check:types — tsc, full width only/);
  assert.ok(pack.indexOf('<env>') < pack.indexOf('<checks') && pack.indexOf('<checks') < pack.indexOf('<files>'), 'checks sits between env and files');
  assert.equal(pack.includes('{paths}'), false);
});

test('children mode writes a lens pack: the same context without env, and no environment work for the lenses', async () => {
  const dir = await repo();
  const big = Array.from({ length: 300 }, (_, i) => `export const value${i} = "${'x'.repeat(40)}";`).join('\n');
  await writeFile(join(dir, 'src', 'totals.js'), `${big}\n`);
  commit(dir, 'bulk');

  const { json } = run(dir, assignment(), ['--budget', '9000', '--skip=rules,docs,runtime,tooling']);
  assert.equal(json.mode, 'children');
  assert.equal(json.lens_pack, `${json.pack.slice(0, -3)}-lens.md`);
  const pack = await readFile(json.pack, 'utf8');
  const lens = await readFile(json.lens_pack, 'utf8');
  assert.match(pack, /<env>/);
  assert.equal(lens.includes('<env>'), false);
  assert.equal(lens.includes('<checks'), false);
  assert.match(lens, /- This pack is your whole review context: settle every doubt by reading the code it names, and collect no environment snapshot, rules or diff of your own/);
  assert.ok(lens.endsWith('</review_pack>\n'));
  for (const marker of ['<signals>', '<issue ', '<method>', '<rules>', '<files>', '<diff context=']) {
    assert.ok(lens.includes(marker), `${marker} missing from the lens pack`);
  }
});

test('in_context mode writes one pack only', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  commit(dir, 'sum amounts');

  // Its own id: the shared temp directory still holds the lens pack of the children-mode run.
  const { json } = run(dir, assignment({ assignment_id: 'assignment-review-in-context' }), ['--skip=rules']);
  assert.equal(json.mode, 'in_context');
  assert.equal(Object.hasOwn(json, 'lens_pack'), false);
  assert.equal(existsSync(`${json.pack.slice(0, -3)}-lens.md`), false);
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

test('the runnable checks start detached as the pack is written, and their results file settles every item', async () => {
  const dir = await repo();
  sh(dir, 'git', ['checkout', '-q', 'main']);
  await mkdir(join(dir, 'vendor', 'bin'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'vendor', 'bin', 'phpstan'), '#!/bin/sh\necho "phpstan $*"\nfor a in "$@"; do case "$a" in *.neon) cat "$a";; esac; done\n');
  await writeFile(join(dir, 'vendor', 'bin', 'phpunit'), '#!/bin/sh\necho "phpunit $*"\n');
  await chmod(join(dir, 'vendor', 'bin', 'phpstan'), 0o755);
  await chmod(join(dir, 'vendor', 'bin', 'phpunit'), 0o755);
  await writeFile(join(dir, 'phpstan.neon'), 'parameters:\n    level: 5\n');
  await writeFile(join(dir, 'composer.json'), JSON.stringify({ name: 'acme/fixture', scripts: { analyse: 'vendor/bin/phpstan analyse --memory-limit=1G', test: 'vendor/bin/phpunit --testdox' } }));
  commit(dir, 'tooling');
  sh(dir, 'git', ['checkout', '-q', 'task']);
  sh(dir, 'git', ['rebase', '-q', 'main']);
  await writeFile(join(dir, 'src', 'totals.js'), 'export const total = (items) => items.reduce((sum, item) => sum + item.amount, 0);\n');
  await writeFile(join(dir, 'tests', 'TotalsTest.php'), '<?php\nclass TotalsTest { public function testSums() {} }\n');
  commit(dir, 'totals');

  const { json } = run(dir, assignment({ verification: ['false'] }), ['--run-checks', '--skip=rules,docs']);
  assert.equal(json.checks_started, 3);
  assert.equal(json.checks, join(tmpdir(), 'checks-assignment-review-eval-results.json'));
  const pack = await readFile(json.pack, 'utf8');
  assert.match(pack, /<checks note="scope is the diff of this pack; the items with an id are running now — read their results with node .*checks-run\.mjs --wait /);
  assert.match(pack, /\[c1\] composer analyse — phpstan, full width only/);
  assert.match(pack, /\[c2\] vendor\/bin\/phpunit --testdox tests\/TotalsTest\.php — phpunit, from composer test/);
  assert.match(pack, /\[c3\] false — assignment verification, as given/);
  assert.match(pack, /composer analyse && composer test — project suite, full width only/);

  const waited = spawnSync(process.execPath, [join(dirname(scriptPath), 'checks-run.mjs'), '--wait', json.checks, '--timeout', '30'], { encoding: 'utf8' });
  const results = JSON.parse(waited.stdout.trim().split('\n').pop());
  assert.equal(results.status, 'complete');
  assert.deepEqual(results.checks.map((item) => [item.id, item.status]), [['c1', 'passed'], ['c2', 'passed'], ['c3', 'failed']]);
  // phpstan ran directly with the wrapper, not through composer; phpunit ran narrowed.
  assert.match(results.checks[0].ran, /^vendor\/bin\/phpstan analyse --memory-limit=1G -c .*phpstan-c1\.neon$/);
  assert.match(results.checks[0].tail, /tmpDir: /);
  assert.equal(results.checks[1].ran, 'vendor/bin/phpunit --testdox tests/TotalsTest.php');
  assert.equal(results.checks[2].exit, 1);
});
