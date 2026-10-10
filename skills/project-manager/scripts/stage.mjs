#!/usr/bin/env node
// Stage lifecycle for the Dispatcher (§6, routes/develop.md, routes/deliver.md,
// routes/stage.md): one call per operation, one JSON line out, exit 0.
// A stage is the site of one checkout on its own ports: the main stage runs
// from the primary checkout on the first N ports of the machine range, a task
// stage from its tree on the ports pinned in the tree's .dreamteam/local.json.
// The project profile (dreamteam.json) names the commands; this script owns
// the shared mechanics — ports, tailnet, start/stop, readiness, limit,
// migrations, cleanup. `--usage` prints the I/O contract.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import {
  LOCAL_DIR, MAIN_STAGE, SETUP_LOG, STAGE_LOG,
  allocatePorts, git, loadEnvironment, mainPorts, ownListener, portBusy, readTreeLocal,
  runCommand, stageEnv, stageRunning, stageVars, substitute, writeTreeLocal,
} from "./lib/profile.mjs";

const USAGE = `stage.mjs — stage lifecycle (SKILL §6, routes/develop.md, deliver.md, stage.md).
Arg: single JSON {op, repo, workspace?, name?, base?="main", key?}
 repo — any checkout of the project; the profile and the machine settings are
 read from the primary checkout. The target is \`workspace\` (a checkout path
 from prepare-worktree) or \`name\` (KEY | main): the tree whose stage block
 carries that name, else the tree holding branch KEY, else the primary when it
 holds KEY (the main stage).
ops:
 prepare  — migrations (pending → apply; a failed apply is classified by
            \`git diff --name-only --diff-filter=A <base>...HEAD\`), then stop,
            ports, tailnet, start, readiness (≤180 s); the limit is checked
            only when the stage was not running.
 ensure   — running with no pending migrations → the address, no restart;
            otherwise prepare.
 state    — {running, url} without side effects beyond \`status\`.
 stop     — stop the stage and drop its tailscale serve entries; an already
            stopped stage is a success.
 list     — every stage (main + trees) with branch, url, running; drops
            tailscale entries of range ports no tree pins and main does not own.
 cleanup  — after \`сливай\` (key): stop the task stage, drop its tailnet
            entries, stage.cleanup + machine cleanup, remove the tree when owned,
            clean and stopped; then worktree.setup and the main stage in the
            primary. Every primary-side failure is a warning.
Output: one JSON line {ok, op, stage{name, kind, checkout, ports, url, running,
log}|null, migrations{applied, error, branch_migrations, base_migrations,
error_path, error_tail}?, environment_text?, qa_brief?, stages?, pruned?,
tree?, main?, warnings[], actions[]}. A project without a stage block:
{ok:true, stage:null, message}. ok:false codes: bad_args|profile_invalid|
local_config_missing|local_config_invalid|local_config_not_ignored|
worktree_root_not_ignored|worktree_missing|stage_unhealthy|stop_failed|
tailscale_failed|port_range_exhausted|stage_limit_reached (running[])|
migrations_unavailable|migration_failed_base|stage_error.
Migration of the branch failed: ok:true, migrations.error
"migration_failed_branch", the stage started on the old schema.
`;

const HEALTH_BUDGET_MS = 180_000;
const STOP_GRACE_MS = 10_000;
const NO_STAGES = "У проекта нет стейджей";

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// --- targets -----------------------------------------------------------------

function mainTarget(gate) {
  return { checkout: gate.primary, name: MAIN_STAGE, main: true, ports: mainPorts(gate.profile.stage, gate.machine), branch: gate.checkouts[0]?.branch ?? null };
}

function treeTarget(tree) {
  const local = readTreeLocal(tree.path);
  if (!local?.stage?.ports || !local.stage.name) return null;
  return { checkout: tree.path, name: local.stage.name, main: false, ports: local.stage.ports, branch: tree.branch, local };
}

function resolveTarget(gate, { workspace, name }) {
  const trees = gate.checkouts.slice(1);
  if (typeof workspace === "string" && workspace !== "") {
    if (workspace === gate.primary) return mainTarget(gate);
    const tree = trees.find((item) => item.path === workspace);
    return tree ? treeTarget(tree) : null;
  }
  if (name === MAIN_STAGE) return mainTarget(gate);
  const byName = trees.map(treeTarget).find((target) => target?.name === name);
  if (byName) return byName;
  const byBranch = trees.find((item) => item.branch === name);
  if (byBranch) return treeTarget(byBranch);
  if (gate.checkouts[0]?.branch === name) return mainTarget(gate);
  return null;
}

function stageTargets(gate) {
  return [mainTarget(gate), ...gate.checkouts.slice(1).map(treeTarget).filter(Boolean)];
}

// --- tailnet -----------------------------------------------------------------

function tailscale(args) {
  try {
    return { ok: true, stdout: execFileSync("tailscale", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, detail: String(error.stderr ?? error.message ?? "").trim().slice(0, 300) };
  }
}

function servedPorts() {
  const status = tailscale(["serve", "status", "--json"]);
  if (!status.ok) return null;
  try {
    return new Set(Object.keys(JSON.parse(status.stdout || "{}").TCP ?? {}).map(Number));
  } catch {
    return null;
  }
}

function openTailnet(gate, ports, actions) {
  if (gate.machine.host === "") return null;
  const served = servedPorts();
  if (served === null) return "tailscale serve status failed";
  for (const port of ports) {
    if (served.has(port)) continue;
    const res = tailscale(["serve", "--bg", "--tcp", String(port), `tcp://127.0.0.1:${port}`]);
    if (!res.ok) return res.detail || `tailscale serve --tcp ${port} failed`;
    actions.push(`tailscale serve --tcp ${port}`);
  }
  return null;
}

function closeTailnet(gate, ports, actions) {
  if (gate.machine.host === "") return null;
  const served = servedPorts();
  if (served === null) return "tailscale serve status failed";
  for (const port of ports) {
    if (!served.has(port)) continue;
    const res = tailscale(["serve", `--tcp=${port}`, "off"]);
    if (!res.ok) return res.detail || `tailscale serve --tcp=${port} off failed`;
    actions.push(`tailscale serve --tcp=${port} off`);
  }
  return null;
}

// --- process control ------------------------------------------------------------

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function excludeRoot(gate, target) {
  return target.main ? join(gate.primary, gate.profile.worktree.root) : null;
}

// Stops the stage; returns null when confirmed stopped, else a reason.
async function stopStage(gate, target, vars, actions) {
  const stage = gate.profile.stage;
  const log = join(target.checkout, STAGE_LOG);
  if (!stage.start) {
    const down = runCommand(substitute(stage.down, vars), { cwd: target.checkout, env: stageEnv(stage, vars), log });
    if (down.code !== 0) return "down failed";
    actions.push("down");
    return null;
  }
  const first = Object.values(vars.ports)[0];
  const own = ownListener(target.checkout, first, excludeRoot(gate, target));
  if (!own) return null;
  if (own.pgid === null) return "stage process group unknown";
  try {
    process.kill(-own.pgid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupAlive(own.pgid) && Date.now() < deadline) await sleep(250);
  if (groupAlive(own.pgid)) {
    try {
      process.kill(-own.pgid, "SIGKILL");
    } catch {
      // already gone
    }
    await sleep(500);
  }
  actions.push(`stop pgid ${own.pgid}`);
  return ownListener(target.checkout, first, excludeRoot(gate, target)) ? "stage still listening" : null;
}

// GET status of a health URL. https skips certificate checks: 127.0.0.1
// never matches the stage certificate, and readiness is not a TLS audit.
function probe(url) {
  const client = url.startsWith("https:") ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = client(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitHealthy(urls, exited) {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  for (const url of urls) {
    for (;;) {
      if (exited() !== null) return `start exited (${exited()})`;
      try {
        const status = await probe(url);
        if (status >= 200 && status < 300) break;
      } catch {
        // not ready yet
      }
      if (Date.now() > deadline) return `no 2xx from ${url}`;
      await sleep(1000);
    }
  }
  return null;
}

// --- migrations -----------------------------------------------------------------

const names = (stdout) => stdout.split("\n").map((line) => line.trim()).filter(Boolean);

function migrate(gate, target, vars, base) {
  const migrations = gate.profile.stage.migrations;
  const result = { applied: [], error: null, branch_migrations: [], base_migrations: [], error_path: null, error_tail: null };
  if (!migrations) return result;
  const options = { cwd: target.checkout, env: stageEnv(gate.profile.stage, vars), log: join(target.checkout, STAGE_LOG), capture: true };
  const pending = runCommand(substitute(migrations.pending, vars), options);
  if (pending.code !== 0) return { ...result, error: "migrations_unavailable" };
  const list = names(pending.stdout);
  if (list.length === 0) return result;
  const apply = runCommand(substitute(migrations.apply, vars), options);
  if (apply.code === 0) return { ...result, applied: list };
  const again = runCommand(substitute(migrations.pending, vars), options);
  if (again.code !== 0) return { ...result, error: "migrations_unavailable" };
  const remaining = names(again.stdout);
  const added = git(target.checkout, ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]);
  const addedPaths = added.ok ? added.stdout.split("\n").filter(Boolean) : [];
  const branch = remaining.filter((name) => addedPaths.some((path) => path.includes(name)));
  const errorPath = join(target.checkout, LOCAL_DIR, "migration-error.log");
  writeFileSync(errorPath, apply.output);
  return {
    ...result,
    applied: list.filter((name) => !remaining.includes(name)),
    error: branch.length ? "migration_failed_branch" : "migration_failed_base",
    branch_migrations: branch,
    base_migrations: remaining.filter((name) => !branch.includes(name)),
    error_path: errorPath,
    error_tail: apply.output.trim().slice(-1500),
  };
}

// --- operations -----------------------------------------------------------------

function describe(gate, target, running) {
  const vars = stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme);
  return {
    name: target.name,
    kind: gate.profile.stage.start ? "start" : "compose",
    checkout: target.checkout,
    branch: target.branch ?? null,
    ports: target.ports,
    url: vars.url,
    running,
    log: join(target.checkout, STAGE_LOG),
  };
}

function environmentText(gate, stage, migrations) {
  const parts = [`Окружение: стейдж \`${stage.url}\` работает из этого рабочего каталога`];
  if (gate.profile.stage.start) parts.push("журнал запуска — `.dreamteam/stage.log`");
  if (gate.profile.stage.migrations) {
    parts.push(migrations?.error === "migration_failed_branch" ? "миграция ветки не применилась — см. `migration_error`" : "миграции ветки уже применены к общей базе");
  }
  return `${parts.join("; ")}. Стейдж, базу и Docker запускает и останавливает диспетчер.`;
}

function running(gate, target) {
  return stageRunning({ gate, checkout: target.checkout, vars: stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme) });
}

async function prepare(gate, target, base) {
  const stage = gate.profile.stage;
  const actions = [];
  const log = join(target.checkout, STAGE_LOG);
  const fail = (code, extra = {}) => ({ ok: false, op: "prepare", code, stage: describe(gate, target, false), log, actions, ...extra });
  let vars = stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme);

  if (!stageRunning({ gate, checkout: target.checkout, vars }) && !target.main) {
    const others = gate.checkouts.slice(1).map(treeTarget).filter((item) => item && item.checkout !== target.checkout);
    const busy = others.filter((item) => running(gate, item)).map((item) => ({ name: item.name, url: describe(gate, item, true).url, stop: `стейдж ${item.name} стоп` }));
    if (busy.length >= gate.machine.limit) return fail("stage_limit_reached", { running: busy });
  }

  const migrations = migrate(gate, target, vars, base);
  if (migrations.error && migrations.error !== "migration_failed_branch") return fail(migrations.error, { migrations });

  const stopped = await stopStage(gate, target, vars, actions);
  if (stopped) return fail(stage.start ? "stage_unhealthy" : "stop_failed", { detail: stopped, migrations });

  // Ports: a task stage moves off a port a foreign process took; the main
  // stage never moves.
  let ports = target.ports;
  const busyPorts = [];
  for (const port of Object.values(ports)) if (await portBusy(port)) busyPorts.push(port);
  if (busyPorts.length && target.main) return fail("stage_unhealthy", { detail: `ports busy: ${busyPorts.join(",")}`, migrations });
  if (busyPorts.length) {
    const moved = await allocatePorts({ stage, machine: gate.machine, checkouts: gate.checkouts, exceptPath: target.checkout, keep: ports });
    if (!moved) return fail("port_range_exhausted", { migrations });
    const dropped = Object.values(ports).filter((port) => !Object.values(moved).includes(port));
    const closed = closeTailnet(gate, dropped, actions);
    if (closed) return fail("tailscale_failed", { detail: closed, migrations });
    ports = moved;
    actions.push(`ports ${Object.values(ports).join(",")}`);
  }
  target = { ...target, ports };
  vars = stageVars(gate.machine, target.name, ports, gate.profile.stage.scheme);
  if (!target.main) {
    const local = readTreeLocal(target.checkout) ?? {};
    local.stage = { name: target.name, ports, url: vars.url };
    writeTreeLocal(target.checkout, local);
  }

  const opened = openTailnet(gate, Object.values(ports), actions);
  if (opened) return fail("tailscale_failed", { detail: opened, migrations });

  let exitCode = null;
  const env = stageEnv(stage, vars);
  if (stage.start) {
    mkdirSync(join(target.checkout, LOCAL_DIR), { recursive: true });
    const fd = openSync(log, "a");
    const child = spawn("/bin/sh", ["-c", substitute(stage.start, vars)], { cwd: target.checkout, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", fd, fd] });
    child.on("exit", (code, signal) => {
      exitCode = code ?? signal;
    });
    child.unref();
    actions.push(`start pid ${child.pid}`);
  } else {
    const up = runCommand(substitute(stage.up, vars), { cwd: target.checkout, env, log });
    if (up.code !== 0) return fail("stage_unhealthy", { detail: "up failed", migrations });
    actions.push("up");
  }

  const first = Object.values(ports)[0];
  const urls = [`${stage.scheme}://127.0.0.1:${first}${stage.health}`];
  if (gate.machine.host !== "") urls.push(`${vars.url}${stage.health}`);
  const unhealthy = await waitHealthy(urls, () => exitCode);
  if (unhealthy) return fail("stage_unhealthy", { detail: unhealthy, migrations });

  const described = describe(gate, target, true);
  const text = environmentText(gate, described, migrations);
  return {
    ok: true,
    op: "prepare",
    stage: described,
    migrations,
    environment_text: text,
    qa_brief: [text, `Проверки в браузере на стейдже \`${described.url}\` разрешены владельцем.`],
    actions,
  };
}

async function stop(gate, target) {
  const actions = [];
  const vars = stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme);
  const stopped = await stopStage(gate, target, vars, actions);
  if (stopped) return { ok: false, op: "stop", code: "stop_failed", detail: stopped, stage: describe(gate, target, true), actions };
  const closed = closeTailnet(gate, Object.values(target.ports), actions);
  if (closed) return { ok: false, op: "stop", code: "tailscale_failed", detail: closed, stage: describe(gate, target, false), actions };
  return { ok: true, op: "stop", stage: describe(gate, target, false), actions };
}

function list(gate) {
  const actions = [];
  const targets = stageTargets(gate);
  const stages = targets.map((target) => describe(gate, target, running(gate, target)));
  let pruned = [];
  if (gate.machine.host !== "") {
    const { lo, hi } = gate.machine.range;
    const owned = new Set(targets.flatMap((target) => Object.values(target.ports)));
    const orphans = [...(servedPorts() ?? [])].filter((port) => port >= lo && port <= hi && !owned.has(port));
    const closed = closeTailnet(gate, orphans, actions);
    pruned = closed ? [] : orphans;
    if (closed) return { ok: false, op: "list", code: "tailscale_failed", detail: closed, stages, actions };
  }
  return { ok: true, op: "list", stages, pruned, actions };
}

function ownedTree(gate, key) {
  const trees = gate.checkouts.slice(1);
  const pinned = gate.profile?.worktree ? join(gate.primary, gate.profile.worktree.root, key) : null;
  const fallback = `${gate.primary}-${key}`;
  const tree =
    trees.find((item) => item.branch === key) ??
    trees.find((item) => readTreeLocal(item.path)?.stage?.name === key) ??
    trees.find((item) => item.path === pinned || item.path === fallback);
  if (!tree) return null;
  const owned = tree.path === pinned || tree.path === fallback || readTreeLocal(tree.path)?.stage?.name === key;
  return { tree, owned };
}

async function cleanup(gate, key) {
  const actions = [];
  const warnings = [];
  const stage = gate.profile?.stage ?? null;
  const primaryLog = join(gate.primary, STAGE_LOG);
  const result = { ok: true, op: "cleanup", tree: null, main: null, warnings, actions };
  const found = ownedTree(gate, key);

  if (found) {
    const { tree, owned } = found;
    let stopped = true;
    if (stage) {
      const target = treeTarget(tree);
      if (target) {
        const vars = stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme);
        const reason = await stopStage(gate, target, vars, actions);
        stopped = reason === null;
        if (!stopped) warnings.push({ code: "stop_failed", detail: reason, log: join(tree.path, STAGE_LOG) });
        const closed = closeTailnet(gate, Object.values(target.ports), actions);
        if (closed) warnings.push({ code: "tailscale_failed", detail: closed });
        for (const command of stage.cleanup) {
          const res = runCommand(substitute(command, vars), { cwd: tree.path, env: stageEnv(stage, vars), log: primaryLog });
          if (res.code !== 0) warnings.push({ code: "cleanup_failed", command, log: primaryLog });
        }
      }
    }
    if (gate.local_config) {
      for (const command of gate.machine.cleanup) {
        const res = runCommand(command, { cwd: tree.path, log: primaryLog });
        if (res.code !== 0) warnings.push({ code: "cleanup_failed", command, log: primaryLog });
      }
    }
    const status = git(tree.path, ["status", "--porcelain"]);
    const dirty = !status.ok || status.stdout !== "";
    let reason = null;
    if (!owned) reason = "дерево не принадлежит задаче";
    else if (dirty) reason = `незакоммиченные изменения: ${status.stdout.split("\n").slice(0, 5).join("; ")}`;
    else if (!stopped) reason = "стейдж не остановлен";
    if (reason === null) {
      const removed = git(gate.primary, ["worktree", "remove", tree.path]);
      if (removed.ok) actions.push(`worktree remove ${tree.path}`);
      else reason = `git worktree remove: ${removed.stderr.slice(0, 200)}`;
    }
    result.tree = { path: tree.path, removed: reason === null, reason };
  }

  // The primary checkout: dependencies of the new main, then the main stage.
  if (gate.profile?.worktree) {
    for (const command of gate.profile.worktree.setup) {
      if (runCommand(command, { cwd: gate.primary, log: join(gate.primary, SETUP_LOG) }).code !== 0) {
        warnings.push({ code: "setup_failed", log: join(gate.primary, SETUP_LOG) });
        return result;
      }
    }
  }
  if (stage) {
    const main = await prepare(gate, mainTarget(gate), "main");
    if (!main.ok) warnings.push({ code: main.code, detail: main.detail ?? null, log: main.log });
    else if (main.migrations?.error) warnings.push({ code: main.migrations.error, log: main.migrations.error_path });
    result.main = { url: main.stage?.url ?? null, running: main.ok };
  }
  return result;
}

async function main() {
  if (["--usage", "--help", "-h"].includes(process.argv[2])) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  let args;
  try {
    args = JSON.parse(process.argv[2] ?? "");
  } catch {
    out({ ok: false, code: "bad_args" });
  }
  const { op, repo, workspace, name, base = "main", key } = args ?? {};
  const ops = ["prepare", "ensure", "state", "stop", "list", "cleanup"];
  if (!ops.includes(op) || typeof repo !== "string" || repo === "") out({ ok: false, code: "bad_args" });
  if (op === "cleanup" && (typeof key !== "string" || key === "")) out({ ok: false, code: "bad_args" });

  const gate = loadEnvironment(repo);
  if (gate.error) out({ ok: false, op, code: gate.error.code, key: gate.error.key ?? null, path: gate.error.path ?? null, ...(gate.error.template ? { template: gate.error.template } : {}) });
  if (op === "cleanup") out(await cleanup(gate, key));
  if (!gate.profile?.stage) out({ ok: true, op, stage: null, message: NO_STAGES, warnings: [] });
  if (op === "list") out(list(gate));

  const target = resolveTarget(gate, { workspace, name });
  if (!target) out({ ok: false, op, code: "worktree_missing", name: name ?? workspace ?? null });
  if (op === "state") out({ ok: true, op, stage: describe(gate, target, running(gate, target)) });
  if (op === "stop") out(await stop(gate, target));
  if (op === "ensure" && running(gate, target)) {
    const migrations = gate.profile.stage.migrations;
    const vars = stageVars(gate.machine, target.name, target.ports, gate.profile.stage.scheme);
    const pending = migrations
      ? runCommand(substitute(migrations.pending, vars), { cwd: target.checkout, env: stageEnv(gate.profile.stage, vars), log: join(target.checkout, STAGE_LOG), capture: true })
      : { code: 0, stdout: "" };
    if (pending.code === 0 && names(pending.stdout).length === 0) out({ ok: true, op, restarted: false, stage: describe(gate, target, true) });
  }
  const prepared = await prepare(gate, target, base);
  out({ ...prepared, op, ...(op === "ensure" ? { restarted: prepared.ok } : {}) });
}

main().catch((error) => out({ ok: false, code: "stage_error", detail: String(error?.message ?? error).slice(0, 300) }));
