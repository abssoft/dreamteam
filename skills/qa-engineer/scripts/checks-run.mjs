#!/usr/bin/env node
// Check runner for the qa-engineer role: executes the gate's check commands
// outside the model's turns, so a static analysis or a test suite costs
// machine time and no context. qa-run.mjs writes the spec and starts this
// script detached; qa-run.mjs --report reads the results once complete.
// Zero dependencies.
//
// Modes:
//   --spec <path>            run the spec's checks in order, writing the results
//                            file after every check (a rerun skips the checks
//                            already settled, so a cut run resumes)
//   --spec <path> --detach   start that run as a detached process, return at once
//   --wait <results path>    block until the results file is complete or
//                            --timeout seconds pass (default 540), print it
//   --usage                  print this contract as prose
// Spec: {cwd, results, exec?, timeout_ms?, checks: [{id, tool, command, run?,
//        scope, width, source}]} — `command` is what the plan shows, `run`
//        (default command) what the shell executes. `exec` is the executor the
//        repository rules declare (`docker compose exec -T php sh -c`,
//        `docker run --rm -v "$PWD":/app -w /app <image> sh -c`, …): every
//        check then runs as `<exec> '<run>'`; without it the command runs on
//        the host in cwd. On the host, phpstan runs through a wrapper
//        configuration that includes the project's own and pins tmpDir to a
//        per-workspace directory under the OS temp dir, so the result cache
//        stays warm between runs and no other checkout evicts it; a project
//        whose configuration sets tmpDir itself, or a run under `exec`, keeps
//        the project's cache as it is.
// Results: {ok, status: running|complete|aborted, cwd, exec, pid, started,
//        updated, current?, checks: [{id, tool, command, ran, scope, width,
//        source, status: pending|passed|failed|broken, reason?, exit, seconds,
//        log, tail, cache?}]}. passed: exit 0. failed: non-zero exit. broken:
//        the command could not run — spawn error, timeout, or a tooling
//        signature in its output (command or module not found, autoload
//        missing, an executor that did not start).
// Output: one JSON line; --spec prints the final results, --detach prints
//        {ok, results, pid, checks}, --wait prints the results file as it stands.
//        Exit 1 only on bad arguments or an unreadable spec.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const WAIT_SECONDS = 540;
const POLL_MS = 2000;
const TAIL_CHARS = 4000;
const PHPSTAN_CONFIGS = ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"];
// Output that says the tool did not run, as opposed to the code being wrong.
const TOOLING = /command not found|No such file or directory|Could not open input file|Cannot find module|Class .* not found|vendor\/autoload\.php|not recognized as|ENOENT|npm ERR! (?:code E404|missing script)|docker: |Cannot connect to the Docker daemon|service ".*" is not running|no such service|OCI runtime exec failed|executable file not found/i;

const USAGE = `checks-run.mjs — executes the gate's checks outside the model's turns.
  node checks-run.mjs --spec <path>            run in order, results beside the spec
  node checks-run.mjs --spec <path> --detach   start detached, return {ok, results, pid, checks}
  node checks-run.mjs --wait <results> [--timeout <seconds>]
                                              block until complete (default 540 s), print the results
Spec: {cwd, results, exec?, timeout_ms?, checks: [{id, tool, command, run?, scope, width, source}]}.
exec — the executor the repository rules declare (a docker compose exec / docker run prefix
ending in sh -c); each check runs as <exec> '<run>'. Without it: the host, in cwd.
Results: {ok, status running|complete|aborted, cwd, exec, pid, started, updated, current?,
checks: [{id, tool, command, ran, scope, width, source, status pending|passed|failed|broken,
reason?, exit, seconds, log, tail, cache?}]}. passed = exit 0; failed = non-zero exit;
broken = could not run (spawn error, timeout, tooling signature in the output).
On the host, phpstan runs through a wrapper configuration that includes the project's own
and pins tmpDir per workspace under the OS temp dir unless the project sets tmpDir itself.`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, detail) {
  out({ ok: false, code, ...(detail ? { detail } : {}) });
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { spec: null, detach: false, wait: null, timeout: WAIT_SECONDS, usage: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--usage") opts.usage = true;
    else if (arg === "--detach") opts.detach = true;
    else if (arg === "--spec") opts.spec = argv[++i];
    else if (arg === "--wait") opts.wait = argv[++i];
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]);
    else if (arg.startsWith("--timeout=")) opts.timeout = Number(arg.slice(10));
    else return { error: `unknown argument: ${arg}` };
  }
  if (opts.usage) return opts;
  if (!opts.spec && !opts.wait) return { error: "--spec <path> or --wait <results path> is required" };
  if (opts.spec && opts.wait) return { error: "--spec and --wait are exclusive" };
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) return { error: "--timeout must be a positive number of seconds" };
  return opts;
}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const tokenize = (text) => text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
const unquote = (token) => token.replace(/^["']|["']$/g, "");
const quote = (path) => (/[\s'"$`\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path);
// The whole command as one single-quoted argument to the executor's `sh -c`.
export const shellArg = (command) => `'${command.replace(/'/g, "'\\''")}'`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  // rename is atomic on one file system, so --wait never reads a half file.
  renameSync(tmp, path);
}

// The plan shows the command as the project defines it; on the host phpstan
// executes through a wrapper that keeps the project's configuration whole and
// adds only tmpDir. Its result cache is keyed by absolute paths and, by
// default, lives in one file under the OS temp dir shared by every checkout on
// the machine — so a fresh worktree starts cold and any other run evicts it. A
// directory per workspace keeps the second and later runs in the same worktree
// warm. A project that pins tmpDir itself already has that, and under an
// executor a host path means nothing: both keep the project's configuration.
function phpstanCommand(check, cwd, dir) {
  const tokens = tokenize(check.run ?? check.command);
  const kept = [];
  let config = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = unquote(tokens[i]);
    if (token === "-c" || token === "--configuration") { config = unquote(tokens[i + 1] ?? ""); i += 1; continue; }
    if (token.startsWith("--configuration=")) { config = token.slice("--configuration=".length); continue; }
    if (/^-c[^-]/.test(token)) { config = token.slice(2); continue; }
    kept.push(tokens[i]);
  }
  const configPath = config ? resolve(cwd, config) : PHPSTAN_CONFIGS.map((name) => join(cwd, name)).find((path) => existsSync(path));
  if (!configPath || !existsSync(configPath)) return null;
  if (/^\s*tmpDir\s*:/m.test(readFileSync(configPath, "utf8"))) return null;
  const cache = join(tmpdir(), "dream-team", "phpstan", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
  const wrapper = join(dir, `phpstan-${check.id}.neon`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(wrapper, `includes:\n    - ${configPath}\nparameters:\n    tmpDir: ${cache}\n`);
  return { ran: `${kept.join(" ")} -c ${quote(wrapper)}`, cache };
}

function classify(exit, signal, tail, timedOut) {
  if (timedOut) return { status: "broken", reason: "timeout" };
  if (signal) return { status: "broken", reason: `killed by ${signal}` };
  if (exit === 0) return { status: "passed" };
  if (exit === 127 || TOOLING.test(tail)) return { status: "broken", reason: "tooling: the command did not run, see the log" };
  return { status: "failed" };
}

function runOne(command, cwd, timeoutMs, logPath) {
  return new Promise((settle) => {
    const started = Date.now();
    const fd = openSync(logPath, "w");
    let tail = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      closeSync(fd);
      settle({ status: "broken", reason: `spawn: ${error.message}`, exit: null, seconds: 0, tail: "" });
      return;
    }
    const absorb = (chunk) => {
      writeSync(fd, chunk);
      tail = (tail + chunk.toString()).slice(-TAIL_CHARS * 2);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      closeSync(fd);
      settle({ status: "broken", reason: `spawn: ${error.message}`, exit: null, seconds: 0, tail: "" });
    });
    child.on("close", (exit, signal) => {
      clearTimeout(timer);
      closeSync(fd);
      const trimmed = tail.slice(-TAIL_CHARS);
      settle({ ...classify(exit, signal, trimmed, timedOut), exit, seconds: Math.round((Date.now() - started) / 100) / 10, tail: trimmed });
    });
  });
}

function pending(spec) {
  return spec.checks.map((check) => ({
    id: check.id, tool: check.tool ?? null, command: check.command, ran: null, scope: check.scope ?? null,
    width: check.width ?? null, source: check.source ?? null, status: "pending", exit: null, seconds: null, log: null, tail: null,
  }));
}

async function runSpec(specPath) {
  let spec;
  try { spec = readJson(specPath); } catch (error) { fail("bad_spec", String(error.message)); }
  if (!Array.isArray(spec.checks) || !isText(spec.cwd)) fail("bad_spec", "spec needs cwd and checks[]");
  const exec = isText(spec.exec) ? spec.exec.trim() : null;
  const resultsPath = resolve(dirname(specPath), spec.results ?? `${specPath.replace(/\.json$/, "")}-results.json`);
  const dir = dirname(resultsPath);
  const logDir = join(dir, `checks-${createHash("sha1").update(resultsPath).digest("hex").slice(0, 8)}-logs`);
  mkdirSync(logDir, { recursive: true });
  const previous = existsSync(resultsPath) ? (() => { try { return readJson(resultsPath); } catch { return null; } })() : null;
  const settled = new Map((previous?.checks ?? []).filter((item) => item.status !== "pending" && !/^runner exited/.test(item.reason ?? "")).map((item) => [item.id, item]));
  const results = {
    ok: true, status: "running", cwd: spec.cwd, exec, pid: process.pid, started: previous?.started ?? new Date().toISOString(), updated: new Date().toISOString(),
    checks: pending(spec).map((item) => settled.get(item.id) ?? item),
  };
  const save = () => { results.updated = new Date().toISOString(); writeJson(resultsPath, results); };
  save();
  for (const item of results.checks) {
    if (item.status !== "pending") continue;
    const check = spec.checks.find((entry) => entry.id === item.id);
    let command = check.run ?? check.command;
    if (check.tool === "phpstan" && !exec) {
      const wrapped = phpstanCommand(check, spec.cwd, dir);
      if (wrapped) { command = wrapped.ran; item.cache = wrapped.cache; }
    }
    if (exec) command = `${exec} ${shellArg(command)}`;
    item.ran = command;
    item.log = join(logDir, `${item.id}.log`);
    results.current = item.id;
    save();
    Object.assign(item, await runOne(command, spec.cwd, spec.timeout_ms ?? DEFAULT_TIMEOUT_MS, item.log));
    delete results.current;
    save();
  }
  results.status = "complete";
  save();
  return results;
}

function detach(specPath) {
  let spec;
  try { spec = readJson(specPath); } catch (error) { fail("bad_spec", String(error.message)); }
  const resultsPath = resolve(dirname(specPath), spec.results ?? `${specPath.replace(/\.json$/, "")}-results.json`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--spec", specPath], { detached: true, stdio: "ignore" });
  child.unref();
  writeJson(resultsPath, { ok: true, status: "running", cwd: spec.cwd, exec: isText(spec.exec) ? spec.exec.trim() : null, pid: child.pid, started: new Date().toISOString(), updated: new Date().toISOString(), checks: pending(spec) });
  out({ ok: true, results: resultsPath, pid: child.pid, checks: spec.checks.length });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Reads the results file as it stands; a runner the sandbox or the OS killed
// leaves it `running` forever, so a dead pid settles the rest as broken.
export function settleResults(path) {
  let results = null;
  try { results = readJson(path); } catch { return null; }
  if (results?.status === "running" && typeof results.pid === "number" && !alive(results.pid)) {
    results.status = "aborted";
    for (const item of results.checks) {
      if (item.status === "pending" || item.id === results.current) Object.assign(item, { status: "broken", reason: "runner exited before this check settled; rerun with --spec to resume" });
    }
    writeJson(path, results);
  }
  return results;
}

export async function waitResults(resultsPath, timeoutSeconds) {
  const path = resolve(resultsPath);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const results = settleResults(path);
    if (results?.status === "complete" || results?.status === "aborted") return results;
    if (Date.now() >= deadline) return results ?? { ok: false, code: "results_missing", results: path };
    await new Promise((tick) => setTimeout(tick, POLL_MS));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) fail("bad_args", opts.error);
  if (opts.usage) { process.stdout.write(`${USAGE}\n`); return; }
  if (opts.wait) { out(await waitResults(opts.wait, opts.timeout)); return; }
  const specPath = resolve(opts.spec);
  if (opts.detach) { detach(specPath); return; }
  out(await runSpec(specPath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
