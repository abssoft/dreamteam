#!/usr/bin/env node
// Review pack for the code-reviewer role: one call assembles everything the
// review reads before any plan — the assignment, the task text, the whole
// diff against the base the wrapper named, the shared engineering method,
// the project rules, risk signals and the environment baseline (the sibling
// env-snapshot, spawned here). Read-only, zero dependencies. The pack lands
// outside the repository so the reviewed tree stays clean; stdout carries one
// JSON line the parent steers by.
//
// Input: --assignment -    Assignment v1 JSON on stdin (or --assignment <path>)
//   --base <ref>           comparison base; default repository.base_ref
//   --budget <chars>       pack ceiling, default 300000
//   --out <path>           pack file; default beside the packet file, or under
//                          <tmpdir> when the packet came on stdin
//   --skip=<sections>      passed through to env-snapshot (rules,docs,git,runtime,validation)
//   --check                wrapper pre-launch gate: validate the packet strictly
//                          (contracts/validate-assignment.mjs), resolve the base
//                          and the diff, write nothing
//   --usage                print this contract as prose
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, pack, harness, base, head, files, changed_lines, test_files,
//               risk_hits: [{path, line, match}], depth: {level, reason},
//               navigation: "lsd"|"none", diff_context, truncations: [text],
//               warnings: [text], pack_chars}
//               (--check: {ok, check: true, base, head, files, changed_lines,
//               test_files, risk_hits, depth, issue_chars, warnings})
//   ok:false → {ok, code, detail?}: bad_args | bad_packet (--check only; detail
//               lists every problem) | missing_base_ref | missing_issue |
//               missing_qa_result (absent, unreadable, or not a QA result) |
//               not_a_git_repository | base_ref_not_found | review_state_mismatch
//               (uncommitted changes, QA evidence for another HEAD, or a repeat
//               review whose task, rules or code moved) | empty_diff |
//               pack_write_failed
// Task text: the source_materials entry named `issue` (a subtask also
// `parent_issue`) is read inline when it is text, or from the file its content
// names when the wrapper wrote the tracker text to disk (attachment_reference).
// The gate: qa_result keeps statuses, widths and evidence links, and up to 40
// skipped cases per check (skipped_cases_total past that). Full logs and lists
// stay in its source file; the review runs no check of its own. For every
// review kind, --check included, it is the QA role's result (kind qa_result
// with checks[]) whose workspace.head names the reviewed HEAD, and the
// workspace carries no uncommitted change.
// The diff is `git diff` from the merge base of <base> and HEAD (the three-dot
// range), at the widest context of 10, 6, 3 or 0 lines that fits the budget;
// a diff that does not fit even at 0 is cut, the files after the cut are
// listed, and the same reviewer pages through the rest. Rules: the repository
// instruction chain — the agent entry files whole, the rule directories whole
// minus the rules whose `paths:` front matter matches no changed file, the
// documents the entries name whole when their `paths:` match and as routes
// (path plus the line naming it) when they declare none — or, with no entry
// file, the documentation paths to route reads by. Depth: the review depth 1–5
// the change's most expensive hunk buys, for the wrapper to launch the reviewer
// at. The pack also warms the tree's `lsd` index in the background and seeds
// the findings journal the harness (review-findings.mjs) records into.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packetProblems } from "../../../contracts/validate-assignment.mjs";
import { reviewProblems } from "./review-result.mjs";
import { compactQa, compactResult, digest, parseResult, previousManifest } from "./review-state.mjs";

// The ceiling answers one question — does the change fit one reviewer? — so it
// tracks the model window rather than an older, smaller pack.
const DEFAULTS = Object.freeze({ budget: 300000 });
const DIFF_WIDTHS = [10, 6, 3, 0];
const RULES_RESERVE = 20000;
const DIFF_FLOOR_SHARE = 0.4;
const RISK_HIT_CAP = 40;
const DOCS_LIST_CAP = 150;
const SHORT_ISSUE_CHARS = 300;
// The instruction chain a repository publishes: the agent entry files and the
// rule directories go in whole, and the documents those entries name go in as
// routes — path plus the line that names it. A rule that declares `paths:` in
// its front matter (the Claude Code rules convention) is in only when a changed
// file matches one of them, and then whole: the rules phase walks the diff for
// it without a read of its own.
const RULES_ENTRIES = ["AGENTS.md", "CLAUDE.md", "docs/engineering/README.md"];
const RULES_DIRS = ["docs/engineering/rules", ".claude/rules"];
const RULES_ROUTE_CAP = 40;
const ROUTE_HINT_CHARS = 160;
// Files whose change buys no behavior of its own: documentation, generated
// code and tests (the gate ran them). A whitespace-only change is the same.
export const DOC_PATH = /(?:^|\/)docs?\/|\.(?:md|mdx|rst|adoc|txt)$/i;
const GENERATED_PATH = /(?:^|\/)(?:generated|__generated__)\/|\.generated\.[a-z]+$/i;
// Risk categories of a hit; `access` takes whatever the others do not name.
// Irreversible data work, or two categories meeting in one change, buy the top
// depth.
const RISK_CATEGORIES = [
  ["data", /migrat|backfill|retention|truncate|purge|alter\s+table|drop\s+(?:table|column|index)|delete\s+from|rm\s+-rf|миграц|удал[её]н/i],
  ["secrets", /passw|secret|credential|api[_-]?key|парол/i],
  ["crypto", /crypt|hmac|шифр/i],
  ["injection", /sql|unserialize|deserializ/i],
  ["upload", /upload|multipart/i],
];
// A markdown link or bare path naming a document of this repository; a URL, an
// absolute path or a traversal is not one.
const DOC_LINK = /(?:^|[\s(<"'`[])([A-Za-z0-9._][A-Za-z0-9._/-]*\.md)\b/g;
const METHOD_REFERENCE = ["..", "..", "..", "references", "engineering-evidence.md"];
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
// Signals that raise the review depth and the security escalation:
// access control, secrets, cryptography, injection surfaces, uploads,
// deserialization, migrations and destructive data operations, in the
// English and Russian the codebases mix.
const RISK = /\b(?:auth[a-z]*|login|logout|sessions?|tokens?|passw(?:or)?ds?|secrets?|credentials?|api[_-]?keys?|crypt[a-z]*|hmac|jwt|oauth|permissions?|acl|roles?|privileges?|tenants?|sql|unserialize|deserializ[a-z]*|uploads?|multipart|migrat[a-z]*|backfill|retention|truncate|purge)\b|alter\s+table|drop\s+(?:table|column|index)|delete\s+from|rm\s+-rf|парол|токен|шифр|полномоч|миграц|удал[её]н/i;
const OUTBOUND = /\b(?:Guzzle\w*|HttpClient|curl_\w+|CURLOPT_\w+|fetch|allow_redirects|redirects?|recordings_url|downloadFile)\b|(?:http|client|axios)\w*\s*(?:->|\.)\s*(?:request|get|post)\s*\(|https?:\/\//i;
export const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[a-z]+$|Test\.php$|_test\.[a-z]+$/;
// A test declaration, in the shapes the common runners use. The pack carries
// these names instead of the test bodies: the review judges the code, and opens
// a test file when it doubts the strength of a test or the cover of a scenario.
// Groups 1 and 2 are the runner function and its modifier — what marks a case
// skipped, focused or todo; the name is the first group after them.
const TEST_CASE = /(?:^|\s)(x?(?:it|test|describe|context))\s*(?:\.(\w+))?\s*\(\s*[`'"](.+?)[`'"]|(?:^|\s)def\s+(test_\w+)|(?:public\s+)?function\s+(test\w+)|(?:^|\s)func\s+(Test\w+)|(?:^|\s)(?:it|Scenario|Feature)\s*\(\s*[`'"](.+?)[`'"]/gm;
const TEST_CASE_CAP = 40;
const TEST_CASE_MARKS = ["skip", "only", "todo"];

const USAGE = `review-pack.mjs — one-call review context for the code-reviewer role.
Run from the review workspace (the process cwd, a git checkout of the reviewed
branch). Pipe the Assignment v1 JSON on stdin:
  node review-pack.mjs --assignment - <<'JSON'
  { …assignment… }
  JSON
Flags: --base <ref> (default repository.base_ref), --budget <chars> (300000),
--out <path> (pack file, default beside the packet file, or under the OS temp
dir for stdin), --skip=<sections> (passed to env-snapshot), --check (wrapper
pre-launch gate: strict packet validation, base and diff resolution, the review
depth, nothing written), --usage.
Requires repository.base_ref (or --base), a source_materials entry named issue
carrying the task text inline (kind text) or as a file path the wrapper wrote
(kind attachment_reference; a subtask also carries name parent_issue), and one
named qa_result — the QA role's result file (attachment_reference) or its JSON
inline (text): kind qa_result, checks[], workspace.head naming the reviewed HEAD.
The workspace carries no uncommitted change.
Pack sections, in order: attention (cuts and notes), signals, scope, decisions
(only when the packet carries any), issue, parent_issue, materials, repository,
development_result, previous_review and qa_result (the files those materials
name, projected without duplicate history), method (the shared engineering reference), rules (the repository
instruction chain: the entry files and the applicable rules whole, then routes to
the documents they name), env, files, tests (declared cases of the changed test
files, marked [skip], [only] or [todo], and \`removed:\` for each case a modified
file dropped), diff.
Depth: 1 documentation, generated, formatting or test files only; 2 behavior
without a risk signal; 4 one risk category; 5 irreversible data work or two risk
categories; one lower on a repeat review, never below 1. The wrapper maps the
level to its runtime's model and effort.
Output: one JSON line {ok, pack, harness, base, head, files, changed_lines,
test_files, risk_hits[{path,line,match}], depth{level,reason}, navigation
lsd|none, diff_context, truncations[], warnings[], pack_chars}; harness is the
command prefix of review-findings.mjs bound to this review's journal.
--check returns {ok, check, base, head, files, changed_lines, test_files,
risk_hits, depth, review_kind, issue_chars, warnings}.
ok:false codes: bad_args | bad_packet (--check; detail lists the problems) |
missing_base_ref | missing_issue | missing_qa_result | not_a_git_repository |
base_ref_not_found | review_state_mismatch (uncommitted changes, QA evidence for
another HEAD, or a repeat review whose task, rules or code moved) | empty_diff |
pack_write_failed. Exit 1 on ok:false.
`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, detail) {
  out(detail ? { ok: false, code, detail } : { ok: false, code });
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { assignment: null, base: null, budget: DEFAULTS.budget, out: null, skip: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (arg === "--usage") return { usage: true };
    if (arg === "--assignment") opts.assignment = next();
    else if (arg === "--base") opts.base = next();
    else if (arg === "--budget") opts.budget = Number(next());
    else if (arg === "--out") opts.out = next();
    else if (arg === "--check") opts.check = true;
    else if (arg.startsWith("--skip=")) opts.skip = arg;
    else return { error: `unknown argument ${arg}` };
  }
  if (!opts.assignment) return { error: "--assignment is required" };
  if (!Number.isInteger(opts.budget) || opts.budget < 1000) return { error: "--budget must be an integer of at least 1000" };
  return opts;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: 60000, stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\n$/, "");
  } catch {
    return null;
  }
}

function readAssignment(source) {
  let raw;
  try {
    raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A wrapper that hands one string where the contract says a list meant one item.
const asList = (value) => (Array.isArray(value) ? value.filter(isText) : isText(value) ? [value] : []);

// A material is found by name; `kind` decides only whether the content is the
// text itself or the path of the file the wrapper wrote it to. A wrapper that
// dropped `kind` still names the material, so the content decides.
function material(assignment, name) {
  if (!Array.isArray(assignment.source_materials)) return null;
  const item = assignment.source_materials.find((entry) => isPlainObject(entry) && entry.name === name && isText(entry.content));
  if (!item) return null;
  const content = String(item.content);
  const found = { name, provenance: isText(item.provenance) ? item.provenance : "", text: null, path: null };
  const asFile = item.kind === "attachment_reference" || (item.kind !== "text" && isAbsolute(content.trim()) && existsSync(content.trim()));
  if (!asFile) return { ...found, text: content };
  found.path = content.trim();
  try {
    found.text = readFileSync(found.path, "utf8");
  } catch {
    found.error = `file not readable: ${found.path}`;
  }
  return found;
}

// A closing tag inside author content would close the section early.
function section(name, body, attrs = {}) {
  const head = Object.entries(attrs).map(([key, value]) => ` ${key}="${String(value).replace(/"/g, "&quot;")}"`).join("");
  const safe = String(body).replaceAll(`</${name}>`, `&lt;/${name}&gt;`);
  return `<${name}${head}>\n${safe}\n</${name}>`;
}

const bullets = (items) => items.map((item) => `- ${item}`).join("\n");

export function parseNameStatus(text) {
  const files = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    const path = parts[parts.length - 1];
    const entry = { status, path };
    if ((status === "R" || status === "C") && parts.length >= 3) entry.from = parts[1];
    files.push(entry);
  }
  return files;
}

function changedLines(numstat) {
  let total = 0;
  for (const line of (numstat ?? "").split("\n")) {
    const [added, removed] = line.split("\t");
    total += (Number(added) || 0) + (Number(removed) || 0);
  }
  return total;
}

// Added lines of the narrow diff and the changed paths, scanned for risk
// signals; hunk headers keep the new-side line number current.
function riskHits(narrowDiff, files) {
  const hits = [];
  for (const file of files) {
    const match = RISK.exec(file.path);
    if (match) hits.push({ path: file.path, line: null, match: match[0] });
  }
  let file = null;
  let line = 0;
  for (const raw of narrowDiff.split("\n")) {
    if (hits.length >= RISK_HIT_CAP) break;
    if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const match = RISK.exec(raw.slice(1));
    const network = OUTBOUND.exec(raw.slice(1));
    if (match || network) hits.push({ path: file, line, match: (match ?? network)[0], ...(network ? { rule: "outbound_url" } : {}) });
    line += 1;
  }
  return hits;
}

function widestDiff(range, cwd, budget, narrow, paths) {
  for (const context of DIFF_WIDTHS) {
    const text = context === 0 ? narrow : (git(["diff", `-U${context}`, range, "--", ...paths], cwd) ?? "");
    if (text.length <= budget) return { text, context, cut: false, hidden: [] };
  }
  const hidden = [];
  for (const match of narrow.matchAll(/^diff --git a\/.* b\/(.*)$/gm)) {
    if (match.index >= budget) hidden.push(match[1]);
  }
  return { text: narrow.slice(0, budget), context: 0, cut: true, hidden };
}

// Documents an entry file names, resolved inside the repository only, each with
// the line that names it: that line is the condition for reading the document.
function routes(text, root, seen, state) {
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(DOC_LINK)) {
      const relative = match[1];
      if (seen.has(relative)) continue;
      const target = resolve(root, relative);
      if (target !== join(root, relative) || !existsSync(target)) continue;
      seen.add(relative);
      if (state.list.length >= RULES_ROUTE_CAP) { state.cut.push(relative); continue; }
      const hint = line.replace(/^[\s>*+-]*/, "").trim().slice(0, ROUTE_HINT_CHARS);
      state.list.push(hint && hint !== relative ? `${relative} — ${hint}` : relative);
    }
  }
}

// The front matter's `paths:` globs — an inline list, a YAML list or one scalar.
export function rulePaths(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) return { paths: null, body: text };
  const body = text.slice(front[0].length);
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^paths:/.test(line));
  if (at < 0) return { paths: null, body };
  const unquote = (value) => value.trim().replace(/^["']|["']$/g, "").trim();
  const inline = lines[at].slice("paths:".length).trim();
  let paths;
  if (inline.startsWith("[")) paths = inline.replace(/^\[|\]$/g, "").split(",").map(unquote);
  else if (inline) paths = [unquote(inline)];
  else {
    paths = [];
    for (const line of lines.slice(at + 1)) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item) break;
      paths.push(unquote(item[1]));
    }
  }
  return { paths: paths.filter(Boolean), body };
}

export function globRegExp(glob) {
  let source = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") { i += 1; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") { braces += 1; source += "(?:"; }
    else if (char === "}" && braces > 0) { braces -= 1; source += ")"; }
    else if (char === "," && braces > 0) source += "|";
    else source += char.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source.replace(/^\/+/, "")}$`);
}

// null changed paths: no applicability filter (the policy hash enumerates every
// candidate rule, applicable or not).
const applies = (paths, changed) => changed === null || paths.map(globRegExp).some((glob) => changed.some((path) => glob.test(path)));

export function collectRules(root, cwd, budget, changed = null) {
  const seen = new Set();
  const entries = [];
  for (const entry of RULES_ENTRIES) {
    if (seen.has(entry) || !existsSync(join(root, entry))) continue;
    seen.add(entry);
    entries.push({ path: entry, text: readFileSync(join(root, entry), "utf8") });
  }
  if (entries.length === 0) {
    const paths = (git(["ls-files", "docs/*.md", "docs/**/*.md"], cwd) ?? "").split("\n").filter(Boolean).slice(0, DOCS_LIST_CAP);
    return { mode: "paths", paths, routes: [], routes_cut: [], items: [], dropped: [], skipped: [] };
  }
  const items = [...entries];
  const skipped = [];
  for (const dirPath of RULES_DIRS) {
    const dir = join(root, dirPath);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { recursive: true }).map(String).filter((entry) => entry.endsWith(".md")).sort()) {
      const relative = `${dirPath}/${name}`;
      if (seen.has(relative)) continue;
      seen.add(relative);
      const { paths, body } = rulePaths(readFileSync(join(dir, name), "utf8"));
      if (paths && !applies(paths, changed)) { skipped.push(relative); continue; }
      items.push({ path: relative, text: body });
    }
  }
  // Routes are drawn from the entry files only, and never repeat a document the
  // pack already carries whole. A routed document that declares its paths is no
  // longer a route: applicable, it rides whole; otherwise it stays out.
  const state = { list: [], cut: [] };
  for (const entry of entries) routes(entry.text, root, seen, state);
  const routed = [];
  for (const route of state.list) {
    const path = route.split(" — ")[0];
    const { paths, body } = rulePaths(readFileSync(join(root, path), "utf8"));
    if (!paths || changed === null) routed.push(route);
    else if (applies(paths, changed)) items.push({ path, text: body });
    else skipped.push(path);
  }
  const kept = [];
  const dropped = [];
  // Routes come first: when the budget is tight, knowing where a rule lives
  // beats holding one rule and losing the map to the rest.
  let used = routed.reduce((total, route) => total + route.length + 3, 0);
  for (const item of items) {
    const size = item.path.length + item.text.length + 8;
    if (used + size <= budget) { kept.push(item); used += size; } else dropped.push(item.path);
  }
  return { mode: "content", paths: [], routes: routed, routes_cut: state.cut, items: kept, dropped, skipped };
}

// The depth the most expensive hunk buys; size never raises it. Only code
// counts: a password in a fixture or a table named in a document is not a
// change of that kind.
export function reviewDepth(files, hits, inert, repeat) {
  const code = new Set(files.map((file) => file.path).filter((path) => !inert.has(path)));
  const categories = [...new Set(hits.filter((hit) => code.has(hit.path)).map((hit) => (
    hit.rule === "outbound_url" ? "outbound" : (RISK_CATEGORIES.find(([, pattern]) => pattern.test(hit.match))?.[0] ?? "access")
  )))].sort();
  let level;
  let reason;
  if (code.size === 0) { level = 1; reason = "documentation, generated, formatting or test files only"; }
  else if (categories.length === 0) { level = 2; reason = "behavior change without a risk signal"; }
  else if (categories.includes("data") || categories.length > 1) { level = 5; reason = `risk categories: ${categories.join(", ")}`; }
  else { level = 4; reason = `risk category: ${categories[0]}`; }
  if (repeat && level > 1) { level -= 1; reason += "; repeat review, one level lower"; }
  return { level, reason };
}

// Paths whose change carries no behavior of its own; a file whose diff is
// whitespace only joins them.
function inertPaths(files, range, cwd) {
  const inert = new Set(files.filter((file) => TEST_PATH.test(file.path) || DOC_PATH.test(file.path) || GENERATED_PATH.test(file.path)).map((file) => file.path));
  const touched = new Set();
  for (const line of (git(["diff", "-w", "--ignore-blank-lines", "--numstat", range], cwd) ?? "").split("\n")) {
    const [added, removed, path] = line.split("\t");
    if (path && (added !== "0" || removed !== "0")) touched.add(path);
  }
  for (const file of files) if (file.status === "M" && !touched.has(file.path)) inert.add(file.path);
  return inert;
}

// The `lsd` of this skill, not the ls replacement of the same name: its help
// names the declaration lookup.
function lsdAvailable(cwd) {
  try {
    return /Where a symbol is declared/.test(execFileSync("lsd", ["--help"], { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

// The first question in a tree waits for its index; the rebuild starts now,
// detached, so it walks while the reviewer reads the pack.
function warmLsd(root) {
  try {
    spawn("lsd", ["reindex", root], { cwd: root, detached: true, stdio: "ignore" }).unref();
  } catch {
    // A warm index is a saving, never a precondition.
  }
}

// Declared cases of one test source, by name; a case the runner will not run as
// written carries its mark, and a marked duplicate of a name wins over a plain one.
function declaredCases(source) {
  const cases = new Map();
  for (const match of (source ?? "").matchAll(TEST_CASE)) {
    const name = match.slice(3).find((group) => group !== undefined)?.trim();
    const mark = match[1]?.startsWith("x") ? "skip" : TEST_CASE_MARKS.find((item) => item === match[2]);
    if (!name || (cases.has(name) && !mark)) continue;
    cases.set(name, mark ? `${name} [${mark}]` : name);
  }
  return cases;
}

// Every test file of the change, each with its declared cases: enough to see
// which scenarios claim cover and how the suite is named, without the bodies.
// A modified file also names the cases its base version declared and HEAD no
// longer does.
function testDigest(files, range, mergeBase, cwd) {
  const counts = new Map();
  for (const line of (git(["diff", "--numstat", range, "--", ...files.map((file) => file.path)], cwd) ?? "").split("\n")) {
    const [added, removed, path] = line.split("\t");
    if (path) counts.set(path, `+${Number(added) || 0} -${Number(removed) || 0}`);
  }
  const parts = [];
  for (const file of files) {
    const before = ["M", "D"].includes(file.status) ? git(["show", `${mergeBase}:${file.path}`], cwd) : null;
    const declared = declaredCases(file.status === "D" ? before : git(["show", `HEAD:${file.path}`], cwd));
    const cases = [...declared.values()].slice(0, TEST_CASE_CAP);
    const removed = file.status === "M"
      ? [...declaredCases(before).keys()].filter((name) => !declared.has(name)).slice(0, TEST_CASE_CAP).map((name) => `removed: ${name}`)
      : [];
    const head = `${file.status} ${file.from ? `${file.from} → ` : ""}${file.path} ${counts.get(file.path) ?? ""}`.trimEnd();
    parts.push(`${head}\n${bullets([...(cases.length ? cases : ["(no declared case found)"]), ...removed])}`);
  }
  return parts.join("\n\n");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

function methodReference() {
  try {
    return readFileSync(join(scriptDir, ...METHOD_REFERENCE), "utf8").trimEnd();
  } catch {
    return "The shared engineering reference is missing from this plugin install; apply its counterexample, test-strength and comment checks from memory of the role skill.";
  }
}

function envSnapshot(cwd, skip) {
  const script = join(scriptDir, "..", "..", "env-snapshot", "scripts", "env-snapshot.mjs");
  try {
    const text = execFileSync(process.execPath, [script, "--json", ...(skip ? [skip] : [])], {
      cwd, encoding: "utf8", timeout: 60000, maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "env-snapshot failed; collect the environment baseline by hand" };
  }
}

function renderMaterials(items) {
  const parts = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const head = `### ${item.name ?? "(unnamed)"} (${item.kind ?? "?"}; ${item.provenance ?? "provenance unknown"})`;
    if (item.kind === "attachment_reference") parts.push(`${head}\nfile: ${item.content}`);
    else parts.push(`${head}\n${item.content ?? ""}`);
  }
  return parts.join("\n\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.usage) { process.stdout.write(USAGE); return; }
  if (opts.error) fail("bad_args", opts.error);

  const assignment = readAssignment(opts.assignment);
  if (!assignment || !isText(assignment.assignment_id)) fail("bad_args", "assignment JSON with assignment_id is required");
  if (opts.check) {
    const problems = packetProblems(assignment);
    if (problems.length > 0) fail("bad_packet", problems);
  }

  const repository = isPlainObject(assignment.repository) ? assignment.repository : {};
  const base = opts.base ?? (isText(repository.base_ref) ? repository.base_ref.trim() : null);
  if (!base) fail("missing_base_ref");

  const issue = material(assignment, "issue");
  if (!issue) fail("missing_issue");
  if (issue.error) fail("missing_issue", issue.error);
  if (!isText(issue.text)) fail("missing_issue", issue.path ? `empty file: ${issue.path}` : "empty content");
  const parent = material(assignment, "parent_issue");
  // Prior Results remain claims, projected without repeated phase output.
  const developmentResult = material(assignment, "development_result");
  const previousReview = material(assignment, "previous_review");
  // The gate's result is the QA role's file; a packet without it predates the
  // QA stage, and a review that ran its own checks would hide that.
  const qaResult = material(assignment, "qa_result");
  if (!qaResult) fail("missing_qa_result");
  if (qaResult.error) fail("missing_qa_result", qaResult.error);
  if (!isText(qaResult.text)) fail("missing_qa_result", qaResult.path ? `empty file: ${qaResult.path}` : "empty content");
  const qa = parseResult(qaResult);
  if (qa?.kind !== "qa_result" || !Array.isArray(qa.checks)) fail("missing_qa_result", "qa_result is not a QA result file (kind qa_result with checks[])");

  const cwd = process.cwd();
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) fail("not_a_git_repository");

  const baseRef = [base, `origin/${base}`].find((candidate) => git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], cwd) !== null);
  const mergeBase = baseRef ? git(["merge-base", baseRef, "HEAD"], cwd) : null;
  if (!mergeBase) fail("base_ref_not_found", base);
  const range = `${mergeBase}..HEAD`;

  const headCommit = git(["rev-parse", "HEAD"], cwd);
  // The review reads committed code and the gate that ran on it: a dirty tree
  // or a QA result of another commit is not the state under review.
  const dirty = git(["status", "--porcelain"], cwd);
  if (dirty !== "") fail("review_state_mismatch", `uncommitted changes in the review workspace: ${dirty === null ? "git status failed" : dirty.split("\n").slice(0, 5).map((line) => line.slice(3)).join(", ")}`);
  const qaHead = qa.workspace?.head;
  if (typeof qaHead !== "string" || qaHead.length < 7 || !headCommit.startsWith(qaHead)) fail("review_state_mismatch", "QA evidence is for another HEAD; rerun the gate");
  const priorResult = parseResult(previousReview);
  const prior = previousManifest(priorResult);
  const materials = assignment.source_materials.filter((item) => !["issue", "parent_issue", "qa_result", "previous_review", "development_result"].includes(item.name)).map((item) => {
    if (item.kind !== "attachment_reference") return item;
    try { return { ...item, hash: digest(readFileSync(item.content)) }; } catch { return { ...item, hash: null }; }
  });
  const inputHash = digest({ objective: assignment.objective, scope: assignment.scope, verification: assignment.verification, decisions: assignment.accepted_decisions, issue: issue.text, parent: parent?.text, materials });
  const policy = collectRules(root, cwd, Number.MAX_SAFE_INTEGER);
  const policyPaths = [...new Set([...policy.items.map((item) => item.path), ...policy.paths, ...policy.routes.map((route) => route.split(" — ")[0]), ...policy.routes_cut])];
  const policyHash = digest([methodReference(), readFileSync(join(scriptDir, "..", "SKILL.md"), "utf8"), policyPaths.map((path) => {
    try { return [path, digest(readFileSync(join(root, path)))]; } catch { return [path, null]; }
  })]);
  const priorMatches = prior?.version === 1 && prior.root === root && prior.input_hash === inputHash && prior.policy_hash === policyHash && prior.assignment_id === priorResult?.assignment_id;

  const files = parseNameStatus(git(["diff", "--name-status", range], cwd));
  let reviewKind = previousReview ? "fix_delta" : "full";
  if (prior && mergeBase === prior.head && !priorMatches) fail("review_state_mismatch", "task or rules changed since the previous review; prepare a fresh full review");
  if (files.length === 0) {
    if (!previousReview) fail("empty_diff", `no changes between ${base} and HEAD`);
    if (!priorMatches || prior.head !== headCommit || priorResult.status !== "done" || priorResult.deliverable?.content?.review_complete !== true || reviewProblems(priorResult).length) {
      fail("review_state_mismatch", "QA-only review requires a complete previous review of this unchanged code, task and rules");
    }
    reviewKind = "evidence_only";
  } else if (previousReview && (!priorMatches || mergeBase !== prior.head)) {
    reviewKind = "full";
  }
  const originalBase = priorMatches && reviewKind !== "full" ? prior.base : mergeBase;
  const coveredFiles = parseNameStatus(git(["diff", "--name-status", `${originalBase}..HEAD`], cwd));
  const manifest = { version: 1, assignment_id: assignment.assignment_id, root, head: headCommit, base: originalBase, input_hash: inputHash, policy_hash: policyHash, review_kind: reviewKind, files: coveredFiles.map((file) => file.path), previous_fixes: Array.isArray(priorResult?.required_fixes) ? priorResult.required_fixes.map((fix) => /^\s*([A-Za-z]+\d+)\b/.exec(fix)?.[1]).filter(Boolean) : [] };
  const lines = changedLines(git(["diff", "--numstat", range], cwd));
  // Tests ride as a digest, not as diff: the review judges the code the tests
  // exercise. A change that is only tests has no code to judge instead, so
  // there they are the diff.
  const tests = files.filter((file) => TEST_PATH.test(file.path));
  const code = files.filter((file) => !TEST_PATH.test(file.path));
  const diffFiles = code.length ? code : files;
  const digestFiles = code.length ? tests : [];
  const diffPaths = diffFiles.map((file) => file.path);
  const narrow = diffPaths.length ? git(["diff", "-U0", range, "--", ...diffPaths], cwd) ?? "" : "";
  // Risk signals steer the security review of the change; a fixture naming a
  // password or a table is not that change.
  const hits = riskHits(narrow, diffFiles);
  const depth = reviewDepth(files, hits, inertPaths(files, range, cwd), Boolean(previousReview));
  const testFiles = tests.length;
  const head = git(["rev-parse", "--short", "HEAD"], cwd);

  const warnings = [];
  const issueChars = issue.text.trim().length;
  if (issueChars < SHORT_ISSUE_CHARS) {
    warnings.push(`issue text is ${issueChars} characters: a wrapper passes the tracker text verbatim, not a summary`);
  }
  for (const [name, item] of [["parent_issue", parent], ["development_result", developmentResult], ["previous_review", previousReview]]) {
    if (item?.error) warnings.push(`${name} ${item.error}`);
  }

  if (opts.check) {
    out({
      ok: true, check: true, base, head, files: files.length, changed_lines: lines, test_files: testFiles, risk_hits: hits, depth, review_kind: reviewKind, issue_chars: issueChars, warnings,
    });
    return;
  }

  const truncations = [];
  const fixed = [];
  const navigation = lsdAvailable(root) ? "lsd" : "none";
  if (navigation === "lsd") warmLsd(root);
  const changedPaths = files.flatMap((file) => (file.from ? [file.path, file.from] : [file.path]));
  const applicable = collectRules(root, cwd, Number.MAX_SAFE_INTEGER, changedPaths);
  // The rules line follows from the budget cut further down; the placeholder
  // differs from the final line by a few characters and cannot move the budget.
  const signals = (kept) => section("signals", [
    `files: ${files.length}`,
    `changed_lines: ${lines}`,
    `test_files: ${testFiles}`,
    `review_kind: ${reviewKind}`,
    `depth: ${depth.level} — ${depth.reason}`,
    navigation === "lsd"
      ? "navigation: lsd — its index was started before your first turn; the first question may wait up to a minute"
      : "navigation: none — settle symbol questions with Grep and the page reader",
    `rules: ${kept} carried whole, ${applicable.skipped.length} left out by their paths`,
    ...(hits.some((hit) => hit.rule === "outbound_url") ? ["outbound_url: read the project's outbound URL/SSRF rule and central validator; trace URL ownership, redirects, transport and any preload in callers, including newly added fix code"] : []),
    hits.length ? `risk_hits:\n${bullets(hits.map((hit) => `${hit.path}${hit.line ? `:${hit.line}` : ""} — ${hit.match}`))}` : "risk_hits: none",
  ].join("\n"));
  const signalsAt = fixed.length;
  fixed.push(signals(applicable.items.length));

  const scope = isPlainObject(assignment.scope) ? assignment.scope : {};
  fixed.push(section("scope", [
    `objective: ${assignment.objective ?? "(none)"}`,
    `included:\n${bullets(asList(scope.included)) || "- (none)"}`,
    `excluded:\n${bullets(asList(scope.excluded)) || "- (none)"}`,
    `verification:\n${bullets(asList(assignment.verification)) || "- (none)"}`,
  ].join("\n")));
  const decisions = asList(assignment.accepted_decisions);
  if (decisions.length) fixed.push(section("decisions", bullets(decisions)));
  fixed.push(section("issue", issue.text, { name: issue.name, provenance: issue.provenance, ...(issue.path ? { file: issue.path } : {}) }));
  if (parent && isText(parent.text)) {
    fixed.push(section("parent_issue", parent.text, { name: parent.name, provenance: parent.provenance, ...(parent.path ? { file: parent.path } : {}) }));
  }
  const taken = new Set(["issue", "parent_issue", "development_result", "previous_review", "qa_result"]);
  const others = assignment.source_materials.filter((item) => !(isPlainObject(item) && taken.has(item.name)));
  if (others.length) fixed.push(section("materials", renderMaterials(others)));
  fixed.push(section("repository", JSON.stringify(repository, null, 1)));
  if (developmentResult && isText(developmentResult.text)) {
    fixed.push(section("development_result", compactResult(developmentResult), developmentResult.path ? { file: developmentResult.path } : {}));
  }
  if (previousReview && isText(previousReview.text)) {
    fixed.push(section("previous_review", compactResult(previousReview), previousReview.path ? { file: previousReview.path } : {}));
  }
  fixed.push(section("qa_result", compactQa(qaResult), { note: "the gate, run once by the QA role: passed, failed, broken and skipped items at the width named on each; a failed item is a defect of the change unless its attribution says baseline, a broken one is residual risk, never coverage", ...(qaResult.path ? { file: qaResult.path } : {}) }));
  fixed.push(section("method", methodReference()));

  const env = envSnapshot(cwd, `--skip=rules,docs,git,validation${opts.skip ? `,${opts.skip.slice(7)}` : ""}`);
  // The gate is the QA role's and the pack reads git itself: only the runtime rides.
  const envRest = { ok: env.ok, runtime: env.runtime, workspace: { head: headCommit, base: mergeBase } };
  const envText = section("env", JSON.stringify(envRest, null, 1));
  const filesText = section("files", bullets(files.map((file) => `${file.status} ${file.from ? `${file.from} → ` : ""}${file.path}${TEST_PATH.test(file.path) ? " (test)" : ""}`)));
  const testsText = digestFiles.length
    ? section("tests", testDigest(digestFiles, range, mergeBase, cwd), { note: "declared cases only, marked [skip], [only] or [todo], and `removed:` for a case the change dropped; open the file to judge a test's strength or a scenario's cover" })
    : "";

  const fixedLength = fixed.join("\n\n").length + envText.length + filesText.length + testsText.length;
  const diffBudget = Math.max(opts.budget - fixedLength - RULES_RESERVE, Math.floor(opts.budget * DIFF_FLOOR_SHARE));
  const diff = widestDiff(range, cwd, diffBudget, narrow, diffPaths);
  // A cut diff stays with the same reviewer: it pages through the rest, and the
  // journal keeps findings and coverage across any compaction on the way.
  if (diff.cut) {
    truncations.push(`diff cut at ${diffBudget} characters (context 0); page through the rest with \`git diff ${range} -- <path>\`${diff.hidden.length ? `, starting with: ${diff.hidden.join(", ")}` : ""}`);
  }

  const rules = collectRules(root, cwd, Math.max(opts.budget - fixedLength - diff.text.length, 0), changedPaths);
  fixed[signalsAt] = signals(rules.items.length);
  if (rules.dropped.length) truncations.push(`rules omitted for budget, read them yourself: ${rules.dropped.join(", ")}`);
  if (rules.routes_cut.length) truncations.push(`rule routes past the cap of ${RULES_ROUTE_CAP}, follow the entry files for them: ${rules.routes_cut.join(", ")}`);
  const rulesText = rules.mode === "content"
    ? [
      ...rules.items.map((item) => `#### ${item.path}\n\n${item.text.trimEnd()}`),
      ...(rules.routes.length ? [`#### routed by the entry files — open the one your doubt names\n\n${bullets(rules.routes)}`] : []),
    ].join("\n\n")
    : (rules.paths.length ? `No ${RULES_ENTRIES.join(", ")}; documentation paths to route reads:\n${bullets(rules.paths)}` : "No documentation in this repository.");

  const attention = [
    `Diff: merge base of ${base} and HEAD, context ${diff.context} lines. The files listed are the whole change; a path outside them is not under review.`,
    ...truncations,
    ...warnings,
  ];

  const build = (notes, sections) => [
    `<review_pack assignment_id="${assignment.assignment_id}" base="${base}" head="${head ?? ""}">`,
    section("attention", bullets([...attention, ...notes])),
    ...fixed,
    section("rules", rulesText),
    ...sections,
    filesText,
    ...(testsText ? [testsText] : []),
    section("diff", diff.text, { context: diff.context }),
    "</review_pack>",
  ].join("\n\n");
  const slug = assignment.assignment_id.replace(/[^A-Za-z0-9._-]+/g, "-");
  const packDir = opts.assignment === "-" ? tmpdir() : dirname(resolve(opts.assignment));
  const target = opts.out ? resolve(opts.out) : join(packDir, `review-pack-${slug}.md`);
  const manifestTarget = `${target}.json`;
  // The harness records into the journal and writes the Result from it; the
  // manifest tells it what the change is, what the gate said and what the
  // previous round required.
  manifest.journal = join(dirname(target), `review-journal-${slug}.json`);
  manifest.result = join(packDir, `result-${slug}.json`);
  manifest.repeat = Boolean(previousReview);
  manifest.qa_checks = qa.checks.map((item) => ({ id: item.id, command: item.command ?? item.tool ?? item.id, status: item.status, width: item.width }));
  manifest.qa_verdict = qa.verdict;
  manifest.qa_obstacles = Array.isArray(qa.obstacles) ? qa.obstacles.filter(isText) : [];
  manifest.previous_ids = Array.isArray(priorResult?.findings) ? priorResult.findings.map((item) => item?.id).filter(isText) : [];
  const journal = { findings: [], coverage: {}, phases: {}, fix_resolution: {} };
  // Coverage the previous round established outside what changed since stays
  // established; the reviewer overrides any item it judges again.
  if (reviewKind !== "full") {
    const delta = new Set(files.map((file) => file.path));
    for (const item of Array.isArray(priorResult?.deliverable?.content?.coverage) ? priorResult.deliverable.content.coverage : []) {
      if (!isPlainObject(item) || !isText(item.item) || delta.has(item.item) || !["reviewed", "not_applicable"].includes(item.status)) continue;
      journal.coverage[item.item] = { status: item.status, evidence: `carried from the previous review: ${Array.isArray(item.evidence) ? item.evidence.join("; ") : item.evidence}` };
    }
    const phases = priorResult?.deliverable?.content?.phases;
    if (reviewKind === "evidence_only" && isPlainObject(phases)) {
      for (const [name, status] of Object.entries(phases)) journal.phases[name] = `carried from the previous review: ${status}`;
    }
  }
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const harness = `node ${quote(join(scriptDir, "review-findings.mjs"))} --manifest ${quote(manifestTarget)}`;
  fixed.push(section("review_manifest", JSON.stringify({ path: manifestTarget, review_kind: reviewKind, files: manifest.files }), { note: "coverage names these exact paths, one item each; the harness writes this manifest into the Result" }));
  fixed.push(section("harness", harness, { note: "the command prefix of every review-findings call: append the command and its flags" }));
  const pack = build([], [envText]);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${pack}\n`);
    writeFileSync(manifestTarget, `${JSON.stringify(manifest)}\n`);
    writeFileSync(manifest.journal, `${JSON.stringify(journal)}\n`);
  } catch (error) {
    fail("pack_write_failed", String(error.message));
  }

  out({
    ok: true,
    pack: target,
    harness,
    base,
    head,
    files: files.length,
    changed_lines: lines,
    test_files: testFiles,
    risk_hits: hits,
    depth,
    navigation,
    review_kind: reviewKind,
    review_manifest: manifestTarget,
    diff_context: diff.context,
    truncations,
    warnings,
    pack_chars: pack.length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
