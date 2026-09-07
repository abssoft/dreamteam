import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), 'skills', 'product-technologist', 'scripts', 'mockup-render.mjs');

async function run(arg) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, arg], { encoding: 'utf8' });
  return stdout;
}

async function runJson(input) {
  return JSON.parse(await run(JSON.stringify(input)));
}

test('--usage prints the contract as prose', async () => {
  const usage = await run('--usage');
  assert.ok(usage.startsWith('mockup-render.mjs — '));
  assert.match(usage, /Arg: single JSON/);
  assert.match(usage, /Output: one JSON line/);
});

test('malformed input is bad_args', async () => {
  assert.deepEqual(JSON.parse(await run('nope')), { ok: false, code: 'bad_args' });
  assert.deepEqual(await runJson({ files: [], outDir: 'out' }), { ok: false, code: 'bad_args' });
  assert.deepEqual(await runJson({ files: ['shot.png'], outDir: '' }), { ok: false, code: 'bad_args' });
  assert.deepEqual(await runJson({ files: ['shot.png'], outDir: 'out', width: -1 }), { ok: false, code: 'bad_args' });
});

test('copies raster mockups and reports missing or unsupported files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mockup-render-'));
  await writeFile(join(dir, 'shot.png'), 'png-bytes');
  await writeFile(join(dir, 'notes.txt'), 'notes');
  const outDir = join(dir, 'out');
  const result = await runJson({ files: [join(dir, 'shot.png'), join(dir, 'notes.txt'), join(dir, 'missing.png')], outDir });
  assert.equal(result.ok, true);
  assert.equal(result.out_dir, outDir);
  assert.equal(result.renderer, null);
  const [shot, notes, missing] = result.items;
  assert.equal(shot.status, 'copied');
  assert.equal(shot.name, 'shot.png');
  assert.equal(shot.output, join(outDir, 'shot.png'));
  assert.equal(shot.bytes, 9);
  assert.equal(await readFile(shot.output, 'utf8'), 'png-bytes');
  assert.equal(notes.status, 'failed');
  assert.equal(notes.code, 'unsupported_type');
  assert.equal(notes.output, null);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.code, 'file_missing');
});

test('renders HTML to a content-sized PNG, preferring the standalone preview sibling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mockup-render-'));
  await writeFile(join(dir, 'card.html'), '<div style="width:300px;height:640px;background:#37a">fragment</div>');
  await writeFile(
    join(dir, 'card-preview.html'),
    '<!doctype html><html><body style="margin:0"><div style="min-height:100vh"><div style="width:500px;height:420px;background:#3a7">preview</div></div></body></html>',
  );
  const result = await runJson({ files: [join(dir, 'card.html')], outDir: join(dir, 'out') });
  assert.equal(result.ok, true);
  const [card] = result.items;
  if (result.renderer === null) {
    assert.equal(card.status, 'failed');
    assert.equal(card.code, 'renderer_unavailable');
    assert.equal(card.output, null);
    return;
  }
  assert.equal(result.renderer.kind, 'chrome');
  assert.equal(card.status, 'rendered');
  assert.equal(card.rendered_from, join(dir, 'card-preview.html'));
  assert.equal(card.name, 'card.png');
  assert.equal(card.output, join(dir, 'out', 'card.png'));
  const png = await readFile(card.output);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 436);
  assert.equal(card.bytes, png.length);
});
