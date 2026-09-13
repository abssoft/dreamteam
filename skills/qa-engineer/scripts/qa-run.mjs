#!/usr/bin/env node
// QA run for the qa-engineer role: the mechanical half of the project's gate,
// in three calls. `--plan` reads the change and the repository, derives the
// checks it can run at the width of the diff and writes a plan the role reads
// plus a ready spec; `--run` applies the role's decisions (the executor the
// rules declare, commands the rules add, items to drop), proves the executor
// sees this workspace and starts the sibling checks-run.mjs detached;
// `--report` waits for the results, attributes every failure to the change or
// outside it and writes the QA result file the wrapper hands to the reviewer.
// Read-only towards the repository, zero dependencies.
//
//   --plan --base <ref> [--out <dir>] [--id <slug>] [--skip=rules]
//       → {ok, plan, spec, base, head, merge_base, files, checks,
//          not_runnable: [{command, reason}], rules_routes}
//   --run --spec <path> [--exec <prefix>] [--add <command>]… [--drop <id,id>]
//         [--timeout-ms <n>]
//       → {ok, results, executor: {status: host|ok|mismatch|failed, detail?},
//          checks, pid?}
//   --report --results <path> [--baseline <id>=<evidence>]… [--timeout <s>]
//         [--out <path>]
//       → {ok, result, verdict: green|red|unconfirmed, passed, failed,
//          broken, skipped}; {ok: false, code: running} while the runner
//          is still at work — call again
//   --usage
// Plan: <qa_plan> with attention, workspace, files, checks (every derived
//   item with its id, width and source; the ones the change gives no path of
//   the tool's language, or that would rewrite files, are listed as not
//   runnable with the reason), rules (the repository instruction chain: entry
//   files whole, then routes to the documents they name — the gate's commands,
//   executor and worktree caveats live there).
// Spec: {cwd, results, exec, base, head, merge_base, changed_paths,
//   checks: [{id, tool, command, run?, scope, width, source}]} — what
//   checks-run.mjs executes; `exec` is the executor prefix ending in `sh -c`.
// Result: {kind: qa_result, generated_at, workspace: {base, head, merge_base,
//   changed_paths}, executor, verdict, checks: [{id, tool, command, ran,
//   scope, width, source, status: passed|failed|broken|skipped, reason?,
//   attribution?: in_change|outside_change|unknown|baseline, exit, seconds,
//   log, tail}], obstacles: [text], summary: {passed, failed, broken,
//   skipped}}. verdict: red when any item failed; unconfirmed when none
//   failed and any is broken; green otherwise.
// ok:false codes: bad_args | not_a_git_repository | base_ref_not_found |
//   empty_diff | bad_spec | not_a_command (detail: the offending commands) |
//   running | results_missing | write_failed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectRules, parseNameStatus, TEST_PATH } from "../../code-reviewer/scripts/review-pack.mjs";
import { shellArg, waitResults } from "./checks-run.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const RULES_BUDGET = 120000;
const CHECK_PATH_CAP = 40;
const WAIT_SECONDS = 540;
const RESULT_TAIL_CHARS = 1500;
// Files a tool of this language reads; a path outside the set is not that
// tool's evidence, and a run over it is a green that says nothing.
const LANG_EXT = {
  node: /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i,
  php: /\.php$/i,
  css: /\.(?:css|scss|sass|less|vue|svelte)$/i,
  any: /./,
};
const TOOL_LANG = { stylelint: "css", prettier: "any" };
// A command that rewrites the tree is never a check.
const MUTATING = /(?:^|\s)--(?:fix|write|generate-baseline|prune-suppressions|update-snapshots?)\b|(?:^|\s)-[uw](?:\s|$)|\brector\s+process\b(?![^|&;]*--dry-run)|\bphp-cs-fixer\s+fix\b(?![^|&;]*--dry-run)|\bpint\b(?![^|&;]*--test)/;
// Prose or a placeholder where a command was due.
const NOT_A_COMMAND = /[Ѐ-ӿ]|\{[a-z ]+\}|^\s*$/;
// A path-shaped token in tool output: at least one directory and an extension.
const OUTPUT_PATH = /(?:^|[\s:"'(\[=])((?:\.{0,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.[A-Za-z0-9]{1,5})(?=[\s:"')\],]|$)/g;

const USAGE = `qa-run.mjs — the mechanical half of the gate, for the qa-engineer role.
  node qa-run.mjs --plan --base <ref> [--out <dir>] [--id <slug>] [--skip=rules]
      derive the checks at the width of the diff, write the plan and the spec
  node qa-run.mjs --run --spec <path> [--exec <prefix>] [--add <command>]… [--drop <ids>] [--timeout-ms <n>]
      apply the executor and the rules' commands, prove the executor sees this
      workspace, start checks-run.mjs detached
  node qa-run.mjs --report --results <path> [--baseline <id>=<evidence>]… [--timeout <s>] [--out <path>]
      wait for the runner, attribute failures, write the QA result file
Plan: <qa_plan> with attention, workspace, files, checks, rules. Spec: {cwd, results,
exec, base, head, merge_base, changed_paths, checks[]}. Result: {kind: qa_result, workspace,
executor, verdict green|red|unconfirmed, checks[{id, tool, command, ran, width, source,
status passed|failed|broken|skipped, reason?, attribution?, exit, seconds, log, tail}],
obstacles[], summary}. ok:false codes: bad_args | not_a_git_repository | base_ref_not_found |
empty_diff | bad_spec | not_a_command | running | results_missing | write_failed.
`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, detail) {
  out(detail ? { ok: false, code, detail } : { ok: false, code });
  process.exit(1);
}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bullets = (items) => items.map((item) => `- ${item}`).join("\n");
const quotePath = (path) => (/[\s]|^-/.test(path) ? `'${path}'` : path);

function section(name, body, attrs = {}) {
  const head = Object.entries(attrs).map(([key, value]) => ` ${key}="${String(value).replace(/"/g, "&quot;")}"`).join("");
  const safe = String(body).replaceAll(`</${name}>`, `&lt;/${name}&gt;`);
  return `<${name}${head}>\n${safe}\n</${name}>`;
}

function parseArgs(argv) {
  const opts = { mode: null, base: null, out: null, id: null, skip: null, spec: null, exec: null, add: [], drop: [], timeoutMs: null, results: null, baseline: [], timeout: WAIT_SECONDS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (arg === "--usage") return { usage: true };
    if (arg === "--plan" || arg === "--run" || arg === "--report") opts.mode = arg.slice(2);
    else if (arg === "--base") opts.base = next();
    else if (arg === "--out") opts.out = next();
    else if (arg === "--id") opts.id = next();
    else if (arg.startsWith("--skip=")) opts.skip = arg;
    else if (arg === "--spec") opts.spec = next();
    else if (arg === "--exec") opts.exec = next();
    else if (arg === "--add") opts.add.push(next());
    else if (arg === "--drop") opts.drop.push(...String(next() ?? "").split(",").map((id) => id.trim()).filter(Boolean));
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (arg === "--results") opts.results = next();
    else if (arg === "--baseline") opts.baseline.push(next());
    else if (arg === "--timeout") opts.timeout = Number(next());
    else return { error: `unknown argument ${arg}` };
  }
  if (!opts.mode) return { error: "one of --plan, --run, --report is required" };
  if (opts.mode === "plan" && !isText(opts.base)) return { error: "--plan needs --base <ref>" };
  if (opts.mode === "run" && !isText(opts.spec)) return { error: "--run needs --spec <path>" };
  if (opts.mode === "report" && !isText(opts.results)) return { error: "--report needs --results <path>" };
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) return { error: "--timeout must be a positive number of seconds" };
  return opts;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}

function envSnapshot(cwd, skip) {
  const script = join(scriptDir, "..", "..", "env-snapshot", "scripts", "env-snapshot.mjs");
  try {
    const text = execFileSync(process.execPath, [script, "--json", "--skip=docs", ...(skip ? [skip] : [])], {
      cwd, encoding: "utf8", timeout: 60000, maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "env-snapshot failed" };
  }
}

// The width of a check is a fact of the plan: the templates come from the
// environment snapshot, the paths from the change, filtered to the files the
// tool reads. Past the cap the list collapses to its directories, so a wide
// change still runs one narrowed command. Identical commands run once.
export function deriveChecks(env, codePaths, testPaths) {
  const checks = Array.isArray(env?.validation?.checks) ? env.validation.checks : [];
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (item.runnable) {
      if (seen.has(item.command)) return;
      seen.add(item.command);
    }
    items.push({ id: `c${items.length + 1}`, ...item });
  };
  const collapse = (paths) => {
    if (paths.length <= CHECK_PATH_CAP) return { list: paths.map(quotePath).join(" "), note: "" };
    const dirs = [...new Set(paths.map((path) => path.split("/").slice(0, -1).join("/") || "."))];
    return { list: dirs.slice(0, CHECK_PATH_CAP).map(quotePath).join(" "), note: ` (${paths.length} paths collapsed to their directories)` };
  };
  for (const check of checks) {
    if (!isPlainObject(check) || !isText(check.command)) continue;
    const lang = TOOL_LANG[check.tool] ?? check.lang ?? "any";
    const ext = LANG_EXT[lang] ?? LANG_EXT.any;
    const base = { tool: check.tool, lang, source: check.source, note: check.note ?? check.reason ?? "" };
    const runOf = isText(check.run) ? check.run : check.command;
    if (MUTATING.test(runOf)) {
      add({ ...base, command: check.command, scope: check.scope, width: "not run", runnable: false, reason: "rewrites files: not a check" });
      continue;
    }
    if (check.scope === "none") {
      add({ ...base, command: check.command, run: runOf, scope: "none", width: "full", runnable: true });
      continue;
    }
    const pool = check.scope === "tests-by-path" ? testPaths : codePaths;
    const wanted = collapse(pool.filter((path) => ext.test(path)));
    if (!wanted.list) {
      add({ ...base, command: check.command, scope: check.scope, width: "not run", runnable: false, reason: `the change carries no ${check.scope === "tests-by-path" ? "test" : "code"} path this tool reads (${lang})` });
      continue;
    }
    add({ ...base, command: check.command.replace(/\{test paths\}|\{paths\}/g, wanted.list), scope: check.scope, width: `narrowed to the change${wanted.note}`, runnable: true });
  }
  return items;
}

function changedPaths(mergeBase, cwd) {
  const files = parseNameStatus(git(["diff", "--name-status", mergeBase], cwd));
  const known = new Set(files.map((file) => file.path));
  for (const path of (git(["ls-files", "--others", "--exclude-standard"], cwd) ?? "").split("\n").filter(Boolean)) {
    if (!known.has(path)) files.push({ status: "?", path });
  }
  return files;
}

function plan(opts) {
  const cwd = process.cwd();
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) fail("not_a_git_repository");
  const base = opts.base.trim();
  const baseRef = [base, `origin/${base}`].find((candidate) => git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], cwd) !== null);
  const mergeBase = baseRef ? git(["merge-base", baseRef, "HEAD"], cwd) : null;
  if (!mergeBase) fail("base_ref_not_found", base);
  const head = git(["rev-parse", "--short", "HEAD"], cwd);
  const files = changedPaths(mergeBase, cwd);
  if (!files.length) fail("empty_diff", `no changes between ${base} and the working tree`);
  const present = files.filter((file) => file.status !== "D");
  const codePaths = present.filter((file) => !TEST_PATH.test(file.path)).map((file) => file.path);
  const testPaths = present.filter((file) => TEST_PATH.test(file.path)).map((file) => file.path);

  const env = envSnapshot(cwd, opts.skip);
  const items = deriveChecks(env, codePaths, testPaths);
  const rules = collectRules(root, cwd, RULES_BUDGET);
  const rulesText = rules.mode === "content"
    ? [
      ...rules.items.map((item) => `#### ${item.path}\n\n${item.text.trimEnd()}`),
      ...(rules.routes.length ? [`#### routed by the entry files — open the ones that name checks, tests, linters, static analysis, docker or the worktree\n\n${bullets(rules.routes)}`] : []),
    ].join("\n\n")
    : (rules.paths.length ? `No entry file; documentation paths to route reads:\n${bullets(rules.paths)}` : "No documentation in this repository.");

  const id = isText(opts.id) ? opts.id.replace(/[^A-Za-z0-9._-]+/g, "-") : `qa-${head ?? "head"}`;
  const outDir = isText(opts.out) ? resolve(opts.out) : join(tmpdir(), "dream-team", "qa");
  const planPath = join(outDir, `qa-plan-${id}.md`);
  const specPath = join(outDir, `qa-spec-${id}.json`);
  const resultsPath = join(outDir, `qa-checks-${id}-results.json`);
  const runnable = items.filter((item) => item.runnable);
  const notRunnable = items.filter((item) => !item.runnable).map(({ command, reason }) => ({ command, reason }));
  const attention = [
    `Change: merge base of ${base} and HEAD, plus the working tree. The files listed are the whole change.`,
    `Derived checks: ${runnable.length} runnable, ${notRunnable.length} not runnable (reasons in <checks>).`,
    env.ok === false ? `env-snapshot failed: derive the checks from the rules and the manifests yourself.` : null,
    rules.dropped.length ? `rules omitted for budget, read them yourself: ${rules.dropped.join(", ")}` : null,
    rules.routes_cut.length ? `rule routes past the cap, follow the entry files for them: ${rules.routes_cut.join(", ")}` : null,
    `Spec ready at ${specPath}: run it as it stands, or with --exec, --add and --drop for what the rules add or forbid.`,
  ].filter(Boolean);
  const rows = items.map((item) => `[${item.id}] ${item.command} — ${item.tool}, ${item.width}, from ${item.source}${item.runnable ? "" : `; NOT RUNNABLE: ${item.reason}`}${item.note ? `; ${item.note}` : ""}`);
  const suite = (env?.validation?.suite ?? []).filter(isText);
  const planText = [
    `<qa_plan id="${id}" base="${base}" head="${head ?? ""}">`,
    section("attention", bullets(attention)),
    section("workspace", [`cwd: ${cwd}`, `base: ${base}`, `merge_base: ${mergeBase}`, `head: ${head ?? ""}`, `php: ${env?.runtime?.php ?? "(not detected)"}`, `node: ${env?.runtime?.node ?? ""}`].join("\n")),
    section("files", bullets(files.map((file) => `${file.status} ${file.from ? `${file.from} → ` : ""}${file.path}${TEST_PATH.test(file.path) ? " (test)" : ""}`))),
    section("checks", `${bullets(rows) || "- (nothing derived)"}${suite.length ? `\n\nproject suite, full width only, when the rules call for it:\n${bullets(suite)}` : ""}`, { note: "derived from the project's own scripts at the width of the change; the rules below decide the executor and what they add or forbid" }),
    section("rules", rulesText),
    "</qa_plan>",
  ].join("\n\n");
  const spec = {
    cwd, results: resultsPath, exec: null, base, head, merge_base: mergeBase,
    changed_paths: files.map((file) => file.path),
    checks: runnable.map(({ id: checkId, tool, command, run, scope, width, source }) => ({ id: checkId, tool, command, ...(run && run !== command ? { run } : {}), scope, width, source })),
  };
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(planPath, `${planText}\n`);
    writeJson(specPath, spec);
  } catch (error) {
    fail("write_failed", String(error.message));
  }
  out({ ok: true, plan: planPath, spec: specPath, base, head, merge_base: mergeBase, files: files.length, checks: runnable.length, not_runnable: notRunnable, rules_routes: rules.routes.length });
}

// The executor must see this workspace, not another checkout of the same
// repository: every changed file read through it must be byte-equal to the
// host's. `failed` when nothing could be read at all (the executor did not
// start), `mismatch` when it reads but a file differs or is missing there.
const PROBE_CAP = 8;
function probeExecutor(exec, spec) {
  const candidates = spec.changed_paths.filter((path) => existsSync(join(spec.cwd, path))).slice(0, PROBE_CAP);
  if (!candidates.length) return { status: "ok", detail: "no changed file to compare; executor not proven" };
  let readable = 0;
  let anomaly = null;
  let lastError = "";
  for (const candidate of candidates) {
    const probe = spawnSync("/bin/sh", ["-c", `${exec} ${shellArg(`cat ${quotePath(candidate)}`)}`], { cwd: spec.cwd, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (probe.error || probe.status !== 0) {
      lastError = String(probe.stderr ?? probe.error?.message ?? "").trim().split("\n").slice(-3).join(" ") || `exit ${probe.status}`;
      anomaly ??= `${candidate} cannot be read through the executor (${lastError})`;
      continue;
    }
    readable += 1;
    if (!Buffer.from(probe.stdout).equals(readFileSync(join(spec.cwd, candidate)))) anomaly ??= `${candidate} differs between the host and the executor`;
  }
  if (!readable) return { status: "failed", detail: `executor did not start or reads nothing: ${lastError}` };
  if (anomaly) return { status: "mismatch", detail: `${anomaly}: the executor sees another checkout, not this workspace` };
  return { status: "ok", detail: `${candidates.length} changed file(s) byte-equal through the executor` };
}

function run(opts) {
  const specPath = resolve(opts.spec);
  let spec;
  try { spec = readJson(specPath); } catch (error) { fail("bad_spec", String(error.message)); }
  if (!isText(spec.cwd) || !Array.isArray(spec.checks) || !Array.isArray(spec.changed_paths)) fail("bad_spec", "spec needs cwd, changed_paths and checks[] — write it with --plan");
  const bad = opts.add.filter((command) => !isText(command) || NOT_A_COMMAND.test(command) || MUTATING.test(command));
  if (bad.length) fail("not_a_command", bad.map((command) => `${JSON.stringify(command)}: prose, a placeholder, or a command that rewrites files`));
  if (opts.drop.length) spec.checks = spec.checks.filter((check) => !opts.drop.includes(check.id));
  for (const command of opts.add) {
    if (spec.checks.some((check) => check.command === command)) continue;
    spec.checks.push({ id: `r${spec.checks.filter((check) => /^r\d+$/.test(check.id)).length + 1}`, tool: "rules", command, scope: "none", width: "as the rules state", source: "repository rules" });
  }
  if (isText(opts.exec)) spec.exec = opts.exec.trim();
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) spec.timeout_ms = opts.timeoutMs;
  const resultsPath = resolve(dirname(specPath), spec.results ?? `${specPath.replace(/\.json$/, "")}-results.json`);
  spec.results = resultsPath;
  const executor = isText(spec.exec) ? probeExecutor(spec.exec, spec) : { status: "host" };
  spec.executor = executor;
  try { writeJson(specPath, spec); } catch (error) { fail("write_failed", String(error.message)); }
  if (executor.status === "mismatch" || executor.status === "failed") {
    const stamp = new Date().toISOString();
    writeJson(resultsPath, {
      ok: true, status: "complete", cwd: spec.cwd, exec: spec.exec, pid: null, started: stamp, updated: stamp,
      checks: spec.checks.map((check) => ({ id: check.id, tool: check.tool ?? null, command: check.command, ran: null, scope: check.scope ?? null, width: check.width ?? null, source: check.source ?? null, status: "broken", reason: `executor: ${executor.detail}`, exit: null, seconds: 0, log: null, tail: "" })),
    });
    out({ ok: true, results: resultsPath, executor, checks: spec.checks.length });
    return;
  }
  if (!spec.checks.length) {
    const stamp = new Date().toISOString();
    writeJson(resultsPath, { ok: true, status: "complete", cwd: spec.cwd, exec: spec.exec ?? null, pid: null, started: stamp, updated: stamp, checks: [] });
    out({ ok: true, results: resultsPath, executor, checks: 0 });
    return;
  }
  const line = spawnSync(process.execPath, [join(scriptDir, "checks-run.mjs"), "--spec", specPath, "--detach"], { cwd: spec.cwd, encoding: "utf8", timeout: 30000 });
  let started = null;
  try { started = JSON.parse(String(line.stdout).trim().split("\n").pop()); } catch { /* falls through */ }
  if (!started?.ok) fail("bad_spec", `checks-run did not start: ${started?.code ?? String(line.stderr ?? "").trim()}`);
  out({ ok: true, results: resultsPath, executor, checks: spec.checks.length, pid: started.pid });
}

// A failure names the change when its output names a changed path, or when the
// check ran only over changed paths; a full-width failure naming only other
// paths is outside the change on the face of it — the role settles which.
export function attribute(item, changedPaths) {
  if (item.status !== "failed") return null;
  if (/^narrowed/.test(item.width ?? "")) return "in_change";
  const named = new Set();
  for (const match of String(item.tail ?? "").matchAll(OUTPUT_PATH)) named.add(match[1].replace(/^\.\//, ""));
  if (!named.size) return "unknown";
  for (const path of named) {
    if (changedPaths.some((changed) => path === changed || path.endsWith(`/${changed}`))) return "in_change";
  }
  return "outside_change";
}

async function report(opts) {
  const resultsPath = resolve(opts.results);
  const results = await waitResults(resultsPath, opts.timeout);
  if (!results || results.code === "results_missing") fail("results_missing", resultsPath);
  if (results.status !== "complete" && results.status !== "aborted") fail("running", resultsPath);
  const specPath = resultsPath.replace(/-results\.json$/, ".json").replace(/qa-checks-/, "qa-spec-");
  let spec = {};
  try { spec = readJson(specPath); } catch { spec = {}; }
  const changed = Array.isArray(spec.changed_paths) ? spec.changed_paths : [];
  const baseline = new Map();
  for (const entry of opts.baseline) {
    const at = String(entry).indexOf("=");
    if (at < 1) fail("bad_args", `--baseline expects <id>=<evidence>, got ${JSON.stringify(entry)}`);
    baseline.set(entry.slice(0, at).trim(), entry.slice(at + 1).trim());
  }
  const checks = results.checks.map((item) => {
    const row = { id: item.id, tool: item.tool, command: item.command, ran: item.ran, scope: item.scope, width: item.width, source: item.source, status: item.status, exit: item.exit, seconds: item.seconds, log: item.log, tail: String(item.tail ?? "").slice(-RESULT_TAIL_CHARS) };
    if (item.reason) row.reason = item.reason;
    if (item.status === "pending") { row.status = "broken"; row.reason = "runner ended before this check"; }
    const attribution = attribute(row, changed);
    if (attribution) row.attribution = attribution;
    if (baseline.has(row.id)) {
      if (row.status !== "failed") fail("bad_args", `--baseline ${row.id}: the item is ${row.status}, only a failed item can be baseline`);
      row.status = "broken";
      row.attribution = "baseline";
      row.reason = `baseline: ${baseline.get(row.id)}`;
    }
    return row;
  });
  const count = (status) => checks.filter((item) => item.status === status).length;
  const summary = { passed: count("passed"), failed: count("failed"), broken: count("broken"), skipped: count("skipped") };
  const verdict = summary.failed ? "red" : summary.broken ? "unconfirmed" : "green";
  const obstacles = [...new Set(checks.filter((item) => item.status === "broken").map((item) => `${item.id}: ${item.reason ?? "did not run"}`))];
  const id = basename(resultsPath).replace(/^qa-checks-/, "").replace(/-results\.json$/, "");
  const target = isText(opts.out) ? resolve(opts.out) : join(dirname(resultsPath), `qa-result-${id}.json`);
  const result = {
    kind: "qa_result", generated_at: new Date().toISOString(),
    workspace: { base: spec.base ?? null, head: spec.head ?? null, merge_base: spec.merge_base ?? null, changed_paths: changed },
    executor: spec.executor ?? { status: results.exec ? "ok" : "host" }, verdict, checks, obstacles, summary,
  };
  try { writeJson(target, result); } catch (error) { fail("write_failed", String(error.message)); }
  out({ ok: true, result: target, verdict, ...summary });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.usage) { process.stdout.write(USAGE); return; }
  if (opts.error) fail("bad_args", opts.error);
  if (opts.mode === "plan") plan(opts);
  else if (opts.mode === "run") run(opts);
  else await report(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
