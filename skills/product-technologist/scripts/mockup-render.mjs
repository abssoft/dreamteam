#!/usr/bin/env node
// Mockup renderer for the product-technologist handoff. Wrapper-side only:
// the hosting workflow (a project Dispatcher) runs it once after the
// interview, before attaching the mockups to the tracker item; roles never
// run it. Zero dependencies: HTML/SVG mockups render through a local
// Chrome/Chromium driven over --remote-debugging-pipe into a PNG of the
// whole content — blank canvas below the drawing is trimmed off the image
// itself, so a host page stretching around a fragment adds no dead space;
// raster mockups are copied as they are. Every output is an image a tracker
// previews inline and a vision-capable role can open.
// Input: single CLI arg — JSON {files: [<absolute path>, …], outDir,
//   width?=1280, minHeight?=200, maxHeight?=4000, timeoutMs?=30000,
//   chrome? (explicit browser executable; otherwise discovery: the
//   MOCKUP_RENDER_CHROME variable, the usual application paths, PATH,
//   the Playwright browser cache)}
// Output: one JSON line on stdout; always exit 0.
//   ok:true  → {ok, renderer: {kind:"chrome", path}|null, out_dir,
//               items: [{source, rendered_from?, name, output, bytes,
//               status: "rendered"|"copied"|"failed", code?}]}
//               rendered — html/htm/svg became <stem>.png; copied —
//               png/jpg/jpeg/gif/webp kept their name; failed carries
//               code: file_missing | unsupported_type |
//               renderer_unavailable | render_failed | render_timeout |
//               copy_failed. A colliding output name gets a -2, -3 suffix.
//   ok:false → {ok, code}: bad_args | out_dir_error | render_error
// A listed <stem>.html whose sibling <stem>-preview.html exists renders the
// sibling — the standalone page a visualization host generates around a
// fragment — and still names the output <stem>.png.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const RASTER = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const RENDERABLE = new Set([".html", ".htm", ".svg"]);
const DEFAULTS = Object.freeze({ width: 1280, minHeight: 200, maxHeight: 4000, timeoutMs: 30000 });
const SETTLE_MS = 500;
const VIEWPORT_HEIGHT = 900;
const CONTENT_MARGIN = 16;

const USAGE = `mockup-render.mjs — renders interview mockups to PNG for tracker attachment.
Arg: single JSON:
 {files: [<absolute path>, …], outDir, width?=1280, minHeight?=200,
  maxHeight?=4000, timeoutMs?=30000, chrome?}
files — the mockup files the product-technologist handoff lists: html/htm/svg
are rendered by a local Chrome/Chromium (discovery: chrome, then the
MOCKUP_RENDER_CHROME variable, the usual application paths, PATH, the
Playwright cache) into a PNG of the whole content, blank canvas below the
drawing trimmed; png/jpg/jpeg/gif/webp are copied unchanged. A <stem>.html
with a sibling <stem>-preview.html renders the sibling and still yields
<stem>.png.
Output: one JSON line {ok, renderer{kind,path}|null, out_dir, items[{source,
rendered_from?, name, output, bytes, status rendered|copied|failed, code?}]}.
Item codes: file_missing|unsupported_type|renderer_unavailable|render_failed|
render_timeout|copy_failed — a failed item never fails the call: attach its
source instead and warn. ok:false codes: bad_args|out_dir_error|render_error.
`;

function out(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function parseArgs(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { files, outDir, chrome } = input;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string" && f !== "")) return null;
  if (typeof outDir !== "string" || outDir === "") return null;
  if (chrome !== undefined && (typeof chrome !== "string" || chrome === "")) return null;
  const numbers = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = input[key];
    if (value === undefined) {
      numbers[key] = DEFAULTS[key];
    } else if (Number.isInteger(value) && value > 0) {
      numbers[key] = value;
    } else {
      return null;
    }
  }
  if (numbers.minHeight > numbers.maxHeight) return null;
  return { files, outDir: resolve(outDir), chrome: chrome ?? null, ...numbers };
}

function onPath(name) {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
}

function playwrightCaches() {
  const roots = process.platform === "darwin"
    ? [join(homedir(), "Library", "Caches", "ms-playwright")]
    : [join(homedir(), ".cache", "ms-playwright")];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root).filter((e) => e.startsWith("chromium-")).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      let inner = [];
      try {
        inner = readdirSync(join(root, entry));
      } catch {
        continue;
      }
      for (const dir of inner) {
        found.push(join(root, entry, dir, "Chromium.app", "Contents", "MacOS", "Chromium"));
        found.push(join(root, entry, dir, "chrome"));
      }
    }
  }
  return found;
}

function discoverChrome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.MOCKUP_RENDER_CHROME) candidates.push(process.env.MOCKUP_RENDER_CHROME);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) candidates.push(...onPath(name));
  candidates.push(...playwrightCaches());
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there — next candidate
    }
  }
  return null;
}

// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe: fd 3
// carries commands, fd 4 carries responses/events, every message ends with
// a NUL byte. Flat sessions (Target.attachToTarget flatten:true) route
// commands to the page.
function launchChrome(path, timeoutMs) {
  const profile = mkdtempSync(join(tmpdir(), "mockup-render-"));
  const child = spawn(path, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--allow-file-access-from-files",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const writer = child.stdio[3];
  const reader = child.stdio[4];
  let exited = false;
  let nextId = 0;
  const pending = new Map();
  const backlog = [];
  const waiters = [];
  let buffered = Buffer.alloc(0);

  const fail = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  reader.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let cut;
    while ((cut = buffered.indexOf(0)) >= 0) {
      const raw = buffered.subarray(0, cut).toString("utf8");
      buffered = buffered.subarray(cut + 1);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? "cdp_error"), { code: "render_failed" }));
        else entry.resolve(message.result ?? {});
        continue;
      }
      if (message.method) {
        const index = waiters.findIndex((w) => w.method === message.method && w.sessionId === message.sessionId);
        if (index >= 0) {
          const [waiter] = waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        } else {
          backlog.push(message);
        }
      }
    }
  });
  child.on("exit", () => {
    exited = true;
    fail(Object.assign(new Error("chrome_exited"), { code: "render_failed" }));
  });
  child.on("error", () => {
    exited = true;
    fail(Object.assign(new Error("chrome_spawn_failed"), { code: "render_failed" }));
  });

  const send = (method, params = {}, sessionId) => new Promise((resolvePromise, reject) => {
    if (exited) {
      reject(Object.assign(new Error("chrome_exited"), { code: "render_failed" }));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`timeout ${method}`), { code: "render_timeout" }));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    writer.write(`${JSON.stringify(message)}\0`, (error) => {
      if (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(new Error("chrome_pipe_closed"), { code: "render_failed" }));
      }
    });
  });

  const waitEvent = (method, sessionId) => new Promise((resolvePromise, reject) => {
    const index = backlog.findIndex((m) => m.method === method && m.sessionId === sessionId);
    if (index >= 0) {
      const [message] = backlog.splice(index, 1);
      resolvePromise(message.params ?? {});
      return;
    }
    const timer = setTimeout(() => {
      const at = waiters.findIndex((w) => w.timer === timer);
      if (at >= 0) waiters.splice(at, 1);
      reject(Object.assign(new Error(`timeout ${method}`), { code: "render_timeout" }));
    }, timeoutMs);
    waiters.push({ method, sessionId, resolve: resolvePromise, reject, timer });
  });

  const close = async () => {
    if (!exited) {
      try {
        await Promise.race([send("Browser.close"), new Promise((r) => setTimeout(r, 2000))]);
      } catch {
        // closing anyway
      }
      if (!exited) child.kill("SIGKILL");
    }
    rmSync(profile, { recursive: true, force: true });
  };

  return { send, waitEvent, close };
}

// --- PNG trim: drop the uniform-colour rows under the drawing -------------
// Chrome emits non-interlaced 8-bit RGB/RGBA PNGs; anything else is kept as
// captured. The bottom row's colour is the canvas colour; the last row that
// differs from it is the drawing's lower edge.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function decodePng(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const idat = [];
  let header = null;
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (header === null || idat.length === 0) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || channels === 0 || interlace !== 0) return null;
  let data;
  try {
    data = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (data.length !== height * (stride + 1)) return null;
  const rows = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = data[at++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[at++];
      const a = x >= channels ? rows[rowStart + x - channels] : 0;
      const b = y > 0 ? rows[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? rows[prevStart + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + a;
      else if (filter === 2) value = raw + b;
      else if (filter === 3) value = raw + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      rows[rowStart + x] = value & 0xff;
    }
  }
  return { width, height, colorType, channels, stride, rows };
}

function encodePng({ width, colorType, stride, rows }, height) {
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rows.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function trimBottom(png, margin, minHeight) {
  const image = decodePng(png);
  if (image === null || image.height <= minHeight) return png;
  const { height, stride, channels, rows } = image;
  const canvas = rows.subarray((height - 1) * stride, height * stride);
  for (let x = channels; x < stride; x += channels) {
    if (!canvas.subarray(x, x + channels).equals(canvas.subarray(0, channels))) return png;
  }
  let last = -1;
  for (let y = height - 2; y >= 0; y -= 1) {
    if (!rows.subarray(y * stride, (y + 1) * stride).equals(canvas)) {
      last = y;
      break;
    }
  }
  const kept = Math.min(height, Math.max(minHeight, last + 1 + margin));
  return kept === height ? png : encodePng(image, kept);
}

async function renderOne(cdp, sessionId, source, output, options) {
  const { width, minHeight, maxHeight } = options;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.waitEvent("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: pathToFileURL(source).href }, sessionId);
  await loaded;
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const measured = await cdp.send("Runtime.evaluate", {
    expression: "Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))",
    returnByValue: true,
  }, sessionId);
  const scrollHeight = Number(measured?.result?.value) || 0;
  const height = Math.min(maxHeight, Math.max(minHeight, VIEWPORT_HEIGHT, scrollHeight));
  if (height !== VIEWPORT_HEIGHT) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  }
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  }, sessionId);
  const captured = Buffer.from(String(shot.data ?? ""), "base64");
  if (captured.length === 0) throw Object.assign(new Error("empty_screenshot"), { code: "render_failed" });
  const bytes = trimBottom(captured, CONTENT_MARGIN, minHeight);
  writeFileSync(output, bytes);
  return bytes.length;
}

function uniqueOutput(dir, name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return join(dir, name);
  }
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return join(dir, candidate);
    }
  }
  throw new Error("name_space_exhausted");
}

function planItems(files, outDir) {
  const taken = new Set();
  return files.map((file) => {
    const source = resolve(file);
    let isFile = false;
    try {
      isFile = statSync(source).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return { source, name: basename(source), output: null, bytes: 0, status: "failed", code: "file_missing" };
    const ext = extname(source).toLowerCase();
    if (RASTER.has(ext)) {
      const output = uniqueOutput(outDir, basename(source), taken);
      return { source, name: basename(output), output, bytes: 0, status: "copied", code: null };
    }
    if (RENDERABLE.has(ext)) {
      const stem = basename(source, extname(source));
      const output = uniqueOutput(outDir, `${stem}.png`, taken);
      let renderedFrom = source;
      if ((ext === ".html" || ext === ".htm") && !stem.endsWith("-preview")) {
        const sibling = join(dirname(source), `${stem}-preview${extname(source)}`);
        if (existsSync(sibling)) renderedFrom = sibling;
      }
      return { source, rendered_from: renderedFrom, name: basename(output), output, bytes: 0, status: "rendered", code: null };
    }
    return { source, name: basename(source), output: null, bytes: 0, status: "failed", code: "unsupported_type" };
  });
}

async function main() {
  const flag = process.argv[2];
  if (["--usage", "--help", "-h"].includes(flag)) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const options = parseArgs(flag ?? "");
  if (options === null) out({ ok: false, code: "bad_args" });
  try {
    mkdirSync(options.outDir, { recursive: true });
  } catch {
    out({ ok: false, code: "out_dir_error" });
  }

  const items = planItems(options.files, options.outDir);
  for (const item of items) {
    if (item.status !== "copied") continue;
    try {
      if (resolve(item.source) !== resolve(item.output)) copyFileSync(item.source, item.output);
      item.bytes = statSync(item.output).size;
    } catch {
      item.status = "failed";
      item.code = "copy_failed";
      item.output = null;
    }
  }

  const renderables = items.filter((item) => item.status === "rendered");
  let renderer = null;
  if (renderables.length > 0) {
    const chromePath = discoverChrome(options.chrome);
    if (chromePath === null) {
      for (const item of renderables) {
        item.status = "failed";
        item.code = "renderer_unavailable";
        item.output = null;
      }
    } else {
      renderer = { kind: "chrome", path: chromePath };
      const cdp = launchChrome(chromePath, options.timeoutMs);
      try {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Page.enable", {}, sessionId);
        for (const item of renderables) {
          try {
            item.bytes = await renderOne(cdp, sessionId, item.rendered_from, item.output, options);
          } catch (error) {
            item.status = "failed";
            item.code = error?.code === "render_timeout" ? "render_timeout" : "render_failed";
            rmSync(item.output, { force: true });
            item.output = null;
          }
        }
      } catch (error) {
        for (const item of renderables) {
          if (item.status !== "rendered" || item.bytes > 0) continue;
          item.status = "failed";
          item.code = error?.code === "render_timeout" ? "render_timeout" : "render_failed";
          item.output = null;
        }
      } finally {
        await cdp.close();
      }
    }
  }

  const report = items.map((item) => ({
    source: item.source,
    ...(item.rendered_from && item.status === "rendered" ? { rendered_from: item.rendered_from } : {}),
    name: item.name,
    output: item.output,
    bytes: item.bytes,
    status: item.status,
    ...(item.code ? { code: item.code } : {}),
  }));
  out({ ok: true, renderer, out_dir: options.outDir, items: report });
}

main().catch(() => out({ ok: false, code: "render_error" }));
