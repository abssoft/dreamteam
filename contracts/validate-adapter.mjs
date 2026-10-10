#!/usr/bin/env node
// The executable side of the Tracker Adapter v1 contract. The project-manager
// role runs it in preflight on the manifest the dispatcher wrote, and with
// --check also calls the adapter's `resolve` on the run's item and judges the
// answer by the resolution shape. Zero dependencies.
//   node validate-adapter.mjs --manifest <path> [--check --key <KEY> --dir <dir> [--self] [--parent] [--child <KEY>] [--terminal]]
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, kind, label, command, operations, optional: [present optional ops],
//               defaults, modes, resolution?: {target{key, kind, stage, marker}, files, media}}
//   ok:false → {ok, code, detail}: bad_args | bad_manifest | resolve_failed | bad_resolution
// Beyond the JSON Schema (adapter-v1.schema.json): every required operation
// is declared; `defaults` obey the profile's policy rules; the resolution's
// files exist and the issue file is not empty.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DELIVERY_MODES } from "./validate-profile.mjs";

export const REQUIRED_OPERATIONS = ["resolve", "publish", "prd", "create", "attach", "comment", "close"];
export const OPTIONAL_OPERATIONS = ["time"];
export const STAGES = ["backlog", "prd", "dev", "review", "done", "cancelled", "unknown"];
export const KINDS = ["ordinary", "parent", "child"];
export const MARKERS = ["development_done", "review_done"];
export const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const MANIFEST_KEYS = ["contract_version", "kind", "label", "command", "operations", "defaults", "modes", "help", "create_fields"];

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function manifestProblems(raw) {
  if (!isObject(raw)) return ["manifest must be a JSON object"];
  const problems = Object.keys(raw).filter((key) => !MANIFEST_KEYS.includes(key)).map((key) => `unknown field ${key}`);
  if (raw.contract_version !== 1) problems.push("contract_version must be 1");
  if (!(isText(raw.kind) && /^[a-z][a-z0-9_-]*$/.test(raw.kind))) problems.push("kind must be a lowercase tracker name");
  if (raw.label !== undefined && !isText(raw.label)) problems.push("label must be text");
  if (!isText(raw.command)) problems.push("command must be the adapter's shell prefix");
  const ops = raw.operations;
  if (!Array.isArray(ops) || !ops.every(isText)) problems.push("operations must be a list of operation names");
  else {
    for (const op of ops) if (![...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS].includes(op)) problems.push(`unknown operation ${op}`);
    for (const op of REQUIRED_OPERATIONS) if (!ops.includes(op)) problems.push(`Манифест адаптера ${raw.kind ?? "?"}: операция ${op} не объявлена`);
  }
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) problems.push("defaults must be an object");
    else {
      for (const key of Object.keys(raw.defaults)) if (!["base", "delivery", "returns"].includes(key)) problems.push(`defaults: unknown key ${key}`);
      if (raw.defaults.base !== undefined && !isText(raw.defaults.base)) problems.push("defaults.base must be a branch name");
      if (raw.defaults.delivery !== undefined && !DELIVERY_MODES.includes(raw.defaults.delivery)) problems.push(`defaults.delivery must be ${DELIVERY_MODES.join(" | ")}`);
      if (raw.defaults.returns !== undefined && !(Number.isInteger(raw.defaults.returns) && raw.defaults.returns >= 0 && raw.defaults.returns <= 20)) problems.push("defaults.returns must be an integer 0..20");
    }
  }
  if (raw.modes !== undefined) {
    if (!Array.isArray(raw.modes)) problems.push("modes must be a list");
    else raw.modes.forEach((mode, index) => {
      if (!isObject(mode) || !isText(mode.token) || typeof mode.summary !== "string") problems.push(`modes[${index}] needs token and summary`);
      else if (mode.aliases !== undefined && !(Array.isArray(mode.aliases) && mode.aliases.every(isText))) problems.push(`modes[${index}].aliases must be a list of tokens`);
    });
  }
  if (raw.help !== undefined && !(Array.isArray(raw.help) && raw.help.every((line) => typeof line === "string"))) problems.push("help must be a list of lines");
  if (raw.create_fields !== undefined && !(Array.isArray(raw.create_fields) && raw.create_fields.every(isText))) problems.push("create_fields must be a list of field names");
  return problems;
}

function fileProblem(label, value, { nullable, nonEmpty }) {
  if (value === null && nullable) return null;
  if (!isText(value) || !isAbsolute(value)) return `${label}: absolute path expected`;
  if (!existsSync(value)) return `${label}: file not found: ${value}`;
  try {
    const stat = statSync(value);
    if (!stat.isFile()) return `${label}: not a file: ${value}`;
    if (nonEmpty && stat.size === 0) return `${label}: empty file: ${value}`;
  } catch { return `${label}: unreadable: ${value}`; }
  return null;
}

export function resolutionProblems(raw) {
  if (!isObject(raw)) return ["resolution must be a JSON object"];
  if (raw.ok !== true) return [`resolve answered ok:false${isText(raw.code) ? ` (${raw.code})` : ""}`];
  const problems = [];
  const target = raw.target;
  if (!isObject(target)) problems.push("target missing");
  else {
    if (!isText(target.key)) problems.push("target.key missing");
    if (!KINDS.includes(target.kind)) problems.push(`target.kind must be ${KINDS.join(" | ")}`);
    if (typeof target.title !== "string") problems.push("target.title missing");
    if (!STAGES.includes(target.stage)) problems.push(`target.stage must be ${STAGES.join(" | ")}`);
    if (!(target.size === null || SIZES.includes(target.size))) problems.push("target.size must be XS…XXL or null");
    if (!(target.marker === null || MARKERS.includes(target.marker))) problems.push(`target.marker must be ${MARKERS.join(" | ")} or null`);
  }
  if (!(raw.parent === null || (isObject(raw.parent) && isText(raw.parent.key) && typeof raw.parent.title === "string" && STAGES.includes(raw.parent.stage)))) problems.push("parent must be null or {key, title, stage}");
  const children = raw.children;
  if (!isObject(children) || !Array.isArray(children.list) || !Array.isArray(children.unfinished) || !(children.position === null || isText(children.position))) problems.push("children must carry list, unfinished and position");
  else children.list.forEach((child, index) => {
    if (!isObject(child) || !isText(child.key) || typeof child.title !== "string" || !STAGES.includes(child.stage) || typeof child.finished !== "boolean") problems.push(`children.list[${index}] needs key, title, stage, finished`);
  });
  const document = raw.document;
  if (!isObject(document) || typeof document.managed !== "boolean" || typeof document.scope !== "boolean" || typeof document.legacy !== "boolean" || !Array.isArray(document.subsections)) problems.push("document must carry managed, scope, legacy, subsections");
  const files = raw.files;
  if (!isObject(files)) problems.push("files missing");
  else {
    for (const [name, rule] of [["issue", { nullable: false, nonEmpty: true }], ["parent_issue", { nullable: true, nonEmpty: true }], ["comments", { nullable: true, nonEmpty: false }]]) {
      const problem = fileProblem(`files.${name}`, files[name] === undefined ? null : files[name], rule);
      if (files[name] === undefined) problems.push(`files.${name} missing (null when absent)`);
      else if (problem) problems.push(problem);
    }
  }
  if (!Array.isArray(raw.media) || !raw.media.every((item) => isObject(item) && isText(item.path) && isText(item.name))) problems.push("media must be a list of {path, name}");
  if (!(raw.route_hint === null || isText(raw.route_hint))) problems.push("route_hint must be text or null");
  if (!isObject(raw.mark) || typeof raw.mark.applied !== "boolean") problems.push("mark.applied must be a boolean");
  return problems;
}

// One adapter call: `<command> <op> '<json>'` through /bin/sh, the last stdout
// line parsed as the answer.
export function callAdapter(command, operation, input, { cwd = process.cwd(), timeout = 300000 } = {}) {
  const arg = JSON.stringify(input).replace(/'/g, "'\\''");
  const run = spawnSync("/bin/sh", ["-c", `${command} ${operation} '${arg}'`], { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  const line = String(run.stdout ?? "").trim().split("\n").pop() ?? "";
  let answer = null;
  try { answer = JSON.parse(line); } catch { answer = null; }
  return { status: run.status, answer, stderr: String(run.stderr ?? "").trim().slice(-2000), stdout_tail: line.slice(-2000) };
}

function main() {
  const args = process.argv.slice(2);
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const fail = (code, detail) => { out({ ok: false, code, detail }); process.exit(1); };
  const opts = { manifest: null, check: false, key: null, dir: null, self: false, parent: false, child: null, terminal: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => { i += 1; if (args[i] === undefined) fail("bad_args", `${arg} needs a value`); return args[i]; };
    if (arg === "--manifest") opts.manifest = next();
    else if (arg === "--check") opts.check = true;
    else if (arg === "--key") opts.key = next();
    else if (arg === "--dir") opts.dir = next();
    else if (arg === "--self") opts.self = true;
    else if (arg === "--parent") opts.parent = true;
    else if (arg === "--child") opts.child = next();
    else if (arg === "--terminal") opts.terminal = true;
    else fail("bad_args", `unknown argument ${arg}`);
  }
  if (!opts.manifest) fail("bad_args", "usage: validate-adapter.mjs --manifest <path> [--check --key <KEY> --dir <dir> [--self] [--parent] [--child <KEY>] [--terminal]]");
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(opts.manifest), "utf8")); } catch (error) { fail("bad_manifest", [`manifest unreadable: ${error.message}`]); }
  const problems = manifestProblems(manifest);
  if (problems.length) fail("bad_manifest", problems);
  const report = {
    ok: true, kind: manifest.kind, label: manifest.label ?? null, command: manifest.command, operations: manifest.operations,
    optional: OPTIONAL_OPERATIONS.filter((op) => manifest.operations.includes(op)), defaults: manifest.defaults ?? {}, modes: manifest.modes ?? [], create_fields: manifest.create_fields ?? [],
  };
  if (!opts.check) { out(report); return; }
  if (!(isText(opts.key) || isText(opts.child)) || !isText(opts.dir) || !isAbsolute(opts.dir)) fail("bad_args", "--check needs --key <KEY> (or --child) and an absolute --dir");
  const input = { ...(isText(opts.key) ? { key: opts.key } : {}), dir: opts.dir, self: opts.self, parent: opts.parent, attachments: true, mark: false, terminal: opts.terminal, ...(isText(opts.child) ? { child: opts.child } : {}) };
  const call = callAdapter(manifest.command, "resolve", input);
  if (call.answer === null) fail("resolve_failed", `resolve printed no JSON line (exit ${call.status}): ${call.stderr || call.stdout_tail}`);
  const bad = resolutionProblems(call.answer);
  if (bad.length) fail("bad_resolution", bad);
  const r = call.answer;
  out({ ...report, resolution: { target: { key: r.target.key, kind: r.target.kind, stage: r.target.stage, marker: r.target.marker }, files: r.files, media: r.media.length, route_hint: r.route_hint } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
