#!/usr/bin/env node
// File tracker adapter — Tracker Adapter v1 over a directory of Markdown items,
// the adapter of the `tracker` dispatcher (and the test bench of the
// project-manager role). One item is <root>/<KEY>.md: YAML front matter (a flat
// `name: value` subset — title, stage, parent, size, ai, created; other keys a
// human adds are kept as written), then the description, then `## Комментарии`
// with one `### <timestamp>` block per comment. Attachments live in
// <root>/<KEY>.attachments/. Keys are <PREFIX>-<N>, the file name is the key.
// Every write takes the directory lock and lands by rename, so parallel
// sessions neither lose an update nor get the same new key.
//   node adapter.mjs --root <dir> [--prefix <PREFIX>] <operation> '<json>'
// Operations and shapes: contracts/adapter-v1.schema.json; `list` (outside the
// contract) feeds the dispatcher's `бэклог` mode. One JSON line out; exit 0 on
// ok:true, exit 1 on ok:false (nothing changed).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STAGES = ["backlog", "prd", "dev", "review", "done", "cancelled"];
const FINISHED = ["done", "cancelled"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const FIELDS = ["title", "stage", "parent", "size", "ai", "created"];
const SEPARATOR = "____________";
const REQUIRED_SUBSECTIONS = ["Краткое описание доработки", "Что дорабатываем", "Что НЕ дорабатываем", "Критерии приемки доработки"];
const EVENT_STAGE = { dev_started: () => "dev", development_done: () => "review", review_done: (item) => (item.fields.parent ? "review" : "done") };
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

class Refusal extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
const refuse = (code, detail) => { throw new Refusal(code, detail); };

// --- front matter ------------------------------------------------------------

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith('"')) {
    const quoted = value.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
    if (!quoted) throw new Error("unterminated quote");
    return JSON.parse(quoted[1]);
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("unterminated quote");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "");
}

// A plain scalar only when YAML reads it back as the same string.
function renderScalar(value) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const plain = /^[\p{L}_][^:#\n"']*$/u.test(text) && !/\s$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text);
  return plain ? text : JSON.stringify(text);
}

// Returns {fields, order, body} or throws with the reason.
function parseFrontMatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("no front matter: the file must start with ---");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("front matter is not closed with ---");
  const fields = {};
  const order = [];
  for (const [offset, line] of lines.slice(1, end).entries()) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s(.*))?$/);
    if (!match) throw new Error(`line ${offset + 2}: only flat \`name: value\` lines are supported`);
    try { fields[match[1]] = parseScalar(match[2] ?? ""); } catch (error) { throw new Error(`line ${offset + 2}: ${error.message}`); }
    order.push(match[1]);
  }
  return { fields, order, body: lines.slice(end + 1).join("\n") };
}

// --- storage -----------------------------------------------------------------

function parseItem(key, text) {
  const { fields, order, body } = parseFrontMatter(text);
  const item = { key, fields, order, description: "", comments: [] };
  const at = body.search(/^## Комментарии\s*$/m);
  item.description = (at >= 0 ? body.slice(0, at) : body).trim();
  if (at >= 0) {
    for (const block of body.slice(at).split(/^### /m).slice(1)) {
      const [stamp, ...rest] = block.split("\n");
      item.comments.push({ at: stamp.trim(), text: rest.join("\n").trim() });
    }
  }
  return item;
}

function renderItem(item) {
  const names = [...FIELDS, ...item.order.filter((name) => !FIELDS.includes(name))];
  const lines = names.filter((name) => item.fields[name] !== null && item.fields[name] !== undefined && item.fields[name] !== "")
    .map((name) => `${name}: ${typeof item.fields[name] === "boolean" ? item.fields[name] : renderScalar(item.fields[name])}`);
  const comments = item.comments.length ? `\n## Комментарии\n\n${item.comments.map((comment) => `### ${comment.at}\n${comment.text}\n`).join("\n")}` : "";
  return `---\n${lines.join("\n")}\n---\n\n${item.description ? `${item.description}\n` : ""}${comments}`;
}

const itemPath = (root, key) => join(root, `${key}.md`);
function loadItem(root, key) {
  if (!isText(key) || !KEY.test(key) || !existsSync(itemPath(root, key))) return null;
  try {
    return parseItem(key, readFileSync(itemPath(root, key), "utf8"));
  } catch (error) {
    return refuse("item_malformed", `${key}.md: ${error.message}`);
  }
}
function saveItem(root, item) {
  const path = itemPath(root, item.key);
  const temp = join(root, `.${item.key}.${process.pid}.tmp`);
  writeFileSync(temp, renderItem(item));
  renameSync(temp, path);
}
// Every well-formed item, and the names of the files that are not.
function scanItems(root) {
  const items = [];
  const malformed = [];
  for (const name of readdirSync(root)) {
    const key = name.match(/^(.+)\.md$/)?.[1];
    if (!key || !KEY.test(key)) continue;
    try { items.push(parseItem(key, readFileSync(join(root, name), "utf8"))); } catch (error) { malformed.push(`${name}: ${error.message}`); }
  }
  items.sort((a, b) => keyNumber(a.key) - keyNumber(b.key));
  return { items, malformed };
}
const listItems = (root) => scanItems(root).items;
const keyNumber = (key) => Number(key.match(KEY)?.[2] ?? 0);
const stageOf = (item) => (STAGES.includes(item.fields.stage) ? item.fields.stage : "unknown");
const finished = (item) => FINISHED.includes(stageOf(item));
const childrenOf = (root, key) => listItems(root).filter((item) => item.fields.parent === key);
const readText = (path, label) => {
  if (!isText(path) || !isAbsolute(path)) refuse("bad_args", `${label}: absolute path expected`);
  try { return readFileSync(path, "utf8"); } catch { return refuse("bad_args", `${label}: unreadable ${path}`); }
};
const stamp = () => new Date().toISOString();
const isAi = (item) => item.fields.ai === true;

// The directory lock: mkdir is atomic; a lock older than LOCK_STALE_MS is a
// crashed writer's and is taken over.
function withLock(root, action) {
  const lock = join(root, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) refuse("locked", `${lock} is held by another writer`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function marker(item) {
  let found = null;
  for (const comment of item.comments) {
    if (/^Разработка: готово/.test(comment.text)) found = "development_done";
    else if (/^Ревью: готово/.test(comment.text)) found = "review_done";
  }
  return found;
}

function documentFlags(description) {
  const managed = /^#{1,2} Проблематика\s*$/m.test(description) && /^#{1,2} Продуктовое решение\s*$/m.test(description);
  const managedText = managed ? description.slice(description.search(/^#{1,2} Проблематика\s*$/m)).split(new RegExp(`^_{5,}\\s*$`, "m"))[0] : "";
  const subsections = [...managedText.matchAll(/^#{2,3} (.+?)\s*$/gm)].map((match) => match[1]).filter((name) => !/^(Проблематика|Продуктовое решение)$/.test(name));
  return { managed, scope: /^#{2,3} Scope\s*$/m.test(managedText), legacy: false, subsections };
}

// --- operations -------------------------------------------------------------

function resolveOp(root, input) {
  if (!isText(input.dir) || !isAbsolute(input.dir)) refuse("bad_args", "dir: absolute path expected");
  mkdirSync(input.dir, { recursive: true });
  let target;
  if (isText(input.child)) {
    target = loadItem(root, input.child) ?? refuse("explicit_child_not_found", input.child);
    if (isText(input.key) && target.fields.parent !== input.key) refuse("unrelated_child", `${input.child} is not a child of ${input.key}`);
    if (finished(target) && input.terminal !== true) refuse("terminal_child", input.child);
  } else {
    target = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    const own = childrenOf(root, target.key);
    if (input.self !== true && own.length) {
      const next = own.find((child) => !finished(child));
      if (next) target = next;
    }
  }
  if (input.mark === true && !isAi(target)) {
    target = withLock(root, () => {
      const fresh = loadItem(root, target.key);
      fresh.fields.ai = true;
      saveItem(root, fresh);
      return fresh;
    });
  }
  const parent = isText(target.fields.parent) ? loadItem(root, target.fields.parent) : null;
  const siblings = parent ? childrenOf(root, parent.key) : childrenOf(root, target.key);
  const kind = parent ? "child" : siblings.length ? "parent" : "ordinary";
  const position = parent ? `${siblings.findIndex((item) => item.key === target.key) + 1} из ${siblings.length}` : null;

  const files = { issue: join(input.dir, "issue.md"), parent_issue: null, comments: null };
  writeFileSync(files.issue, `# ${target.key} ${target.fields.title ?? ""}\n\n${target.description}\n`);
  if (parent && input.parent !== false) {
    files.parent_issue = join(input.dir, "parent_issue.md");
    writeFileSync(files.parent_issue, `# ${parent.key} ${parent.fields.title ?? ""}\n\n${parent.description}\n`);
  }
  if (target.comments.length) {
    files.comments = join(input.dir, "comments.md");
    writeFileSync(files.comments, target.comments.map((comment) => `### ${comment.at}\n\n${comment.text}\n`).join("\n"));
  }
  const attachmentsDir = join(root, `${target.key}.attachments`);
  const media = input.attachments === true && existsSync(attachmentsDir)
    ? readdirSync(attachmentsDir).sort().map((name) => ({ path: join(attachmentsDir, name), name }))
    : [];
  const latest = marker(target);
  return {
    ok: true,
    target: { key: target.key, id: null, kind, title: target.fields.title ?? "", stage: stageOf(target), status: target.fields.stage ?? null, size: SIZES.includes(target.fields.size) ? target.fields.size : null, marker: latest, url: null },
    parent: parent ? { key: parent.key, title: parent.fields.title ?? "", stage: stageOf(parent), status: parent.fields.stage ?? null } : null,
    children: { list: siblings.map((item) => ({ key: item.key, title: item.fields.title ?? "", stage: stageOf(item), finished: finished(item) })), unfinished: siblings.filter((item) => !finished(item)).map((item) => item.key), position },
    document: documentFlags(target.description),
    files,
    media,
    route_hint: latest === "review_done" && !finished(target) ? "completion_recovery" : null,
    mark: { applied: input.mark === true, warning: null },
  };
}

function appendComment(item, path) {
  if (!isText(path)) return false;
  item.comments.push({ at: stamp(), text: readText(path, "comment").trim() });
  return true;
}

function publishOp(root, input) {
  if (!EVENT_STAGE[input.event]) refuse("bad_args", "event must be dev_started | development_done | review_done");
  return withLock(root, () => {
    const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    const posted = appendComment(item, input.comment ?? null);
    const to = EVENT_STAGE[input.event](item);
    const moved = item.fields.stage !== to;
    item.fields.stage = to;
    saveItem(root, item);
    return { ok: true, comment: { posted }, stage: { moved, to } };
  });
}

function commentOp(root, input) {
  if (!isText(input.comment)) refuse("bad_args", "comment: absolute path expected");
  return withLock(root, () => {
    const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    appendComment(item, input.comment);
    saveItem(root, item);
    return { ok: true, posted: true };
  });
}

function prdOp(root, input) {
  const document = readText(input.document, "document").replace(/\r\n/g, "\n").trim();
  const canonical = document.replace(/^## (Проблематика|Продуктовое решение)\s*$/gm, "# $1");
  const problems = [];
  for (const section of ["Проблематика", "Продуктовое решение"]) if (!new RegExp(`^# ${section}\\s*$`, "m").test(canonical)) problems.push(`нет раздела «${section}»`);
  for (const name of REQUIRED_SUBSECTIONS) if (!new RegExp(`^#{2,3} ${name}\\s*$`, "m").test(canonical)) problems.push(`нет подраздела «${name}»`);
  if (problems.length) refuse("malformed_sections", problems);
  if (isText(input.size) && !SIZES.includes(input.size)) refuse("invalid_size", input.size);
  return withLock(root, () => {
    const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    const old = item.description;
    const at = old.search(/^#{1,2} Проблематика\s*$/m);
    const existed = at >= 0;
    const separator = new RegExp(`^_{5,}\\s*$`, "m");
    let rest;
    if (existed) {
      const tail = old.slice(at);
      const cut = tail.search(separator);
      rest = cut >= 0 ? tail.slice(cut).replace(separator, "").trim() : "";
      rest = [old.slice(0, at).trim(), rest].filter(Boolean).join("\n\n");
    } else rest = old.trim();
    item.description = `${canonical}\n\n${SEPARATOR}${rest ? `\n\n${rest}` : ""}`;
    const names = [...canonical.matchAll(/^#{1,3} (.+?)\s*$/gm)].map((match) => match[1]);
    let title = "unchanged";
    if (isText(input.title) && input.title.trim() !== item.fields.title) { item.fields.title = input.title.trim(); title = "replaced"; }
    let size = "none";
    if (isText(input.size)) {
      size = item.fields.size === input.size ? "unchanged" : "replaced";
      item.fields.size = input.size;
    }
    saveItem(root, item);
    return { ok: true, sections: { inserted: existed ? [] : names, replaced: existed ? names : [] }, legacy_removed: [], title, size };
  });
}

function createOp(root, input, prefix) {
  if (!isText(input.title)) refuse("bad_args", "title missing");
  if (input.size != null && !SIZES.includes(input.size)) refuse("invalid_size", String(input.size));
  const description = isText(input.description) ? readText(input.description, "description").trim() : "";
  return withLock(root, () => {
    let parent = null;
    if (isText(input.parent)) {
      parent = loadItem(root, input.parent) ?? refuse("parent_not_found", input.parent);
      if (isText(parent.fields.parent)) refuse("nested_subtask", input.parent);
    }
    const usePrefix = parent ? parent.key.match(KEY)[1] : prefix;
    if (!isText(usePrefix)) refuse("bad_args", "--prefix is required for a standalone item");
    // Malformed files still hold their numbers.
    const last = readdirSync(root).map((name) => name.match(/^(.+)\.md$/)?.[1]).filter((key) => key && key.startsWith(`${usePrefix}-`) && KEY.test(key))
      .map(keyNumber).reduce((max, n) => Math.max(max, n), 0);
    const fields = { title: input.title.trim(), stage: "backlog", parent: parent?.key ?? null, size: input.size ?? null, created: stamp().slice(0, 10) };
    const item = { key: `${usePrefix}-${last + 1}`, fields, order: [], description, comments: [] };
    saveItem(root, item);
    return { ok: true, key: item.key, id: null, url: null };
  });
}

function attachOp(root, input) {
  const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
  if (!Array.isArray(input.files) || !input.files.every((path) => isText(path) && isAbsolute(path))) refuse("bad_args", "files: list of absolute paths expected");
  const dir = join(root, `${item.key}.attachments`);
  mkdirSync(dir, { recursive: true });
  const items = input.files.map((path) => {
    const name = basename(path);
    if (!existsSync(path)) return { path, name, attached: false, code: "source_missing" };
    if (existsSync(join(dir, name)) && input.replace === false) return { path, name, attached: false, code: "exists" };
    copyFileSync(path, join(dir, name));
    return { path, name, attached: true };
  });
  return { ok: true, items };
}

function closeOp(root, input) {
  return withLock(root, () => {
    const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    appendComment(item, input.comment ?? null);
    const done = item.fields.stage === "done";
    item.fields.stage = "done";
    saveItem(root, item);
    return { ok: true, fields: [{ name: "stage", value: "done", done: true, changed: !done }], pending: [] };
  });
}

// Outside the contract: the dispatcher's `бэклог` mode.
function listOp(root) {
  const { items, malformed } = scanItems(root);
  return {
    ok: true,
    items: items.map((item) => ({ key: item.key, title: item.fields.title ?? "", stage: stageOf(item), parent: item.fields.parent ?? null, size: SIZES.includes(item.fields.size) ? item.fields.size : null })),
    malformed,
  };
}

const OPERATIONS = { resolve: resolveOp, publish: publishOp, comment: commentOp, prd: prdOp, create: createOp, attach: attachOp, close: closeOp, list: listOp };

function main() {
  const args = process.argv.slice(2);
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let root = null;
  let prefix = null;
  while (args.length && args[0].startsWith("--")) {
    const flag = args.shift();
    if (flag === "--root") root = args.shift();
    else if (flag === "--prefix") prefix = args.shift();
    else { out({ ok: false, code: "bad_args", detail: `unknown flag ${flag}` }); process.exit(1); }
  }
  const [operation, json] = args;
  if (!isText(root) || !isAbsolute(root) || !OPERATIONS[operation]) {
    out({ ok: false, code: isText(operation) && !OPERATIONS[operation] ? "unknown_operation" : "bad_args", detail: "usage: adapter.mjs --root <dir> [--prefix <PREFIX>] <resolve|publish|comment|prd|create|attach|close|list> '<json>'" });
    process.exit(1);
  }
  let input;
  try { input = JSON.parse(json ?? "{}"); } catch { out({ ok: false, code: "bad_args", detail: "single JSON argument required" }); process.exit(1); }
  if (!isObject(input)) { out({ ok: false, code: "bad_args", detail: "single JSON object required" }); process.exit(1); }
  mkdirSync(root, { recursive: true });
  try {
    out(OPERATIONS[operation](resolve(root), input, prefix));
  } catch (error) {
    if (error instanceof Refusal) { out({ ok: false, code: error.code, detail: error.detail }); process.exit(1); }
    out({ ok: false, code: "adapter_error", detail: String(error.message) });
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
