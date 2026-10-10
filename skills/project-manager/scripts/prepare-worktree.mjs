#!/usr/bin/env node
// One-call Git/workspace inspection and preparation for the Dispatcher (§6).
// The only source of private-side Git facts: never run raw git for state the
// snapshot covers; refreshing stale evidence = exactly one re-run.
// `--usage` prints the I/O contract; the Dispatcher never reads this source.
// Input: single CLI arg — JSON:
//   {repo, key, parentKey?, base?="main", remote?="origin", sync?=false,
//    ensure?: "develop"|"review"}
// Output: one JSON line; always exit 0. ok:false only when the repo itself
// is unusable; missing branches/remotes are reported as data, not errors.
// sync:true performs the §6 remote-only synchronization per requested branch:
// ls-remote --exit-code, guarded fetch of the exact refspec, re-read
// equality, prior→queried ancestry. Violations are reported in
// sync.<branch>.error; the caller decides to block.
//
// ensure (optional) makes this script the single owner of branch/worktree
// lifecycle — the caller never runs raw git for it. Placement is deterministic:
// branch already checked out -> work there; branch exists but is checked out
// nowhere -> clean primary takes it in place, dirty primary falls back to a
// dedicated worktree; branch missing -> "develop" creates it, "review" refuses
// (`review_requires_branch`). The creation base is the synchronized
// refs/remotes/<remote>/<base> whenever sync succeeded, so a lagging local base
// can never seed a task branch. Subtask runs (parentKey) first ensure the
// parent branch, then use the parent workspace — the checkout holding <KEY>
// or <PARENT_KEY>, the primary included — else the dedicated parent worktree,
// and cut the subtask branch from refs/heads/<parentKey> inside it. The human
// parks a task branch in the primary to test in the real environment: that
// checkout is the workspace even with a project profile (placement
// "primary"). A switch inside the chosen checkout requires it clean —
// `workspace_dirty` otherwise, nothing created. A parent worktree
// parked on a sibling subtask branch (a finished subtask without `сливай`) is
// adopted only when clean and already merged into the parent; otherwise
// `prepared.error: "parent_worktree_occupied"` with `occupied_by` naming the
// parked branch — the remedy is `<occupied_by> сливай`.
//
// The project profile (`dreamteam.json`, lib/profile.mjs) decides placement:
// a `worktree` block pins every new worktree to
// <primary>/<worktree.root>/<KEY> and forbids taking the primary. A freshly
// created tree gets its links and copies, the machine settings copy with the
// stage block (ports pinned from the range) and `worktree.setup` (output in
// .dreamteam/setup.log; non-zero exit -> `setup_failed`, tree preserved). An
// existing tree is returned as is, except a missing `setup: true` (setup runs
// again) and a pre-4.0.0 tree without .dreamteam/ (local.json with
// `setup: true`, stage block, missing links; setup does not run).
// Results land in `prepared` and the environment facts in `environment`.
// `prepared.prior_commits` counts the commits the task branch carried beyond
// its base (the parent branch on a subtask run) before this call changed
// anything — 0 for a local branch the call cuts from the base; a branch taken
// from its remote counts the remote's commits; null when git cannot count. They
// are counted from the fork point on the base's first-parent history, so a
// branch already delivered by a --no-ff merge still counts its own commits.
// The first call of a development command tells a re-entry (work left by an
// earlier run or a delivery) from a first attempt.
// Rails enforced here, never repaired: the primary checkout is never moved off
// its branch destructively, the base branch is never mutated, and any mid-flight
// failure stops with a code instead of retrying.

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LOCAL_DIR, LOCAL_FILE, MAIN_STAGE, SETUP_LOG, STAGE_LOG,
  allocatePorts, listCheckouts, loadEnvironment, mainPorts, readTreeLocal, runCommand,
  stageEnv, stageRunning, stageUrl, stageVars, substitute, writeTreeLocal,
} from "./lib/profile.mjs";

const USAGE = `prepare-worktree.mjs — one-call Git inspect + branch/worktree/environment prepare (SKILL §6).
Arg: single JSON:
 {repo, key, parentKey?, base?="main", remote?="origin", sync?=false,
  ensure?: "develop"|"review"}
sync:true — per-branch remote synchronization; violations land in
sync.<branch>.error (remote_branch_deleted|transport_failure|
malformed_ls_remote|fetch_failed|reread_mismatch|divergence) — caller blocks.
ensure — the script owns the whole branch/worktree lifecycle: a checked-out
branch is reused; an existing branch goes to a clean primary in place (no
profile worktree block) or a dedicated worktree; a missing branch: "develop"
creates it from synchronized origin/<base>, "review" refuses
(review_requires_branch). parentKey (subtask runs) ensures the parent branch
first and uses the parent workspace: the checkout holding <KEY> or
<PARENT_KEY> (the primary included — placement "primary" wins over the
profile), else the dedicated parent worktree. A switch inside the chosen
checkout requires it clean (workspace_dirty + dirty_sample otherwise, nothing
created). Profile dreamteam.json with a worktree block pins
<primary>/<worktree.root>/<KEY>; a fresh tree gets links, copies, the
.dreamteam/local.json copy with the stage block and worktree.setup (log
.dreamteam/setup.log); an existing tree reruns setup only without setup:true.
Output: one compact JSON line (SHAs only in prepared.head) {ok, profile{present, worktree_root,
stage, error}, primary{path, branch, clean, dirty_sample?}, worktrees[same],
remote, branches{<name>: {checked_out_at}}, sync?{<branch>: {error}} (only
failed branches), prepared?{workspace, placement: "worktree"|"primary",
branch, head, base_ref, created_branch, created_worktree, ran_setup, prior_commits, error, error_key?,
error_path?, template?, log?, occupied_by?, dirty_sample?}, environment{workspace, branch,
base, placement, created_worktree, stage{name, kind, ports, url, running,
log}|null, migrations_pending[]|null, warnings[]}?, ancestry{key_in_parent}}.
prepared.prior_commits — commits the task branch carried beyond its base (the
parent branch on a subtask run) before this call, a delivered --no-ff merge
included; 0 for a local branch the call cuts from the base, a branch taken
from its remote counts the remote's commits, null when not countable. The
first call of a development command tells a re-entry from a first attempt.
prepared.error: bad_ensure|profile_invalid|local_config_missing|
local_config_invalid|local_config_not_ignored|worktree_root_not_ignored|
base_missing|workspace_dirty|branch_create_failed|worktree_create_failed|
parent_worktree_occupied|checkout_failed|setup_failed|port_range_exhausted|
review_requires_branch|<sync codes>.
`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    if (allowFail) return { ok: false, status: error.status ?? null, stdout: (error.stdout ?? "").toString().trim(), stderr: (error.stderr ?? "").toString().trim() };
    throw error;
  }
}

function checkoutInfo(path) {
  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  const head = git(path, ["rev-parse", "HEAD"], { allowFail: true });
  const status = git(path, ["status", "--porcelain"], { allowFail: true });
  const dirty = status.ok ? status.stdout.split("\n").filter((line) => line !== "") : [];
  return {
    path,
    branch: branch.ok ? branch.stdout : null,
    head: head.ok ? head.stdout : null,
    clean: dirty.length === 0,
    dirty_sample: dirty.slice(0, 5),
  };
}

function listWorktrees(toplevel) {
  const listed = git(toplevel, ["worktree", "list", "--porcelain"], { allowFail: true });
  const trees = [];
  if (!listed.ok) return trees;
  for (const block of listed.stdout.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (path) trees.push(checkoutInfo(path));
  }
  return trees;
}

function branchSha(cwd, ref) {
  const res = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], { allowFail: true });
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

function trackingSha(cwd, remote, ref) {
  const res = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${ref}`], { allowFail: true });
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

function isAncestor(cwd, a, b) {
  if (!a || !b) return null;
  const res = git(cwd, ["merge-base", "--is-ancestor", a, b], { allowFail: true });
  if (res.ok) return true;
  return res.status === 1 ? false : null;
}

function syncBranch(cwd, remote, branch) {
  const prior = trackingSha(cwd, remote, branch);
  const probe = git(cwd, ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`], { allowFail: true });
  if (!probe.ok && probe.status === 2) {
    if (prior) return { prior_tracking_sha: prior, remote_sha: null, error: "remote_branch_deleted" };
    return { prior_tracking_sha: null, remote_sha: null, error: null };
  }
  if (!probe.ok) return { prior_tracking_sha: prior, remote_sha: null, error: "transport_failure" };
  const rows = probe.stdout.split("\n").filter((line) => line !== "");
  const match = rows.length === 1 ? rows[0].match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/) : null;
  if (!match || match[2] !== branch) return { prior_tracking_sha: prior, remote_sha: null, error: "malformed_ls_remote" };
  const queried = match[1];
  const fetch = git(cwd, ["fetch", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { allowFail: true });
  if (!fetch.ok) return { prior_tracking_sha: prior, remote_sha: queried, error: "fetch_failed" };
  const reread = trackingSha(cwd, remote, branch);
  if (reread !== queried) return { prior_tracking_sha: prior, remote_sha: queried, error: "reread_mismatch" };
  if (prior && prior !== queried && isAncestor(cwd, prior, queried) !== true) {
    return { prior_tracking_sha: prior, remote_sha: queried, error: "divergence" };
  }
  return { prior_tracking_sha: prior, remote_sha: queried, error: null };
}

// --- ensure -----------------------------------------------------------------

function worktreePath(toplevel, primaryPath, profile, key) {
  if (profile?.worktree) return join(primaryPath, profile.worktree.root, key);
  return `${toplevel}-${key}`;
}

// The base a new branch starts at: the synchronized remote ref whenever this
// run proved it, otherwise the local branch. Never a bare branch name, so a
// stale local checkout cannot silently seed the task branch.
function creationBase(cwd, remote, base, syncResults, remoteConfigured) {
  if (remoteConfigured && syncResults?.[base]?.error === null && syncResults[base].remote_sha) {
    return `refs/remotes/${remote}/${base}`;
  }
  if (branchSha(cwd, base)) return `refs/heads/${base}`;
  return null;
}

// The task branch's own commits: those above its fork point — the newest
// commit of the base's first-parent history the branch contains. Counted from
// there, a branch already delivered by a --no-ff merge keeps its work, and a
// branch that never left the base counts 0. null when git cannot tell
// (no base ref, unrelated histories).
function priorCommits(cwd, keyRef, baseRef) {
  if (!baseRef) return null;
  const number = (res) => (res.ok && /^\d+$/.test(res.stdout) ? Number(res.stdout) : null);
  const behind = number(git(cwd, ["rev-list", "--count", "--first-parent", `${keyRef}..${baseRef}`], { allowFail: true }));
  if (behind === null) return null;
  const fork = git(cwd, ["rev-parse", "--verify", "--quiet", `${baseRef}~${behind}^{commit}`], { allowFail: true });
  if (!fork.ok || fork.stdout === "") return null;
  return number(git(cwd, ["rev-list", "--count", `${fork.stdout}..${keyRef}`], { allowFail: true }));
}

function ensureBranch(toplevel, branch, baseRef, actions) {
  if (branchSha(toplevel, branch)) return { created: false };
  const res = git(toplevel, ["branch", branch, baseRef], { allowFail: true });
  if (!res.ok) return { created: false, error: "branch_create_failed" };
  actions.push(`branch ${branch} <- ${baseRef}`);
  return { created: true };
}

function addWorktree(toplevel, path, branch, actions) {
  const res = git(toplevel, ["worktree", "add", path, branch], { allowFail: true });
  if (!res.ok) return { created: false, error: "worktree_create_failed" };
  actions.push(`worktree ${path} <- ${branch}`);
  return { created: true };
}

function ensureWorkspace({ toplevel, ensure, key, parentKey, base, remote, remoteConfigured, syncResults, gate, primary, worktrees }) {
  const profile = gate.profile;
  const actions = [];
  const empty = {
    workspace: null,
    placement: null,
    branch: key,
    head: null,
    base_ref: null,
    created_branch: false,
    created_worktree: false,
    ran_setup: false,
    prior_commits: null,
    actions,
  };

  if (!["develop", "review"].includes(ensure)) return { ...empty, error: "bad_ensure" };
  if (gate.error) {
    const { code, key: errorKey, path, template } = gate.error;
    return { ...empty, error: code, error_key: errorKey ?? null, error_path: path ?? null, ...(template ? { template } : {}) };
  }

  const syncFailed = Object.entries(syncResults ?? {}).find(([, value]) => value?.error);
  if (syncFailed) return { ...empty, error: syncFailed[1].error };

  const pinnedPlacement = Boolean(profile?.worktree);
  // Placement follows the task branch: the checkout holding it is the
  // workspace, the primary included.
  const checkedOutAt = (branch) => worktrees.find((tree) => tree.branch === branch)?.path ?? null;
  const placementOf = (path) => (path === primary.path ? "primary" : "worktree");

  // Subtask runs: the parent branch must exist first, and work always happens
  // in the dedicated parent worktree — one workspace per task, keyed by parent.
  let baseRef = null;
  let workspaceRoot = null;
  let createdWorktree = false;

  if (parentKey) {
    const parentBase =
      creationBase(toplevel, remote, parentKey, syncResults, remoteConfigured) ??
      creationBase(toplevel, remote, base, syncResults, remoteConfigured);
    if (!parentBase) return { ...empty, error: "base_missing" };
    const parentBranch = ensureBranch(toplevel, parentKey, parentBase, actions);
    if (parentBranch.error) return { ...empty, error: parentBranch.error };

    workspaceRoot = checkedOutAt(key) ?? checkedOutAt(parentKey);
    if (!workspaceRoot) {
      const pinned = worktreePath(toplevel, primary.path, profile, parentKey);
      const occupant = worktrees.find((tree) => tree.path === pinned);
      if (occupant) {
        // A finished subtask without `сливай` parks the parent worktree on
        // its branch. A clean checkout already merged into the parent is
        // adopted; anything else is reported with the parked branch so the
        // caller can route `<occupied_by> сливай`.
        const adoptable =
          occupant.clean &&
          occupant.branch &&
          occupant.branch !== "HEAD" &&
          branchSha(toplevel, occupant.branch) &&
          isAncestor(toplevel, occupant.branch, parentKey) === true;
        if (!adoptable) {
          return { ...empty, error: "parent_worktree_occupied", occupied_by: occupant.branch };
        }
        workspaceRoot = pinned;
      } else {
        workspaceRoot = pinned;
        const added = addWorktree(toplevel, workspaceRoot, parentKey, actions);
        if (added.error) return { ...empty, error: added.error };
        createdWorktree = added.created;
      }
    }
    baseRef = `refs/heads/${parentKey}`;
  }

  const branchExists = Boolean(branchSha(toplevel, key));
  const remoteBranch = trackingSha(toplevel, remote, key);
  const priorRef = branchExists ? `refs/heads/${key}` : remoteBranch ? `refs/remotes/${remote}/${key}` : null;
  const prior = priorRef
    ? priorCommits(toplevel, priorRef, parentKey ? `refs/heads/${parentKey}` : creationBase(toplevel, remote, base, syncResults, remoteConfigured))
    : 0;

  if (!branchExists) {
    if (ensure === "review" && !remoteBranch) return { ...empty, error: "review_requires_branch" };
    if (!baseRef) {
      baseRef = remoteBranch
        ? `refs/remotes/${remote}/${key}`
        : creationBase(toplevel, remote, base, syncResults, remoteConfigured);
    }
    if (!baseRef) return { ...empty, error: "base_missing" };
  }

  // Ordinary/parent runs place the branch per §6; subtask runs already own a
  // workspace and only switch the checked-out branch inside it. A profile
  // with a worktree block forbids task work in the primary checkout, so it
  // always takes the pinned worktree path.
  if (!workspaceRoot) {
    const existing = checkedOutAt(key);
    if (existing) {
      workspaceRoot = existing;
    } else if (primary.clean && !pinnedPlacement) {
      workspaceRoot = primary.path;
    } else {
      const created = ensureBranch(toplevel, key, baseRef ?? `refs/heads/${key}`, actions);
      if (created.error) return { ...empty, error: created.error };
      workspaceRoot = worktreePath(toplevel, primary.path, profile, key);
      const added = addWorktree(toplevel, workspaceRoot, key, actions);
      if (added.error) return { ...empty, error: added.error };
      createdWorktree = added.created;
    }
  }

  const placement = placementOf(workspaceRoot);
  const currentBranch = git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });

  if (currentBranch.stdout !== key) {
    // A switch would carry uncommitted changes onto the task branch, where
    // they would pass as run-owned: the checkout must be clean first.
    const state = worktrees.find((tree) => tree.path === workspaceRoot) ?? checkoutInfo(workspaceRoot);
    if (!state.clean) return { ...empty, workspace: workspaceRoot, placement, dirty_sample: state.dirty_sample, error: "workspace_dirty" };
    const args = branchSha(toplevel, key) ? ["checkout", key] : ["checkout", "-b", key, baseRef];
    const checkout = git(workspaceRoot, args, { allowFail: true });
    if (!checkout.ok) return { ...empty, workspace: workspaceRoot, placement, error: "checkout_failed" };
    actions.push(`checkout ${key}`);
  }

  const prepared = {
    workspace: workspaceRoot,
    placement,
    branch: key,
    head: git(workspaceRoot, ["rev-parse", "HEAD"], { allowFail: true }).stdout || null,
    base_ref: branchExists ? null : baseRef,
    created_branch: !branchExists,
    created_worktree: createdWorktree,
    ran_setup: false,
    prior_commits: prior,
    actions,
    error: null,
  };
  return prepared;
}

// --- environment ----------------------------------------------------------------

// A tree whose branch predates the project's ignore rules would show the
// dispatcher's files as untracked changes: the repository-local exclude
// file (shared by every checkout) takes the missing rules instead.
function excludeUntracked(workspace, paths, actions) {
  const missing = paths.filter((path) => !git(workspace, ["check-ignore", "-q", "--no-index", path], { allowFail: true }).ok);
  if (missing.length === 0) return;
  const exclude = git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { allowFail: true });
  if (!exclude.ok) return;
  execFileSync("mkdir", ["-p", dirname(exclude.stdout)]);
  appendFileSync(exclude.stdout, missing.map((path) => `/${path.replace(/\/+$/, "")}\n`).join(""));
  actions.push(`exclude ${missing.join(", ")}`);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function describeStage(gate, checkout, name, ports) {
  const vars = stageVars(gate.machine, name, ports, gate.profile.stage.scheme);
  return {
    name,
    kind: gate.profile.stage.start ? "start" : "compose",
    ports,
    url: vars.url,
    running: stageRunning({ gate, checkout, vars }),
    log: join(checkout, STAGE_LOG),
  };
}

function pendingMigrations(gate, checkout, name, ports, warnings) {
  const stage = gate.profile.stage;
  if (!stage?.migrations) return null;
  const vars = stageVars(gate.machine, name, ports, gate.profile.stage.scheme);
  const pending = runCommand(substitute(stage.migrations.pending, vars), { cwd: checkout, env: stageEnv(stage, vars), log: join(checkout, STAGE_LOG), capture: true });
  if (pending.code !== 0) {
    warnings.push("migrations_unavailable");
    return null;
  }
  return pending.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Prepares the chosen checkout per the profile and returns the environment
// facts; `error` stops the run with the tree preserved.
async function prepareEnvironment({ gate, prepared, key, parentKey, base, toplevel }) {
  const { profile, machine } = gate;
  const workspace = prepared.workspace;
  const primaryPath = gate.primary;
  const environment = {
    workspace,
    branch: prepared.branch,
    base: parentKey ?? base,
    placement: prepared.placement,
    created_worktree: prepared.created_worktree,
    stage: null,
    migrations_pending: null,
    warnings: [],
  };
  if (prepared.placement === "primary") {
    if (profile?.stage) {
      const ports = mainPorts(profile.stage, machine);
      environment.stage = describeStage(gate, workspace, MAIN_STAGE, ports);
      environment.migrations_pending = pendingMigrations(gate, workspace, MAIN_STAGE, ports, environment.warnings);
    }
    return { environment };
  }
  if (!profile?.worktree) return { environment };

  const actions = prepared.actions;
  const legacy = !prepared.created_worktree && !exists(join(workspace, LOCAL_DIR));
  let local = readTreeLocal(workspace) ?? {};
  if (prepared.created_worktree || legacy) {
    const { link, copy } = profile.worktree;
    excludeUntracked(workspace, [`${LOCAL_DIR}/`, ...link, ...copy], actions);
    for (const path of link) {
      const source = join(primaryPath, path);
      const target = join(workspace, path);
      if (exists(target)) continue;
      if (!exists(source)) {
        environment.warnings.push(`link_source_missing: ${path}`);
        continue;
      }
      execFileSync("mkdir", ["-p", dirname(target)]);
      symlinkSync(source, target);
      actions.push(`link ${path}`);
    }
    if (prepared.created_worktree) {
      for (const path of copy) {
        const source = join(primaryPath, path);
        const target = join(workspace, path);
        if (exists(target)) continue;
        if (!exists(source)) {
          environment.warnings.push(`copy_source_missing: ${path}`);
          continue;
        }
        cpSync(source, target, { recursive: true });
        actions.push(`copy ${path}`);
      }
    }
    local = {};
    if (profile.stage) {
      try {
        local = JSON.parse(readFileSync(join(primaryPath, LOCAL_FILE), "utf8"));
      } catch {
        local = {};
      }
      delete local.setup;
      delete local.stage;
    }
    if (legacy) local.setup = true;
  }
  const name = parentKey ?? key;
  if (profile.stage && !local.stage) {
    const checkouts = listCheckouts(toplevel);
    const ports = await allocatePorts({ stage: profile.stage, machine, checkouts, exceptPath: workspace });
    if (!ports) {
      // Keep .dreamteam/ so the next run finishes this tree instead of
      // taking it for a pre-4.0.0 one.
      writeTreeLocal(workspace, local);
      return { environment, error: "port_range_exhausted" };
    }
    local.stage = { name, ports, url: stageUrl(machine.host, Object.values(ports)[0], profile.stage.scheme) };
    actions.push(`stage ${name} ports ${Object.values(ports).join(",")}`);
  }
  writeTreeLocal(workspace, local);

  if (local.setup !== true) {
    prepared.ran_setup = true;
    for (const command of profile.worktree.setup) {
      if (runCommand(command, { cwd: workspace, log: join(workspace, SETUP_LOG) }).code !== 0) {
        return { environment, error: "setup_failed", log: join(workspace, SETUP_LOG) };
      }
    }
    local.setup = true;
    writeTreeLocal(workspace, local);
    actions.push("worktree setup");
  }

  if (profile.stage) {
    environment.stage = describeStage(gate, workspace, local.stage.name, local.stage.ports);
    environment.migrations_pending = pendingMigrations(gate, workspace, local.stage.name, local.stage.ports, environment.warnings);
  }
  return { environment };
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
  const { repo, key, parentKey, base = "main", remote = "origin", sync = false, ensure = null } = args ?? {};
  if (typeof repo !== "string" || repo === "" || typeof key !== "string" || key === "") {
    out({ ok: false, code: "bad_args" });
  }

  const toplevelRes = git(repo, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!toplevelRes.ok) out({ ok: false, code: "not_a_repo" });
  const toplevel = toplevelRes.stdout;

  const remotes = git(toplevel, ["remote"], { allowFail: true });
  const remoteConfigured = remotes.ok && remotes.stdout.split("\n").includes(remote);

  let worktrees = listWorktrees(toplevel);
  let primary = worktrees[0] ?? checkoutInfo(toplevel);

  const names = [...new Set([key, parentKey, base].filter((name) => typeof name === "string" && name !== ""))];
  const branches = {};
  const syncResults = {};
  for (const name of names) {
    if (sync && remoteConfigured) syncResults[name] = syncBranch(toplevel, remote, name);
    branches[name] = {
      local_sha: branchSha(toplevel, name),
      tracking_sha: trackingSha(toplevel, remote, name),
      checked_out_at: worktrees.find((w) => w.branch === name)?.path ?? null,
    };
  }

  const gate = loadEnvironment(toplevel);
  let prepared;
  let environment = null;

  if (ensure !== null) {
    prepared = ensureWorkspace({
      toplevel,
      ensure,
      key,
      parentKey,
      base,
      remote,
      remoteConfigured,
      syncResults: sync ? syncResults : {},
      gate,
      primary,
      worktrees,
    });
    if (prepared.error === null) {
      const prepare = await prepareEnvironment({ gate, prepared, key, parentKey, base, toplevel });
      environment = prepare.environment;
      if (prepare.error) {
        prepared.error = prepare.error;
        if (prepare.log) prepared.log = prepare.log;
      }
    }

    // Re-read the facts the mutation invalidated, so one call is enough.
    worktrees = listWorktrees(toplevel);
    primary = worktrees[0] ?? checkoutInfo(toplevel);
    for (const name of names) {
      branches[name] = {
        local_sha: branchSha(toplevel, name),
        tracking_sha: trackingSha(toplevel, remote, name),
        checked_out_at: worktrees.find((tree) => tree.branch === name)?.path ?? null,
      };
    }
  }

  const keyLocal = branches[key]?.local_sha ?? null;
  const parentLocal = parentKey ? branches[parentKey]?.local_sha ?? null : null;

  // Compact output: only the facts the Dispatcher reads.
  const tree = ({ path, branch, clean, dirty_sample }) =>
    (clean ? { path, branch, clean } : { path, branch, clean, dirty_sample });
  const { actions: _actions, ...preparedOut } = prepared ?? {};
  const syncErrors = Object.fromEntries(
    Object.entries(syncResults).filter(([, res]) => res?.error).map(([name, res]) => [name, { error: res.error }]));
  out({
    ok: true,
    profile: {
      present: gate.present,
      worktree_root: gate.profile?.worktree?.root ?? null,
      stage: Boolean(gate.profile?.stage),
      error: gate.error,
    },
    primary: tree(primary),
    worktrees: worktrees.slice(1).map(tree),
    remote: { name: remote, configured: remoteConfigured },
    branches: Object.fromEntries(Object.entries(branches).map(([name, b]) => [name, { checked_out_at: b.checked_out_at }])),
    sync: Object.keys(syncErrors).length ? syncErrors : undefined,
    prepared: prepared ? preparedOut : undefined,
    environment: environment ?? undefined,
    ancestry: { key_in_parent: parentKey ? isAncestor(toplevel, keyLocal, parentLocal) : null },
  });
}

main().catch(() => out({ ok: false, code: "inspect_error" }));
