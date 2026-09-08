#!/usr/bin/env node
// Review pack for the code-reviewer role: one call assembles everything the
// review reads before any plan — the assignment, the task text, the whole
// diff against the base the wrapper named, the shared engineering method,
// the project rules, risk signals and the environment baseline (the sibling
// env-snapshot, spawned here).
// Read-only, zero dependencies. The pack lands outside the repository so the
// reviewed tree stays clean; stdout carries one JSON line the parent steers by.
//
// Input: --assignment -    Assignment v1 JSON on stdin (or --assignment <path>)
//   --base <ref>           comparison base; default repository.base_ref
//   --budget <chars>       pack ceiling, default 150000
//   --lines <n>            in_context threshold on changed lines, default 100
//   --out <path>           pack file; default <tmpdir>/review-pack-<assignment_id>.md
//   --skip=<sections>      passed through to env-snapshot (rules,docs,git,runtime,tooling)
//   --usage                print this contract as prose
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, pack, base, head, files, changed_lines, test_files,
//               risk_hits: [{path, line, match}], mode: "children"|"in_context",
//               diff_context, truncations: [text], pack_chars}
//   ok:false → {ok, code, detail?}: bad_args | missing_base_ref | missing_issue |
//               not_a_git_repository | base_ref_not_found | empty_diff | pack_write_failed
// The diff is `git diff` from the merge base of <base> and HEAD (the three-dot
// range), at the widest context of 10, 6, 3 or 0 lines that fits the budget;
// a diff that does not fit even at 0 is cut and the files after the cut are
// listed. Mode: at most --lines changed lines and no risk hit → in_context,
// otherwise children.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = Object.freeze({ budget: 150000, lines: 100 });
const DIFF_WIDTHS = [10, 6, 3, 0];
const RULES_RESERVE = 20000;
const DIFF_FLOOR_SHARE = 0.4;
const RISK_HIT_CAP = 40;
const DOCS_LIST_CAP = 150;
const RULES_INDEX = "docs/engineering/README.md";
const METHOD_REFERENCE = ["..", "..", "..", "references", "engineering-evidence.md"];
const RULES_DIR = "docs/engineering/rules";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
// Signals that raise the review to children mode and the security escalation:
// access control, secrets, cryptography, injection surfaces, uploads,
// deserialization, migrations and destructive data operations, in the
// English and Russian the codebases mix.
const RISK = /\b(?:auth[a-z]*|login|logout|sessions?|tokens?|passw(?:or)?ds?|secrets?|credentials?|api[_-]?keys?|crypt[a-z]*|hmac|jwt|oauth|permissions?|acl|roles?|privileges?|tenants?|sql|unserialize|deserializ[a-z]*|uploads?|multipart|migrat[a-z]*|backfill|retention|truncate|purge)\b|alter\s+table|drop\s+(?:table|column|index)|delete\s+from|rm\s+-rf|парол|токен|шифр|полномоч|миграц|удал[её]н/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[a-z]+$|Test\.php$|_test\.[a-z]+$/;

const USAGE = `review-pack.mjs — one-call review context for the code-reviewer role.
Run from the review workspace (the process cwd, a git checkout of the reviewed
branch). Pipe the Assignment v1 JSON on stdin:
  node review-pack.mjs --assignment - <<'JSON'
  { …assignment… }
  JSON
Flags: --base <ref> (default repository.base_ref), --budget <chars> (150000),
--lines <n> (in_context threshold, 100), --out <path> (pack file, default under
the OS temp dir), --skip=<sections> (passed to env-snapshot), --usage.
Requires repository.base_ref (or --base) and a source_materials entry
{kind: text, name: issue}; a subtask also carries name: parent_issue.
Pack sections, in order: attention (cuts and notes), signals, scope, decisions,
issue, parent_issue, materials, repository, method (the shared engineering
reference), rules, env, files, diff.
Output: one JSON line {ok, pack, base, head, files, changed_lines, test_files,
risk_hits[{path,line,match}], mode children|in_context, diff_context,
truncations[], pack_chars}; ok:false codes: bad_args | missing_base_ref |
missing_issue | not_a_git_repository | base_ref_not_found | empty_diff |
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
  const opts = { assignment: null, base: null, budget: DEFAULTS.budget, lines: DEFAULTS.lines, out: null, skip: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (arg === "--usage") return { usage: true };
    if (arg === "--assignment") opts.assignment = next();
    else if (arg === "--base") opts.base = next();
    else if (arg === "--budget") opts.budget = Number(next());
    else if (arg === "--lines") opts.lines = Number(next());
    else if (arg === "--out") opts.out = next();
    else if (arg.startsWith("--skip=")) opts.skip = arg;
    else return { error: `unknown argument ${arg}` };
  }
  if (!opts.assignment) return { error: "--assignment is required" };
  if (!Number.isInteger(opts.budget) || opts.budget < 1000) return { error: "--budget must be an integer of at least 1000" };
  if (!Number.isInteger(opts.lines) || opts.lines < 0) return { error: "--lines must be a non-negative integer" };
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
const asList = (value) => (Array.isArray(value) ? value.filter(isText) : []);

function material(assignment, name) {
  if (!Array.isArray(assignment.source_materials)) return null;
  return assignment.source_materials.find((item) => item && item.kind === "text" && item.name === name && isText(item.content)) ?? null;
}

// A closing tag inside author content would close the section early.
function section(name, body, attrs = {}) {
  const head = Object.entries(attrs).map(([key, value]) => ` ${key}="${String(value).replace(/"/g, "&quot;")}"`).join("");
  const safe = String(body).replaceAll(`</${name}>`, `&lt;/${name}&gt;`);
  return `<${name}${head}>\n${safe}\n</${name}>`;
}

const bullets = (items) => items.map((item) => `- ${item}`).join("\n");

function parseNameStatus(text) {
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
    if (match) hits.push({ path: file, line, match: match[0] });
    line += 1;
  }
  return hits;
}

function widestDiff(range, cwd, budget, narrow) {
  for (const context of DIFF_WIDTHS) {
    const text = context === 0 ? narrow : (git(["diff", `-U${context}`, range], cwd) ?? "");
    if (text.length <= budget) return { text, context, cut: false, hidden: [] };
  }
  const hidden = [];
  for (const match of narrow.matchAll(/^diff --git a\/.* b\/(.*)$/gm)) {
    if (match.index >= budget) hidden.push(match[1]);
  }
  return { text: narrow.slice(0, budget), context: 0, cut: true, hidden };
}

function collectRules(root, cwd, budget) {
  const index = join(root, RULES_INDEX);
  if (!existsSync(index)) {
    const paths = (git(["ls-files", "docs/*.md", "docs/**/*.md"], cwd) ?? "").split("\n").filter(Boolean).slice(0, DOCS_LIST_CAP);
    return { mode: "paths", paths, items: [], dropped: [] };
  }
  const items = [{ path: RULES_INDEX, text: readFileSync(index, "utf8") }];
  const dir = join(root, RULES_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
      items.push({ path: `${RULES_DIR}/${name}`, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const item of items) {
    const size = item.path.length + item.text.length + 8;
    if (used + size <= budget) { kept.push(item); used += size; } else dropped.push(item.path);
  }
  return { mode: "content", paths: [], items: kept, dropped };
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
    if (!item || typeof item !== "object") continue;
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

  const repository = assignment.repository && typeof assignment.repository === "object" ? assignment.repository : {};
  const base = opts.base ?? (isText(repository.base_ref) ? repository.base_ref.trim() : null);
  if (!base) fail("missing_base_ref");

  const issue = material(assignment, "issue");
  if (!issue) fail("missing_issue");
  const parent = material(assignment, "parent_issue");

  const cwd = process.cwd();
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) fail("not_a_git_repository");

  const baseRef = [base, `origin/${base}`].find((candidate) => git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], cwd) !== null);
  const mergeBase = baseRef ? git(["merge-base", baseRef, "HEAD"], cwd) : null;
  if (!mergeBase) fail("base_ref_not_found", base);
  const range = `${mergeBase}..HEAD`;

  const files = parseNameStatus(git(["diff", "--name-status", range], cwd));
  if (files.length === 0) fail("empty_diff", `no changes between ${base} and HEAD`);
  const lines = changedLines(git(["diff", "--numstat", range], cwd));
  const narrow = git(["diff", "-U0", range], cwd) ?? "";
  const hits = riskHits(narrow, files);
  const testFiles = files.filter((file) => TEST_PATH.test(file.path)).length;
  const mode = lines <= opts.lines && hits.length === 0 ? "in_context" : "children";
  const head = git(["rev-parse", "--short", "HEAD"], cwd);

  const truncations = [];
  const fixed = [];
  fixed.push(section("signals", [
    `files: ${files.length}`,
    `changed_lines: ${lines}`,
    `test_files: ${testFiles}`,
    `mode: ${mode}`,
    hits.length ? `risk_hits:\n${bullets(hits.map((hit) => `${hit.path}${hit.line ? `:${hit.line}` : ""} — ${hit.match}`))}` : "risk_hits: none",
  ].join("\n")));

  const scope = assignment.scope && typeof assignment.scope === "object" ? assignment.scope : {};
  fixed.push(section("scope", [
    `objective: ${assignment.objective ?? "(none)"}`,
    `included:\n${bullets(asList(scope.included)) || "- (none)"}`,
    `excluded:\n${bullets(asList(scope.excluded)) || "- (none)"}`,
    `verification:\n${bullets(asList(assignment.verification)) || "- (none)"}`,
    `required_fixes (prior review, verify each first):\n${bullets(asList(assignment.required_fixes)) || "- (none)"}`,
  ].join("\n")));
  fixed.push(section("decisions", bullets(asList(assignment.accepted_decisions)) || "- (none: the issue text carries the intent)"));
  fixed.push(section("issue", issue.content, { name: issue.name, provenance: issue.provenance ?? "" }));
  if (parent) fixed.push(section("parent_issue", parent.content, { name: parent.name, provenance: parent.provenance ?? "" }));
  const others = assignment.source_materials.filter((item) => item !== issue && item !== parent);
  if (others.length) fixed.push(section("materials", renderMaterials(others)));
  fixed.push(section("repository", JSON.stringify(repository, null, 1)));
  fixed.push(section("method", methodReference()));

  const env = envSnapshot(cwd, opts.skip);
  const envText = section("env", JSON.stringify(env, null, 1));
  const filesText = section("files", bullets(files.map((file) => `${file.status} ${file.from ? `${file.from} → ` : ""}${file.path}`)));

  const fixedLength = fixed.join("\n\n").length + envText.length + filesText.length;
  const diffBudget = Math.max(opts.budget - fixedLength - RULES_RESERVE, Math.floor(opts.budget * DIFF_FLOOR_SHARE));
  const diff = widestDiff(range, cwd, diffBudget, narrow);
  if (diff.cut) {
    truncations.push(`diff cut at ${diffBudget} characters (context 0); read the rest yourself${diff.hidden.length ? `, starting with: ${diff.hidden.join(", ")}` : ""}`);
  }

  const rules = collectRules(root, cwd, Math.max(opts.budget - fixedLength - diff.text.length, 0));
  if (rules.dropped.length) truncations.push(`rules omitted for budget, read them yourself: ${rules.dropped.join(", ")}`);
  const rulesText = rules.mode === "content"
    ? rules.items.map((item) => `#### ${item.path}\n\n${item.text.trimEnd()}`).join("\n\n")
    : (rules.paths.length ? `No ${RULES_INDEX}; documentation paths to route reads:\n${bullets(rules.paths)}` : "No docs/ directory in this repository.");

  const attention = [
    `Diff: merge base of ${base} and HEAD, context ${diff.context} lines. The files listed are the whole change; a path outside them is not under review.`,
    ...truncations,
  ];

  const pack = [
    `<review_pack assignment_id="${assignment.assignment_id}" base="${base}" head="${head ?? ""}">`,
    section("attention", bullets(attention)),
    ...fixed,
    section("rules", rulesText),
    envText,
    filesText,
    section("diff", diff.text, { context: diff.context }),
    "</review_pack>",
  ].join("\n\n");

  const target = opts.out ? resolve(opts.out) : join(tmpdir(), `review-pack-${assignment.assignment_id.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${pack}\n`);
  } catch (error) {
    fail("pack_write_failed", String(error.message));
  }

  out({
    ok: true,
    pack: target,
    base,
    head,
    files: files.length,
    changed_lines: lines,
    test_files: testFiles,
    risk_hits: hits,
    mode,
    diff_context: diff.context,
    truncations,
    pack_chars: pack.length,
  });
}

main();
