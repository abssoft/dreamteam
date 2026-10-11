// Project profile (`dreamteam.json`, in git — validated by the Profile v1
// contract, contracts/validate-profile.mjs) and machine settings
// (`.dreamteam/local.json`, outside git) plus the stage primitives shared by
// prepare-worktree.mjs and stage.mjs: substitutions, command execution with
// logs, port probes and allocation, own-process detection. Not a CLI.
// Both files are read from the primary checkout — the first entry of
// `git worktree list` — whatever checkout the caller runs in.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { localChecksProblems, normalizeProfile, profileProblems } from "../../../../contracts/validate-profile.mjs";

export const PROFILE_FILE = "dreamteam.json";
export const LOCAL_DIR = ".dreamteam";
export const LOCAL_FILE = join(LOCAL_DIR, "local.json");
export const SETUP_LOG = join(LOCAL_DIR, "setup.log");
export const STAGE_LOG = join(LOCAL_DIR, "stage.log");
export const MAIN_STAGE = "main";
export const BIND_HOST = "127.0.0.1";
export const LOCAL_TEMPLATE = '{ "host": "<имя машины в tailnet или пустая строка>", "ports": "3100-3199", "limit": 5, "cleanup": [] }';

export function git(cwd, args) {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    return { ok: false, status: error.status ?? null, stdout: (error.stdout ?? "").toString().trim(), stderr: (error.stderr ?? "").toString().trim() };
  }
}

// Every checkout of the repository, primary first: {path, branch|null}.
export function listCheckouts(repo) {
  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return [];
  return listed.stdout.split("\n\n").flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) return [];
    return [{ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null }];
  });
}

const isCommand = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The key a Russian validator message names: "dreamteam.json: <key> …".
const problemKey = (message) => message.match(/^dreamteam\.json: (?:неизвестный ключ |ключ )?([A-Za-z0-9_.[\]]+)/)?.[1] ?? PROFILE_FILE;

// {present, profile: normalized Profile v1 | null, error: {code, key, detail} | null}
export function loadProfile(primary) {
  const path = join(primary, PROFILE_FILE);
  if (!existsSync(path)) return { present: false, profile: null, error: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { present: true, profile: null, error: { code: "profile_invalid", key: PROFILE_FILE, detail: [`${PROFILE_FILE}: не читается как JSON`] } };
  }
  const problems = profileProblems(raw);
  if (problems.length) return { present: true, profile: null, error: { code: "profile_invalid", key: problemKey(problems[0]), detail: problems } };
  // `checks` of the machine settings replaces the committed list for this machine.
  const local = readTreeLocal(primary);
  if (local?.checks !== undefined) {
    const overridden = localChecksProblems(local);
    if (overridden.length) return { present: true, profile: null, error: { code: "local_config_invalid", key: "checks", path: join(primary, LOCAL_FILE), detail: overridden } };
    raw = { ...raw, checks: local.checks };
  }
  return { present: true, profile: normalizeProfile(raw), error: null };
}

// Machine settings from the primary checkout. With a stage block, host, ports
// and limit are required; `cleanup` is optional everywhere.
export function loadMachine(primary, profile) {
  const path = join(primary, LOCAL_FILE);
  const needStage = Boolean(profile?.stage);
  if (!existsSync(path)) {
    if (needStage) return { present: false, config: null, error: { code: "local_config_missing", path, template: LOCAL_TEMPLATE } };
    return { present: false, config: { host: "", range: null, limit: null, cleanup: [] }, error: null };
  }
  const invalid = (key) => ({ present: true, config: null, error: { code: "local_config_invalid", key, path } });
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return invalid(LOCAL_FILE);
  }
  if (!isObject(raw)) return invalid(LOCAL_FILE);
  const cleanup = raw.cleanup ?? [];
  if (!Array.isArray(cleanup) || !cleanup.every(isCommand)) return invalid("cleanup");
  if (!needStage) return { present: true, config: { host: "", range: null, limit: null, cleanup }, error: null };
  if (typeof raw.host !== "string") return invalid("host");
  const match = typeof raw.ports === "string" ? raw.ports.trim().match(/^(\d+)-(\d+)$/) : null;
  const lo = match ? Number(match[1]) : NaN;
  const hi = match ? Number(match[2]) : NaN;
  if (!match || lo < 1 || hi > 65535 || lo > hi) return invalid("ports");
  if (!Number.isInteger(raw.limit) || raw.limit < 1) return invalid("limit");
  return { present: true, config: { host: raw.host.trim(), range: { lo, hi }, limit: raw.limit, cleanup }, error: null };
}

function ignored(primary, path) {
  return git(primary, ["check-ignore", "-q", "--no-index", path]).ok;
}

// The whole configuration gate in the order the Dispatcher reports it:
// profile → ignore rules → machine settings. Read-only.
export function loadEnvironment(repo) {
  const checkouts = listCheckouts(repo);
  const primary = checkouts[0]?.path ?? git(repo, ["rev-parse", "--show-toplevel"]).stdout;
  const loaded = loadProfile(primary);
  const report = {
    primary,
    checkouts,
    profile: loaded.profile,
    present: loaded.present,
    machine: null,
    local_config: existsSync(join(primary, LOCAL_FILE)),
    ignored: null,
    error: loaded.error,
  };
  if (report.error) return report;
  const profile = loaded.profile;
  if (profile?.worktree) {
    report.ignored = { dreamteam: ignored(primary, `${LOCAL_DIR}/`), worktree_root: ignored(primary, `${profile.worktree.root.replace(/\/+$/, "")}/`) };
    if (!report.ignored.dreamteam) return { ...report, error: { code: "local_config_not_ignored", key: `/${LOCAL_DIR}/` } };
    if (!report.ignored.worktree_root) return { ...report, error: { code: "worktree_root_not_ignored", key: `/${profile.worktree.root.replace(/\/+$/, "")}/` } };
  }
  const machine = loadMachine(primary, profile);
  report.machine = machine.config;
  if (machine.error) return { ...report, error: machine.error };
  return report;
}

// --- per-checkout state ------------------------------------------------------

export function readTreeLocal(checkout) {
  try {
    const value = JSON.parse(readFileSync(join(checkout, LOCAL_FILE), "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeTreeLocal(checkout, value) {
  mkdirSync(join(checkout, LOCAL_DIR), { recursive: true });
  writeFileSync(join(checkout, LOCAL_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

export function stageUrl(host, port, scheme = "http") {
  return `${scheme}://${host === "" ? BIND_HOST : host}:${port}`;
}

// The main stage owns the first N ports of the range and never records them.
export function mainPorts(stage, machine) {
  return Object.fromEntries(stage.ports.map((slot, index) => [slot, machine.range.lo + index]));
}

export function substitute(text, vars) {
  return text.replace(/\{(port\.[A-Za-z][A-Za-z0-9_-]*|url|name|slug|host|public_host)\}/g, (whole, token) => {
    if (token.startsWith("port.")) return String(vars.ports[token.slice(5)] ?? whole);
    return String(vars[token] ?? whole);
  });
}

export function stageVars(machine, name, ports, scheme = "http") {
  const first = Object.values(ports)[0];
  const publicHost = machine.host === "" ? BIND_HOST : machine.host;
  return { name, slug: name.toLowerCase(), host: BIND_HOST, public_host: publicHost, ports, url: stageUrl(machine.host, first, scheme) };
}

export function stageEnv(stage, vars) {
  return Object.fromEntries(Object.entries(stage.env).map(([name, value]) => [name, substitute(value, vars)]));
}

// Runs one project command through /bin/sh -c in `cwd`, appending its output
// to `log`. `capture` also returns stdout (migrations.pending prints names).
export function runCommand(command, { cwd, env = {}, log, capture = false }) {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `\n$ ${command}  # ${new Date().toISOString()}\n`);
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  appendFileSync(log, stdout + stderr + (result.status === 0 ? "" : `# exit ${result.status ?? result.signal ?? result.error?.code}\n`));
  return { code: result.status ?? 1, stdout: capture ? stdout : "", output: stdout + stderr };
}

// --- ports and processes -----------------------------------------------------

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return (error.stdout ?? "").toString();
  }
}

export function listenerPids(port) {
  return [...new Set(run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]).split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1))))];
}

export function processCwd(pid) {
  return run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
}

export function processGroup(pid) {
  const value = Number.parseInt(run("ps", ["-o", "pgid=", "-p", String(pid)]).trim(), 10);
  return Number.isInteger(value) && value > 1 ? value : null;
}

function bindable(port) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.listen(port, BIND_HOST, () => server.close(() => resolveBind(true)));
  });
}

export async function portBusy(port) {
  return listenerPids(port).length > 0 || !(await bindable(port));
}

// The stage process of a `start` checkout: the listener on its first port
// whose working directory is that checkout — for the primary, outside the
// worktree root.
export function ownListener(checkout, port, excludeRoot = null) {
  for (const pid of listenerPids(port)) {
    const cwd = processCwd(pid);
    if (!cwd) continue;
    const inside = cwd === checkout || cwd.startsWith(`${checkout}/`);
    const excluded = excludeRoot !== null && (cwd === excludeRoot || cwd.startsWith(`${excludeRoot}/`));
    if (inside && !excluded) return { pid, pgid: processGroup(pid) };
  }
  return null;
}

// Ports pinned by the task trees of the project, except `exceptPath`.
export function pinnedPorts(checkouts, exceptPath) {
  const pinned = new Set();
  for (const tree of checkouts.slice(1)) {
    if (tree.path === exceptPath) continue;
    for (const port of Object.values(readTreeLocal(tree.path)?.stage?.ports ?? {})) pinned.add(port);
  }
  return pinned;
}

// Smallest free ports of the task part of the range for every slot. `keep`
// holds a slot's current port that stays when free. Returns null when the
// range is exhausted.
export async function allocatePorts({ stage, machine, checkouts, exceptPath, keep = {} }) {
  const { lo, hi } = machine.range;
  const taken = pinnedPorts(checkouts, exceptPath);
  const reserved = new Set(Object.values(mainPorts(stage, machine)));
  const chosen = {};
  const used = new Set();
  for (const slot of stage.ports) {
    const current = keep[slot];
    if (Number.isInteger(current) && !reserved.has(current) && !taken.has(current) && !used.has(current) && !(await portBusy(current))) {
      chosen[slot] = current;
      used.add(current);
    }
  }
  let candidate = lo + stage.ports.length;
  for (const slot of stage.ports) {
    if (chosen[slot] !== undefined) continue;
    while (candidate <= hi && (taken.has(candidate) || used.has(candidate) || reserved.has(candidate) || (await portBusy(candidate)))) candidate += 1;
    if (candidate > hi) return null;
    chosen[slot] = candidate;
    used.add(candidate);
  }
  return chosen;
}

// Whether the stage of `checkout` runs: `start` — its own listener on the
// first port; `up`/`down`/`status` — `status` exits 0.
export function stageRunning({ gate, checkout, vars }) {
  const stage = gate.profile.stage;
  if (stage.start) {
    const exclude = checkout === gate.primary ? join(gate.primary, gate.profile.worktree.root) : null;
    return ownListener(checkout, Object.values(vars.ports)[0], exclude) !== null;
  }
  return runCommand(substitute(stage.status, vars), { cwd: checkout, env: stageEnv(stage, vars), log: join(checkout, STAGE_LOG) }).code === 0;
}
