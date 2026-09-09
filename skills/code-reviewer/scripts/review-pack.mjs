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
//   --budget <chars>       pack ceiling, default 150000
//   --lines <n>            in_context threshold on changed lines, default 100
//   --out <path>           pack file; default beside the packet file, or under
//                          <tmpdir> when the packet came on stdin
//   --skip=<sections>      passed through to env-snapshot (rules,docs,git,runtime,tooling)
//   --check                wrapper pre-launch gate: validate the packet strictly
//                          (contracts/validate-assignment.mjs), resolve the base
//                          and the diff, write nothing
//   --usage                print this contract as prose
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, pack, lens_pack (children mode only), base, head, files,
//               changed_lines, test_files, risk_hits: [{path, line, match}],
//               mode: "children"|"in_context", diff_context,
//               truncations: [text], warnings: [text], pack_chars}
//               (--check: {ok, check: true, base, head, files, changed_lines,
//               test_files, risk_hits, mode, issue_chars, warnings})
//   ok:false → {ok, code, detail?}: bad_args | bad_packet (--check only; detail
//               lists every problem) | missing_base_ref | missing_issue |
//               not_a_git_repository | base_ref_not_found | empty_diff |
//               pack_write_failed
// Task text: the source_materials entry named `issue` (a subtask also
// `parent_issue`) is read inline when it is text, or from the file its content
// names when the wrapper wrote the tracker text to disk (attachment_reference).
// The diff is `git diff` from the merge base of <base> and HEAD (the three-dot
// range), at the widest context of 10, 6, 3 or 0 lines that fits the budget;
// a diff that does not fit even at 0 is cut and the files after the cut are
// listed. Mode: at most --lines changed lines and no risk hit → in_context,
// otherwise children. Rules: the repository instruction chain — the agent entry
// files and the engineering rule directory whole, then routes (path plus the
// line naming it) to the documents those entries name — or, with no entry file,
// the documentation paths to route reads by. In children mode a
// second `-lens` pack is written beside the first, the same context without the
// environment snapshot, for the lens children.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packetProblems } from "../../../contracts/validate-assignment.mjs";

const DEFAULTS = Object.freeze({ budget: 150000, lines: 100 });
const DIFF_WIDTHS = [10, 6, 3, 0];
const RULES_RESERVE = 20000;
const DIFF_FLOOR_SHARE = 0.4;
const RISK_HIT_CAP = 40;
const DOCS_LIST_CAP = 150;
const SHORT_ISSUE_CHARS = 300;
// The instruction chain a repository publishes: the agent entry files and the
// engineering rule directory go in whole, and the documents those entries name
// go in as routes — path plus the line that names it. A route costs one line
// where the document costs its whole length in every context that holds the
// pack, and only the lens that needs it pays the read.
const RULES_ENTRIES = ["AGENTS.md", "CLAUDE.md", "docs/engineering/README.md"];
const RULES_DIR = "docs/engineering/rules";
const RULES_ROUTE_CAP = 40;
const ROUTE_HINT_CHARS = 160;
const LENS_NOTE = "This pack is your whole review context: settle every doubt by reading the code it names, and collect no environment snapshot, rules or diff of your own — the environment and its checks belong to the parent review.";
// A markdown link or bare path naming a document of this repository; a URL, an
// absolute path or a traversal is not one.
const DOC_LINK = /(?:^|[\s(<"'`[])([A-Za-z0-9._][A-Za-z0-9._/-]*\.md)\b/g;
const METHOD_REFERENCE = ["..", "..", "..", "references", "engineering-evidence.md"];
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
--lines <n> (in_context threshold, 100), --out <path> (pack file, default beside
the packet file, or under the OS temp dir for stdin), --skip=<sections> (passed
to env-snapshot), --check (wrapper
pre-launch gate: strict packet validation, base and diff resolution, nothing
written), --usage.
Requires repository.base_ref (or --base) and a source_materials entry named
issue carrying the task text inline (kind text) or as a file path the wrapper
wrote (kind attachment_reference); a subtask also carries name parent_issue.
Pack sections, in order: attention (cuts and notes), signals, scope, decisions
(only when the packet carries any), issue, parent_issue, materials, repository,
development_result and previous_review (the Result files those materials name,
whole), method (the shared engineering reference), rules (the repository
instruction chain: the entry files and the rule directory whole, then routes to
the documents they name), env, files, diff. In children mode a second pack, named -lens beside the first,
carries the same context without env, for the lens children.
Output: one JSON line {ok, pack, lens_pack (children mode), base, head, files,
changed_lines, test_files, risk_hits[{path,line,match}], mode
children|in_context, diff_context, truncations[], warnings[], pack_chars};
--check returns {ok, check, base, head, files, changed_lines, test_files,
risk_hits, mode, issue_chars, warnings}.
ok:false codes: bad_args | bad_packet (--check; detail lists the problems) |
missing_base_ref | missing_issue | not_a_git_repository | base_ref_not_found |
empty_diff | pack_write_failed. Exit 1 on ok:false.
`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, detail) {
  out(detail ? { ok: false, code, detail } : { ok: false, code });
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { assignment: null, base: null, budget: DEFAULTS.budget, lines: DEFAULTS.lines, out: null, skip: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (arg === "--usage") return { usage: true };
    if (arg === "--assignment") opts.assignment = next();
    else if (arg === "--base") opts.base = next();
    else if (arg === "--budget") opts.budget = Number(next());
    else if (arg === "--lines") opts.lines = Number(next());
    else if (arg === "--out") opts.out = next();
    else if (arg === "--check") opts.check = true;
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

function collectRules(root, cwd, budget) {
  const seen = new Set();
  const entries = [];
  for (const entry of RULES_ENTRIES) {
    if (seen.has(entry) || !existsSync(join(root, entry))) continue;
    seen.add(entry);
    entries.push({ path: entry, text: readFileSync(join(root, entry), "utf8") });
  }
  if (entries.length === 0) {
    const paths = (git(["ls-files", "docs/*.md", "docs/**/*.md"], cwd) ?? "").split("\n").filter(Boolean).slice(0, DOCS_LIST_CAP);
    return { mode: "paths", paths, routes: [], routes_cut: [], items: [], dropped: [] };
  }
  const items = [...entries];
  const dir = join(root, RULES_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
      const relative = `${RULES_DIR}/${name}`;
      if (seen.has(relative)) continue;
      seen.add(relative);
      items.push({ path: relative, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  // Routes are drawn from the entry files only, and never repeat a document the
  // pack already carries whole.
  const state = { list: [], cut: [] };
  for (const entry of entries) routes(entry.text, root, seen, state);
  const routed = state.list;
  const kept = [];
  const dropped = [];
  // Routes come first: when the budget is tight, knowing where a rule lives
  // beats holding one rule and losing the map to the rest.
  let used = routed.reduce((total, route) => total + route.length + 3, 0);
  for (const item of items) {
    const size = item.path.length + item.text.length + 8;
    if (used + size <= budget) { kept.push(item); used += size; } else dropped.push(item.path);
  }
  return { mode: "content", paths: [], routes: routed, routes_cut: state.cut, items: kept, dropped };
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
  // The developer's Result and the previous review arrive as files too; their
  // JSON goes into the pack whole, claims for the lenses to reconcile.
  const developmentResult = material(assignment, "development_result");
  const previousReview = material(assignment, "previous_review");

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
      ok: true, check: true, base, head, files: files.length, changed_lines: lines, test_files: testFiles, risk_hits: hits, mode, issue_chars: issueChars, warnings,
    });
    return;
  }

  const truncations = [];
  const fixed = [];
  fixed.push(section("signals", [
    `files: ${files.length}`,
    `changed_lines: ${lines}`,
    `test_files: ${testFiles}`,
    `mode: ${mode}`,
    hits.length ? `risk_hits:\n${bullets(hits.map((hit) => `${hit.path}${hit.line ? `:${hit.line}` : ""} — ${hit.match}`))}` : "risk_hits: none",
  ].join("\n")));

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
  const taken = new Set(["issue", "parent_issue", "development_result", "previous_review"]);
  const others = assignment.source_materials.filter((item) => !(isPlainObject(item) && taken.has(item.name)));
  if (others.length) fixed.push(section("materials", renderMaterials(others)));
  fixed.push(section("repository", JSON.stringify(repository, null, 1)));
  if (developmentResult && isText(developmentResult.text)) {
    fixed.push(section("development_result", developmentResult.text.trimEnd(), developmentResult.path ? { file: developmentResult.path } : {}));
  }
  if (previousReview && isText(previousReview.text)) {
    fixed.push(section("previous_review", previousReview.text.trimEnd(), previousReview.path ? { file: previousReview.path } : {}));
  }
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
    section("diff", diff.text, { context: diff.context }),
    "</review_pack>",
  ].join("\n\n");
  const pack = build([], [envText]);
  // The lenses judge the change, not the runtime: their pack carries the whole
  // review context without the environment snapshot the parent's checks need.
  const lensPack = mode === "children" ? build([LENS_NOTE], []) : null;

  const packName = `review-pack-${assignment.assignment_id.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
  const packDir = opts.assignment === "-" ? tmpdir() : dirname(resolve(opts.assignment));
  const target = opts.out ? resolve(opts.out) : join(packDir, packName);
  const lensTarget = lensPack ? (target.endsWith(".md") ? `${target.slice(0, -3)}-lens.md` : `${target}-lens`) : null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${pack}\n`);
    if (lensPack) writeFileSync(lensTarget, `${lensPack}\n`);
  } catch (error) {
    fail("pack_write_failed", String(error.message));
  }

  out({
    ok: true,
    pack: target,
    ...(lensTarget ? { lens_pack: lensTarget } : {}),
    base,
    head,
    files: files.length,
    changed_lines: lines,
    test_files: testFiles,
    risk_hits: hits,
    mode,
    diff_context: diff.context,
    truncations,
    warnings,
    pack_chars: pack.length,
  });
}

main();
