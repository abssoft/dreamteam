#!/usr/bin/env node
// Project-wide inventory and removal of what finished runs left behind
// (routes/tidy.md): task trees with their stages, pinned ports and lsd
// Servers, git records of vanished trees. The workflow directories — journals,
// packets, Results — are the history of the items and stay.
// One call per operation, one JSON line out, exit 0. `--usage` prints the
// I/O contract.
//
// A task branch is never deleted, so removing a tree loses nothing but
// uncommitted changes — and a dirty tree is never removed. The tree itself
// goes through `stage.mjs cleanup` (stage stop, tailnet, the project's and the
// machine's cleanup commands, the owned-clean-stopped rail), the primary-side
// half skipped. Tracker-neutral: the caller resolves every key through the
// adapter and passes the abstract stages in.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, loadEnvironment, priorCommits, readTreeLocal, stageRunning, stageVars } from "./lib/profile.mjs";

const USAGE = `tidy.mjs — what finished runs left behind (routes/tidy.md).
Arg: single JSON {op, repo, base?="main", remote?="origin", sync?=false,
 stages?: {<KEY>: "<stage>" | {stage, status?}}, keys?: [<KEY>…]}
 repo — any checkout of the project. stages — the adapter's abstract stage per
 key (backlog|prd|dev|review|done|cancelled|unknown) and the tracker's own
 status text for the report. sync:true fetches <remote>/<base> first, so a
 merge made on the remote is seen; a failed fetch is a warning.
ops:
 keys    — {keys[]}: the keys whose tracker stage the verdict needs. Read-only.
 scan    — the inventory with a verdict per tree. Read-only apart from the
           fetch of sync:true.
 remove  — the same inventory, then removal: without \`keys\` every tree whose
           verdict is "remove", the git records of vanished trees, lsd
           leftovers, and \`rendered\` names every task tree that stayed with
           its reason; with \`keys\` only those trees — the human's decision,
           any verdict but still owned and clean.
Verdicts: remove | keep | deliver (accepted, not delivered) | dirty (uncommitted
changes — the human decides) | foreign (not a task tree — never touched).
 remove = clean and one of: the branch is merged into the base with commits of
 its own and the item is not back in dev/review; stage cancelled; stage done
 and the branch pushed.
Output: one JSON line {ok, op, base, primary{path, branch}, trees[{key, path,
branch, owned, clean, dirty_sample?, own_commits, merged, delivered, pushed,
head_outside (the tree holds a branch not merged into its key), stage{name, url, ports, running}|null, lsd, size_kb, tracker,
verdict, reason}], prunable[], lsd{available, gone[]}, removable[], totals{remove_kb, stages_running, items (what
a bare remove would take; 0 — nothing to tidy)}, warnings[],
rendered}; remove adds removed{trees[{key, path, removed, reason, freed_kb,
warnings[]}], pruned, lsd_cleanup}, freed_kb.
\`rendered\` is the report text, pasted as-is. ok:false codes: bad_args|not_a_repo|tidy_error.
`;

const STAGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "stage.mjs");

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function run(cmd, args, { cwd, timeout = 60_000 } = {}) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, stdout: (error.stdout ?? "").toString(), missing: error.code === "ENOENT" };
  }
}

function sizeKb(path) {
  const value = Number.parseInt(run("du", ["-sk", path], { timeout: 300_000 }).stdout, 10);
  return Number.isInteger(value) ? value : null;
}

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);

function human(kb) {
  if (kb === null) return "размер неизвестен";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} ГБ`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} МБ`;
  return `${kb} КБ`;
}

// --- git facts -----------------------------------------------------------------

function sha(cwd, ref) {
  const res = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

const contains = (cwd, ancestor, descendant) => git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;

// What git proves about the work of `key`: `subject` is its branch, or the
// tree's HEAD when the branch is gone. Delivered = merged into the base with
// commits of its own — a branch that never left the base is merged trivially
// and proves nothing — and nothing checked out in the tree lies outside it.
function workFacts(primary, key, bases, remote, head = null) {
  const subject = sha(primary, `refs/heads/${key}`) ?? head;
  if (!subject) return { branch: false, own_commits: null, merged: false, delivered: false, pushed: false };
  const mergedBase = bases.find((base) => contains(primary, subject, base)) ?? null;
  const own = priorCommits(primary, subject, mergedBase ?? bases[0] ?? null);
  const headInside = head === null || head === subject || contains(primary, head, subject) || bases.some((base) => contains(primary, head, base));
  const tracking = sha(primary, `refs/remotes/${remote}/${key}`);
  return {
    branch: true,
    own_commits: own,
    merged: mergedBase !== null,
    delivered: mergedBase !== null && own > 0 && headInside,
    pushed: tracking !== null && contains(primary, subject, tracking),
    head_outside: !headInside,
  };
}

function prunableTrees(primary) {
  const listed = git(primary, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return [];
  return listed.stdout.split("\n\n").filter((block) => /^prunable/m.test(block)).map((block) => block.match(/^worktree (.+)$/m)?.[1]).filter(Boolean);
}

// The trees lsd holds a Server for: the unindented lines of `lsd status`.
function lsdTrees() {
  const status = run("lsd", ["status"], { timeout: 20_000 });
  if (!status.ok) return { available: !status.missing && status.stdout !== "", trees: [] };
  return { available: true, trees: status.stdout.split("\n").filter((line) => line.startsWith("/")).map((line) => line.trim()) };
}

// --- verdicts ------------------------------------------------------------------

const REOPENED = ["dev", "review"];

function finished(facts, stage, base) {
  if (facts.delivered && !REOPENED.includes(stage)) return `ветка влита в ${base}`;
  if (stage === "cancelled") return "задача отменена";
  if (stage === "done" && facts.pushed) return "задача закрыта, ветка отправлена";
  return null;
}

function treeVerdict(tree, stage, base) {
  if (!tree.owned) return ["foreign", "не дерево задачи"];
  if (!tree.clean) return ["dirty", `незакоммиченные изменения: ${tree.dirty_sample.join("; ")}`];
  const done = finished(tree, stage, base);
  if (done) return ["remove", done];
  if (tree.delivered) return ["keep", `ветка влита в ${base}, задача снова в работе`];
  if (stage === "done") return ["deliver", "принята, не доставлена"];
  if (tree.head_outside) return ["keep", `в дереве ветка ${tree.branch ?? "без имени"}, не влитая в ${tree.key}`];
  return ["keep", stage === undefined || stage === "unknown" ? "ветка не влита, стадия в трекере неизвестна" : "в работе"];
}

// --- inventory -----------------------------------------------------------------

function inventory({ repo, base, remote, sync, stages }, { sizes }) {
  const gate = loadEnvironment(repo);
  const primary = gate.primary;
  if (!primary || gate.checkouts.length === 0) return null;
  const warnings = [];
  if (gate.error) warnings.push(`профиль: ${gate.error.code} — стейджи не проверены, деревья по каталогу профиля не опознаны`);
  if (sync) {
    const fetched = git(primary, ["fetch", remote, `refs/heads/${base}:refs/remotes/${remote}/${base}`]);
    if (!fetched.ok) warnings.push(`${remote}/${base} не обновлён — слияние судится по локальным данным`);
  }
  const bases = [`refs/remotes/${remote}/${base}`, `refs/heads/${base}`].filter((ref) => sha(primary, ref));
  if (bases.length === 0) warnings.push(`базовая ветка ${base} не найдена — слияние не определить`);

  const stageOf = (key) => {
    const value = stages?.[key];
    return typeof value === "string" ? { stage: value, status: null } : { stage: value?.stage, status: value?.status ?? null };
  };
  const root = gate.profile?.worktree ? join(primary, gate.profile.worktree.root) : null;
  const lsd = lsdTrees();
  const canStage = gate.error === null && Boolean(gate.profile?.stage);

  const trees = gate.checkouts.slice(1).filter((tree) => existsSync(tree.path)).map((tree) => {
    const local = readTreeLocal(tree.path);
    const key = local?.stage?.name
      ?? (root !== null && dirname(tree.path) === root ? basename(tree.path) : null)
      ?? (tree.path.startsWith(`${primary}-`) ? tree.path.slice(primary.length + 1) : null);
    const status = git(tree.path, ["status", "--porcelain"]);
    const dirty = status.ok ? status.stdout.split("\n").filter(Boolean) : ["git status не ответил"];
    const facts = key === null ? {} : workFacts(primary, key, bases, remote, sha(tree.path, "HEAD"));
    let stage = null;
    if (canStage && local?.stage?.ports && local.stage.name) {
      const vars = stageVars(gate.machine, local.stage.name, local.stage.ports, gate.profile.stage.scheme);
      let running = null;
      try {
        running = stageRunning({ gate, checkout: tree.path, vars });
      } catch {
        warnings.push(`${local.stage.name}: состояние стейджа не определено`);
      }
      stage = { name: local.stage.name, url: vars.url, ports: local.stage.ports, running };
    }
    const tracker = key === null ? { stage: undefined, status: null } : stageOf(key);
    const record = {
      key,
      path: tree.path,
      branch: tree.branch,
      owned: key !== null,
      clean: dirty.length === 0,
      ...(dirty.length ? { dirty_sample: dirty.slice(0, 5) } : {}),
      own_commits: facts.own_commits ?? null,
      merged: facts.merged ?? false,
      delivered: facts.delivered ?? false,
      pushed: facts.pushed ?? false,
      head_outside: facts.head_outside ?? false,
      stage,
      lsd: lsd.trees.includes(tree.path),
      size_kb: sizes ? sizeKb(tree.path) : null,
      tracker: tracker.stage ?? null,
      tracker_status: tracker.status,
    };
    [record.verdict, record.reason] = treeVerdict(record, tracker.stage, base);
    return record;
  });

  return {
    gate,
    report: {
      base,
      primary: { path: primary, branch: gate.checkouts[0].branch },
      trees,
      prunable: prunableTrees(primary),
      lsd: { available: lsd.available, gone: lsd.trees.filter((path) => !existsSync(path)) },
      removable: trees.filter((tree) => tree.verdict === "remove").map((tree) => tree.key),
      warnings,
    },
  };
}

// --- report --------------------------------------------------------------------

const LABEL = { remove: "можно удалить", keep: "оставить", deliver: "доставить", dirty: "решает человек", foreign: "чужое, не трогается" };
const ORDER = ["remove", "deliver", "dirty", "keep", "foreign"];

function renderScan(report) {
  const lines = [];
  const trees = [...report.trees].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  lines.push(trees.length ? `Деревья задач (база ${report.base}):` : "Деревьев задач нет.");
  for (const tree of trees) {
    const parts = [`${LABEL[tree.verdict]}: ${tree.reason}`];
    if (tree.owned) parts.push(`трекер: ${tree.tracker_status ?? tree.tracker ?? "не запрошен"}`);
    if (tree.branch !== tree.key) parts.push(`ветка ${tree.branch ?? "detached"}`);
    parts.push(human(tree.size_kb));
    if (tree.stage) parts.push(tree.stage.running ? `стейдж запущен ${tree.stage.url}` : `стейдж остановлен, порты ${Object.values(tree.stage.ports).join(",")} закреплены`);
    if (tree.lsd) parts.push("индекс lsd");
    lines.push(`- ${tree.key ?? tree.path} — ${parts.join(" · ")}`);
  }
  if (report.prunable.length) lines.push(`Записи git о пропавших деревьях: ${report.prunable.length}.`);
  if (report.lsd.gone.length) lines.push(`lsd держит индексы пропавших деревьев: ${report.lsd.gone.length}.`);
  if (report.primary.branch !== report.base) lines.push(`Основной чекаут стоит на ветке ${report.primary.branch ?? "detached"}.`);
  for (const warning of report.warnings) lines.push(`Предупреждение: ${warning}.`);
  lines.push(`Итого освободится: ${human(report.totals.remove_kb)}; запущенных стейджей к остановке: ${report.totals.stages_running}.`);
  return lines.join("\n");
}

function withTotals(report) {
  const removed = report.trees.filter((tree) => tree.verdict === "remove");
  report.totals = {
    remove_kb: sum(removed.map((tree) => tree.size_kb)),
    stages_running: removed.filter((tree) => tree.stage?.running).length,
    items: removed.length + report.prunable.length + report.lsd.gone.length,
  };
  return report;
}

// --- removal -------------------------------------------------------------------

function remove(args, { gate, report }) {
  const named = Array.isArray(args.keys) && args.keys.length ? args.keys : null;
  const removed = { trees: [], pruned: false, lsd_cleanup: false };
  const targets = report.trees.filter((tree) => (named ? tree.owned && named.includes(tree.key) : tree.verdict === "remove"));
  for (const tree of targets) {
    if (tree.lsd) run("lsd", ["stop", tree.path], { timeout: 60_000 });
    const called = run(process.execPath, [STAGE_SCRIPT, JSON.stringify({ op: "cleanup", repo: gate.primary, key: tree.key, primary: false })], { timeout: 600_000 });
    let answer = null;
    try {
      answer = JSON.parse(called.stdout);
    } catch {
      // reported below
    }
    const gone = answer?.tree?.removed === true && answer.tree.path === tree.path;
    const entry = {
      key: tree.key,
      path: tree.path,
      removed: gone,
      reason: gone ? null : answer?.tree?.reason ?? answer?.code ?? "stage.mjs cleanup не ответил",
      freed_kb: gone ? tree.size_kb ?? 0 : 0,
      warnings: (answer?.warnings ?? []).map((warning) => [warning.code, warning.detail ?? warning.command, warning.log].filter(Boolean).join(" — ")),
    };
    removed.trees.push(entry);
  }
  if (!named && report.prunable.length) removed.pruned = git(gate.primary, ["worktree", "prune"]).ok;
  if (report.lsd.available && (report.lsd.gone.length || removed.trees.some((tree) => tree.removed))) {
    removed.lsd_cleanup = run("lsd", ["cleanup"], { timeout: 300_000 }).ok;
  }
  const freed = sum(removed.trees.map((tree) => tree.freed_kb));

  const lines = [];
  for (const tree of removed.trees) {
    lines.push(tree.removed ? `- ${tree.key} — дерево удалено (${human(tree.freed_kb)}), ветка ${tree.key} сохранена` : `- ${tree.key} — дерево оставлено: ${tree.reason}`);
    for (const warning of tree.warnings) lines.push(`  предупреждение: ${warning}`);
  }
  if (named) for (const key of named.filter((name) => !targets.some((tree) => tree.key === name))) lines.push(`- ${key} — дерева задачи нет`);
  const stayed = named ? [] : report.trees.filter((tree) => tree.owned && tree.verdict !== "remove");
  for (const tree of stayed) lines.push(`- ${tree.key} — ${LABEL[tree.verdict]}: ${tree.reason}`);
  if (removed.pruned) lines.push("Записи git о пропавших деревьях убраны.");
  if (removed.lsd_cleanup) lines.push("Остатки lsd убраны.");
  lines.push(removed.trees.length || removed.pruned || removed.lsd_cleanup ? `Освобождено: ${human(freed)}.` : "Убирать нечего.");
  return { removed, freed_kb: freed, rendered: lines.join("\n") };
}

function main() {
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
  const { op, repo, base = "main", remote = "origin", sync = false, stages = {}, keys } = args ?? {};
  if (!["keys", "scan", "remove"].includes(op) || typeof repo !== "string" || repo === "") out({ ok: false, code: "bad_args" });

  const found = inventory({ repo, base, remote, sync: sync === true && op !== "keys", stages }, { sizes: op !== "keys" });
  if (!found) out({ ok: false, op, code: "not_a_repo" });
  const { report } = found;
  if (op === "keys") {
    out({ ok: true, op, keys: [...new Set(report.trees.filter((tree) => tree.owned).map((tree) => tree.key))] });
  }
  withTotals(report);
  const result = op === "scan" ? { rendered: renderScan(report) } : remove({ keys }, found);
  out({ ok: true, op, ...report, ...result });
}

try {
  main();
} catch (error) {
  out({ ok: false, code: "tidy_error", detail: String(error?.message ?? error).slice(0, 300) });
}
