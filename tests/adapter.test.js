import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { manifestProblems, resolutionProblems, callAdapter } from '../contracts/validate-adapter.mjs';

const root = process.cwd();
const validatorPath = join(root, 'contracts', 'validate-adapter.mjs');
const adapterPath = join(root, 'skills', 'project-manager', 'scripts', 'adapter-file.mjs');
const schema = JSON.parse(fs.readFileSync(join(root, 'contracts', 'adapter-v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateManifest = ajv.compile(schema);
const resolutionSchema = { ...schema, $ref: '#/$defs/resolution' };
delete resolutionSchema.$id;
const validateResolution = new Ajv2020({ allErrors: true, strict: false }).compile(resolutionSchema);

function cli(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').pop()) };
}

async function tracker() {
  const dir = await mkdtemp(join(tmpdir(), 'dt-adapter-'));
  const command = `node ${adapterPath} --root ${join(dir, 'tracker')} --prefix PRJ`;
  const call = (operation, input) => cli(adapterPath, ['--root', join(dir, 'tracker'), '--prefix', 'PRJ', operation, JSON.stringify(input)]).json;
  const manifest = join(dir, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ contract_version: 1, kind: 'file', label: 'file-adapter', command, operations: ['resolve', 'publish', 'prd', 'create', 'attach', 'comment', 'close'], defaults: { base: 'main', delivery: 'branch', returns: 2 } }));
  return { dir, command, call, manifest };
}

test('the manifest example and the schema agree; a manifest without a required operation names it', () => {
  const example = JSON.parse(fs.readFileSync(join(root, 'contracts', 'examples', 'adapter-manifest.json'), 'utf8'));
  assert.deepEqual(manifestProblems(example), []);
  assert.equal(validateManifest(example), true, JSON.stringify(validateManifest.errors));
  const problems = manifestProblems({ contract_version: 1, kind: 'file', command: 'node x', operations: ['resolve', 'prd', 'create', 'attach', 'comment', 'close', 'fly'], defaults: { delivery: 'push' }, extra: 1 });
  assert.deepEqual(problems, ['unknown field extra', 'unknown operation fly', 'Манифест адаптера file: операция publish не объявлена', 'defaults.delivery must be merge_push | branch']);
  assert.equal(cli(validatorPath, ['--manifest', join(root, 'contracts', 'examples', 'adapter-manifest.json')]).json.ok, true);
  assert.equal(cli(validatorPath, []).json.code, 'bad_args');
});

test('the file adapter creates, resolves, publishes, writes a PRD, attaches and closes items by the contract', async () => {
  const { dir, call } = await tracker();
  await writeFile(join(dir, 'body.md'), 'Идея в двух словах\n');
  assert.deepEqual(call('create', { title: 'Сделать штуку', description: join(dir, 'body.md') }), { ok: true, key: 'PRJ-1', id: null, url: null });
  assert.equal(call('create', { title: 'Первая часть', parent: 'PRJ-1' }).key, 'PRJ-2');
  assert.equal(call('create', { title: 'Вторая часть', parent: 'PRJ-1' }).key, 'PRJ-3');
  assert.equal(call('create', { title: 'Внучка', parent: 'PRJ-2' }).code, 'nested_subtask');
  assert.equal(call('create', { title: 'x', parent: 'PRJ-9' }).code, 'parent_not_found');

  // A bare parent key selects its first unfinished child; `self` keeps the parent.
  const run = join(dir, 'run');
  const selected = call('resolve', { key: 'PRJ-1', dir: run, attachments: true, mark: true });
  assert.equal(validateResolution(selected), true, JSON.stringify(validateResolution.errors));
  assert.deepEqual(resolutionProblems(selected), []);
  assert.equal(selected.target.key, 'PRJ-2');
  assert.equal(selected.target.kind, 'child');
  assert.equal(selected.children.position, '1 из 2');
  assert.deepEqual(selected.children.unfinished, ['PRJ-2', 'PRJ-3']);
  assert.equal(selected.parent.key, 'PRJ-1');
  assert.equal(fs.readFileSync(selected.files.issue, 'utf8'), '# PRJ-2 Первая часть\n\n\n');
  assert.equal(fs.readFileSync(selected.files.parent_issue, 'utf8'), '# PRJ-1 Сделать штуку\n\nИдея в двух словах\n');
  assert.equal(selected.files.comments, null);
  assert.deepEqual(selected.mark, { applied: true, warning: null });
  const parent = call('resolve', { key: 'PRJ-1', dir: run, self: true });
  assert.equal(parent.target.kind, 'parent');
  assert.deepEqual(parent.document, { managed: false, scope: false, legacy: false, subsections: [] });
  assert.equal(call('resolve', { key: 'PRJ-1', dir: run, child: 'PRJ-9' }).code, 'explicit_child_not_found');
  assert.equal(call('resolve', { key: 'PRJ-3', dir: run, child: 'PRJ-2' }).code, 'unrelated_child');

  await writeFile(join(dir, 'done.md'), 'Разработка: готово\nБлокеров: нет\n');
  assert.deepEqual(call('publish', { key: 'PRJ-2', event: 'development_done', comment: join(dir, 'done.md') }), { ok: true, comment: { posted: true }, stage: { moved: true, to: 'review' } });
  await writeFile(join(dir, 'review.md'), 'Ревью: готово\nБлокеров: нет\n');
  assert.equal(call('publish', { key: 'PRJ-2', event: 'review_done', comment: join(dir, 'review.md') }).stage.to, 'review', 'a child stays in review until it is closed');
  const marked = call('resolve', { key: 'PRJ-1', dir: join(dir, 'run2'), child: 'PRJ-2' });
  assert.equal(marked.target.marker, 'review_done');
  assert.equal(marked.route_hint, 'completion_recovery');
  assert.match(fs.readFileSync(marked.files.comments, 'utf8'), /Разработка: готово[\s\S]*Ревью: готово/);
  assert.deepEqual(call('close', { key: 'PRJ-2' }).fields, [{ name: 'Stage', value: 'done', done: true, changed: true }]);
  assert.equal(call('resolve', { key: 'PRJ-1', dir: join(dir, 'run3'), child: 'PRJ-2' }).code, 'terminal_child');
  assert.equal(call('resolve', { key: 'PRJ-1', dir: join(dir, 'run3'), child: 'PRJ-2', terminal: true }).target.stage, 'done');
  assert.equal(call('resolve', { key: 'PRJ-1', dir: join(dir, 'run4') }).target.key, 'PRJ-3', 'the next unfinished child follows');
  assert.equal(call('publish', { key: 'PRJ-1', event: 'review_done' }).stage.to, 'done', 'an ordinary or parent item closes on an accepted review');

  await writeFile(join(dir, 'prd.md'), '## Проблематика\nБоль\n\n## Продуктовое решение\n### Краткое описание доработки\nx\n### Что дорабатываем\n1. a\n### Что НЕ дорабатываем\n1. b\n### Критерии приемки доработки\n1. c\n### Scope\n_Для разработчика._\n');
  const written = call('prd', { key: 'PRJ-1', document: join(dir, 'prd.md'), title: 'Сделать штуку как надо', size: 'L' });
  assert.equal(written.ok, true);
  assert.deepEqual(written.sections.replaced, []);
  assert.equal(written.sections.inserted.length, 7);
  assert.deepEqual([written.title, written.size], ['replaced', 'replaced']);
  const item = fs.readFileSync(join(dir, 'tracker', 'PRJ-1.md'), 'utf8');
  assert.match(item, /^# PRJ-1 Сделать штуку как надо\nStage: done\nSize: L\n/);
  assert.match(item, /# Проблематика[\s\S]*____________\n\nИдея в двух словах/, 'the original text moves below the separator');
  const again = call('prd', { key: 'PRJ-1', document: join(dir, 'prd.md'), size: 'L' });
  assert.deepEqual([again.sections.inserted, again.title, again.size], [[], 'unchanged', 'unchanged']);
  assert.match(fs.readFileSync(join(dir, 'tracker', 'PRJ-1.md'), 'utf8'), /____________\n\nИдея в двух словах\n$/, 'a rewrite keeps the text below the separator once');
  const flags = call('resolve', { key: 'PRJ-1', dir: join(dir, 'run5'), self: true }).document;
  assert.deepEqual(flags, { managed: true, scope: true, legacy: false, subsections: ['Краткое описание доработки', 'Что дорабатываем', 'Что НЕ дорабатываем', 'Критерии приемки доработки', 'Scope'] });
  const malformed = call('prd', { key: 'PRJ-1', document: join(dir, 'done.md') });
  assert.equal(malformed.code, 'malformed_sections');
  assert.equal(malformed.detail.length, 6);

  await writeFile(join(dir, 'shot.png'), 'png');
  assert.deepEqual(call('attach', { key: 'PRJ-1', files: [join(dir, 'shot.png'), join(dir, 'absent.png')] }).items.map((entry) => [entry.name, entry.attached, entry.code ?? null]), [['shot.png', true, null], ['absent.png', false, 'source_missing']]);
  assert.deepEqual(call('resolve', { key: 'PRJ-1', dir: join(dir, 'run6'), self: true, attachments: true }).media, [{ path: join(dir, 'tracker', 'PRJ-1.attachments', 'shot.png'), name: 'shot.png' }]);
  assert.deepEqual(call('comment', { key: 'PRJ-1', comment: join(dir, 'done.md') }), { ok: true, posted: true });
  assert.equal(call('resolve', { key: 'PRJ-99', dir: join(dir, 'run7') }).code, 'item_not_found');
  assert.equal(cli(adapterPath, ['--root', join(dir, 'tracker'), 'fly', '{}']).json.code, 'unknown_operation');
});

test('--check calls resolve through the manifest and judges the answer by the resolution shape', async () => {
  const { dir, call, manifest, command } = await tracker();
  call('create', { title: 'Одна задача' });
  const checked = cli(validatorPath, ['--manifest', manifest, '--check', '--key', 'PRJ-1', '--dir', join(dir, 'check')]);
  assert.equal(checked.code, 0, JSON.stringify(checked.json));
  assert.deepEqual(checked.json.resolution.target, { key: 'PRJ-1', kind: 'ordinary', stage: 'backlog', marker: null });
  assert.equal(checked.json.resolution.files.issue, join(dir, 'check', 'issue.md'));
  const missing = cli(validatorPath, ['--manifest', manifest, '--check', '--key', 'PRJ-2', '--dir', join(dir, 'check')]);
  assert.equal(missing.json.code, 'bad_resolution');
  assert.deepEqual(missing.json.detail, ['resolve answered ok:false (item_not_found)']);
  assert.equal(cli(validatorPath, ['--manifest', manifest, '--check', '--key', 'PRJ-1', '--dir', 'relative']).json.code, 'bad_args');
  const direct = callAdapter(command, 'resolve', { key: 'PRJ-1', dir: join(dir, 'direct') });
  assert.equal(direct.answer.ok, true);
  // A resolution without the issue file is refused even when everything else is in place.
  const broken = { ...direct.answer, files: { ...direct.answer.files, issue: join(dir, 'nowhere.md') } };
  assert.deepEqual(resolutionProblems(broken), [`files.issue: file not found: ${join(dir, 'nowhere.md')}`]);
  assert.deepEqual(resolutionProblems({ ok: true }), ['target missing', 'parent must be null or {key, title, stage}', 'children must carry list, unfinished and position', 'document must carry managed, scope, legacy, subsections', 'files missing', 'media must be a list of {path, name}', 'route_hint must be text or null', 'mark.applied must be a boolean']);
  const dead = cli(validatorPath, ['--manifest', manifest, '--check', '--key', 'PRJ-1', '--dir', join(dir, 'check2')].concat([]));
  assert.equal(dead.json.ok, true);
});
