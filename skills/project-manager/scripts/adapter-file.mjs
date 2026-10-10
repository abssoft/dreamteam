#!/usr/bin/env node
// File adapter — Tracker Adapter v1 over a directory of Markdown items: the
// reference adapter of the contract and the test bench of the project-manager
// role. One item is <root>/<KEY>.md: a title line `# <KEY> <title>`, header
// lines (Stage, Parent, Size, Team), the description, then `## Комментарии`
// with one `### <timestamp>` block per comment. Attachments live in
// <root>/<KEY>.attachments/. Keys are <PREFIX>-<N>.
//   node adapter-file.mjs --root <dir> [--prefix <PREFIX>] <operation> '<json>'
// Operations and shapes: contracts/adapter-v1.schema.json. One JSON line out;
// exit 0 on ok:true, exit 1 on ok:false (nothing changed).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STAGES = ["backlog", "prd", "dev", "review", "done", "cancelled"];
const FINISHED = ["done", "cancelled"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const SEPARATOR = "____________";
const REQUIRED_SUBSECTIONS = ["Краткое описание доработки", "Что дорабатываем", "Что НЕ дорабатываем", "Критерии приемки доработки"];
const EVENT_STAGE = { dev_started: () => "dev", development_done: () => "review", review_done: (item) => (item.headers.Parent ? "review" : "done") };

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

class Refusal extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
const refuse = (code, detail) => { throw new Refusal(code, detail); };

// --- storage -----------------------------------------------------------------

function parseItem(text) {
  const lines = text.split("\n");
  const title = lines[0]?.match(/^# (\S+)(?: (.*))?$/);
  if (!title) return null;
  const item = { key: title[1], title: title[2] ?? "", headers: {}, description: "", comments: [] };
  let index = 1;
  for (; index < lines.length; index += 1) {
    const header = lines[index].match(/^(Stage|Parent|Size|Team): (.*)$/);
    if (!header) break;
    item.headers[header[1]] = header[2].trim();
  }
  const rest = lines.slice(index).join("\n");
  const at = rest.search(/^## Комментарии\s*$/m);
  item.description = (at >= 0 ? rest.slice(0, at) : rest).trim();
  if (at >= 0) {
    for (const block of rest.slice(at).split(/^### /m).slice(1)) {
      const [stamp, ...body] = block.split("\n");
      item.comments.push({ at: stamp.trim(), text: body.join("\n").trim() });
    }
  }
  return item;
}

function renderItem(item) {
  const headers = ["Stage", "Parent", "Size", "Team"].filter((name) => isText(item.headers[name])).map((name) => `${name}: ${item.headers[name]}`);
  const comments = item.comments.length ? `\n## Комментарии\n\n${item.comments.map((comment) => `### ${comment.at}\n${comment.text}\n`).join("\n")}` : "";
  return `# ${item.key} ${item.title}\n${headers.join("\n")}\n\n${item.description}\n${comments}`;
}

const itemPath = (root, key) => join(root, `${key}.md`);
function loadItem(root, key) {
  if (!isText(key) || !KEY.test(key) || !existsSync(itemPath(root, key))) return null;
  return parseItem(readFileSync(itemPath(root, key), "utf8"));
}
function saveItem(root, item) { writeFileSync(itemPath(root, item.key), renderItem(item)); }
function listItems(root) {
  return readdirSync(root).filter((name) => /\.md$/.test(name)).map((name) => parseItem(readFileSync(join(root, name), "utf8"))).filter(Boolean)
    .sort((a, b) => keyNumber(a.key) - keyNumber(b.key));
}
const keyNumber = (key) => Number(key.match(KEY)?.[2] ?? 0);
const stageOf = (item) => (STAGES.includes(item.headers.Stage) ? item.headers.Stage : "unknown");
const finished = (item) => FINISHED.includes(stageOf(item));
const childrenOf = (root, key) => listItems(root).filter((item) => item.headers.Parent === key);
const readText = (path, label) => {
  if (!isText(path) || !isAbsolute(path)) refuse("bad_args", `${label}: absolute path expected`);
  try { return readFileSync(path, "utf8"); } catch { return refuse("bad_args", `${label}: unreadable ${path}`); }
};
const stamp = () => new Date().toISOString();

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
    if (isText(input.key) && target.headers.Parent !== input.key) refuse("unrelated_child", `${input.child} is not a child of ${input.key}`);
    if (finished(target) && input.terminal !== true) refuse("terminal_child", input.child);
  } else {
    target = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
    const own = childrenOf(root, target.key);
    if (input.self !== true && own.length) {
      const next = own.find((child) => !finished(child));
      if (next) target = next;
    }
  }
  if (input.mark === true && target.headers.Team !== "AI") { target.headers.Team = "AI"; saveItem(root, target); }
  const parent = isText(target.headers.Parent) ? loadItem(root, target.headers.Parent) : null;
  const siblings = parent ? childrenOf(root, parent.key) : childrenOf(root, target.key);
  const kind = parent ? "child" : siblings.length ? "parent" : "ordinary";
  const position = parent ? `${siblings.findIndex((item) => item.key === target.key) + 1} из ${siblings.length}` : null;

  const files = { issue: join(input.dir, "issue.md"), parent_issue: null, comments: null };
  writeFileSync(files.issue, `# ${target.key} ${target.title}\n\n${target.description}\n`);
  if (parent && input.parent !== false) {
    files.parent_issue = join(input.dir, "parent_issue.md");
    writeFileSync(files.parent_issue, `# ${parent.key} ${parent.title}\n\n${parent.description}\n`);
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
    target: { key: target.key, id: null, kind, title: target.title, stage: stageOf(target), status: target.headers.Stage ?? null, size: SIZES.includes(target.headers.Size) ? target.headers.Size : null, marker: latest, url: null },
    parent: parent ? { key: parent.key, title: parent.title, stage: stageOf(parent), status: parent.headers.Stage ?? null } : null,
    children: { list: siblings.map((item) => ({ key: item.key, title: item.title, stage: stageOf(item), finished: finished(item) })), unfinished: siblings.filter((item) => !finished(item)).map((item) => item.key), position },
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
  const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
  if (!EVENT_STAGE[input.event]) refuse("bad_args", "event must be dev_started | development_done | review_done");
  const posted = appendComment(item, input.comment ?? null);
  const to = EVENT_STAGE[input.event](item);
  const moved = item.headers.Stage !== to;
  item.headers.Stage = to;
  saveItem(root, item);
  return { ok: true, comment: { posted }, stage: { moved, to } };
}

function commentOp(root, input) {
  const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
  if (!isText(input.comment)) refuse("bad_args", "comment: absolute path expected");
  appendComment(item, input.comment);
  saveItem(root, item);
  return { ok: true, posted: true };
}

function prdOp(root, input) {
  const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
  const document = readText(input.document, "document").replace(/\r\n/g, "\n").trim();
  const canonical = document.replace(/^## (Проблематика|Продуктовое решение)\s*$/gm, "# $1");
  const problems = [];
  for (const section of ["Проблематика", "Продуктовое решение"]) if (!new RegExp(`^# ${section}\\s*$`, "m").test(canonical)) problems.push(`нет раздела «${section}»`);
  for (const name of REQUIRED_SUBSECTIONS) if (!new RegExp(`^#{2,3} ${name}\\s*$`, "m").test(canonical)) problems.push(`нет подраздела «${name}»`);
  if (problems.length) refuse("malformed_sections", problems);
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
  if (isText(input.title) && input.title.trim() !== item.title) { item.title = input.title.trim(); title = "replaced"; }
  let size = "none";
  if (isText(input.size)) {
    if (!SIZES.includes(input.size)) refuse("invalid_size", input.size);
    size = item.headers.Size === input.size ? "unchanged" : "replaced";
    item.headers.Size = input.size;
  }
  saveItem(root, item);
  return { ok: true, sections: { inserted: existed ? [] : names, replaced: existed ? names : [] }, legacy_removed: [], title, size };
}

function createOp(root, input, prefix) {
  if (!isText(input.title)) refuse("bad_args", "title missing");
  let parent = null;
  if (isText(input.parent)) {
    parent = loadItem(root, input.parent) ?? refuse("parent_not_found", input.parent);
    if (isText(parent.headers.Parent)) refuse("nested_subtask", input.parent);
  }
  const usePrefix = parent ? parent.key.match(KEY)[1] : prefix;
  if (!isText(usePrefix)) refuse("bad_args", "--prefix is required for a standalone item");
  const last = listItems(root).filter((item) => item.key.startsWith(`${usePrefix}-`)).map((item) => keyNumber(item.key)).reduce((max, n) => Math.max(max, n), 0);
  const item = { key: `${usePrefix}-${last + 1}`, title: input.title.trim(), headers: { Stage: "backlog", ...(parent ? { Parent: parent.key } : {}) }, description: isText(input.description) ? readText(input.description, "description").trim() : "", comments: [] };
  saveItem(root, item);
  return { ok: true, key: item.key, id: null, url: null };
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
  const item = loadItem(root, input.key) ?? refuse("item_not_found", String(input.key ?? ""));
  appendComment(item, input.comment ?? null);
  const done = item.headers.Stage === "done";
  item.headers.Stage = "done";
  saveItem(root, item);
  return { ok: true, fields: [{ name: "Stage", value: "done", done: true, changed: !done }], pending: [] };
}

const OPERATIONS = { resolve: resolveOp, publish: publishOp, comment: commentOp, prd: prdOp, create: createOp, attach: attachOp, close: closeOp };

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
    out({ ok: false, code: isText(operation) && !OPERATIONS[operation] ? "unknown_operation" : "bad_args", detail: "usage: adapter-file.mjs --root <dir> [--prefix <PREFIX>] <resolve|publish|comment|prd|create|attach|close> '<json>'" });
    process.exit(1);
  }
  let input;
  try { input = JSON.parse(json ?? ""); } catch { out({ ok: false, code: "bad_args", detail: "single JSON argument required" }); process.exit(1); }
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
