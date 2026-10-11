#!/usr/bin/env node
// DreamTeam's half of the one-call startup probe: a dispatcher's own
// bootstrap runs it after its tracker probe and merges the two JSON lines
// into the one the project-manager role reads. Read-only: no network, no
// tracker, no Git mutation, no writes but the run directory.
// Input: single CLI arg — JSON:
//   {runtime:"codex"|"claude", projectRoot, repo?, key?, model?, modelsCachePath?,
//    defaults?: {base?, delivery?, returns?}, tracker?: {kind, label?}}
// `model` is the per-run override from the `модель <значение>` token;
// `defaults` are the adapter's policy defaults; `tracker` names the dispatcher
// for the profile's tracker check; `modelsCachePath` overrides the Codex
// models cache location (diagnostics/tests only).
// Output: one JSON line; always exit 0. A missing or invalid profile is data;
// the role decides to block.
//
// `models` — the resolved launch table, one {model, effort} pair per row
// (research, research_xs … research_xl, research_ultra, developer_xs …
// developer_xl, developer_ultra, reviewer_depth_1 … reviewer_depth_5,
// reviewer_ultra). Default models per row (ROW_MODELS: Claude — sonnet up to
// size M, opus above and for `ультра`, opus for research, sonnet then opus up
// the review depth; Codex — gpt-6.1-sol for every developer and research row,
// gpt-6-sol for review but depth 5, gpt-6-astra; the `*_ultra` rows are the
// only ones at the top effort, chosen by the `ультра` token alone); an
// override fills every row verbatim. `spawn_args` — the ready launcher
// parameters per launch row (every row but research, which the PRD skill
// launches itself): Codex {fork_turns: "none", model, reasoning_effort} with
// `model` absent when inherited; Claude {model} — its effort is a prompt
// phrase, not a launcher parameter, and stays in `models`. Codex pairs are
// checked against ~/.codex/models_cache.json: efforts clamp to the model's
// supported levels; a default absent from a readable cache degrades to
// model: null (= inherit the session model) with warning_reason
// "ceiling_not_in_models_cache"; an absent override keeps the value with
// "override_not_in_models_cache"; an unreadable cache keeps constants as-is.
// Model and effort are launcher parameters — a request, never a launch gate.
//
// `profile` — the project profile gate (contracts/validate-profile.mjs through
// lib/profile.mjs): presence, blocks, machine settings, git-ignore checks, the
// first blocker; `profile.checks` — the QA gate is declared in the primary
// checkout or on the task branch <key>. `policy` — base, delivery, returns
// resolved profile → adapter defaults → DreamTeam defaults, `base` falling
// back to the repository's default branch. `tracker` — the profile's tracker
// block against the dispatcher and the key, problems in the words the role
// prints. `references` — the terminology document as an absolute path when
// the profile names one and the file exists.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkItems, profileProblems, resolvePolicy, trackerProblems } from "../../../contracts/validate-profile.mjs";
import { loadEnvironment } from "./lib/profile.mjs";

const ROLES = ["product-technologist", "software-developer", "qa-engineer", "code-reviewer", "project-manager"];

// Role-model policy: one default model per launch row. Development runs at the
// task size: Codex always the same model, Claude sonnet then opus, the thinking
// level rising with the size; the top effort is reserved for the `*_ultra`
// rows. The PRD research children (rows `research` for an unsettled size —
// medium — and `research_<size>`) run on that coding model — a weaker rung
// fabricated paths in practice. Review runs at the depth review-pack --check
// reports: 1 buys the cheapest pair, 5 the priciest; Codex reaches gpt-6-astra
// only at 5. Fable stays off the Claude table deliberately: an unproven
// upgrade over opus for this work.
const ROW_MODELS = Object.freeze({
  claude: Object.freeze({
    research: "opus",
    research_xs: "opus",
    research_s: "opus",
    research_m: "opus",
    research_l: "opus",
    research_xl: "opus",
    research_ultra: "opus",
    developer_xs: "sonnet",
    developer_s: "sonnet",
    developer_m: "sonnet",
    developer_l: "opus",
    developer_xl: "opus",
    developer_ultra: "opus",
    reviewer_depth_1: "sonnet",
    reviewer_depth_2: "sonnet",
    reviewer_depth_3: "opus",
    reviewer_depth_4: "opus",
    reviewer_depth_5: "opus",
    reviewer_ultra: "opus",
  }),
  codex: Object.freeze({
    research: "gpt-6.1-sol",
    research_xs: "gpt-6.1-sol",
    research_s: "gpt-6.1-sol",
    research_m: "gpt-6.1-sol",
    research_l: "gpt-6.1-sol",
    research_xl: "gpt-6.1-sol",
    research_ultra: "gpt-6.1-sol",
    developer_xs: "gpt-6.1-sol",
    developer_s: "gpt-6.1-sol",
    developer_m: "gpt-6.1-sol",
    developer_l: "gpt-6.1-sol",
    developer_xl: "gpt-6.1-sol",
    developer_ultra: "gpt-6.1-sol",
    reviewer_depth_1: "gpt-6-sol",
    reviewer_depth_2: "gpt-6-sol",
    reviewer_depth_3: "gpt-6-sol",
    reviewer_depth_4: "gpt-6-sol",
    reviewer_depth_5: "gpt-6-astra",
    reviewer_ultra: "gpt-6-astra",
  }),
});

// Requested efforts per row; Claude values are prompt phrases (null: no
// phrase), Codex values are spawn reasoning levels.
const EFFORTS = Object.freeze({
  claude: Object.freeze({
    research: "think",
    research_xs: "think",
    research_s: "think",
    research_m: "think hard",
    research_l: "think hard",
    research_xl: "think harder",
    research_ultra: "ultrathink",
    developer_xs: null,
    developer_s: "think",
    developer_m: "think hard",
    developer_l: "think hard",
    developer_xl: "think harder",
    developer_ultra: "ultracode",
    reviewer_depth_1: null,
    reviewer_depth_2: "think hard",
    reviewer_depth_3: null,
    reviewer_depth_4: "think hard",
    reviewer_depth_5: "think harder",
    reviewer_ultra: "ultrathink",
  }),
  codex: Object.freeze({
    research: "medium",
    research_xs: "medium",
    research_s: "medium",
    research_m: "high",
    research_l: "xhigh",
    research_xl: "xhigh",
    research_ultra: "ultra",
    developer_xs: "medium",
    developer_s: "medium",
    developer_m: "high",
    developer_l: "xhigh",
    developer_xl: "xhigh",
    developer_ultra: "ultra",
    reviewer_depth_1: "medium",
    reviewer_depth_2: "high",
    reviewer_depth_3: "xhigh",
    reviewer_depth_4: "xhigh",
    reviewer_depth_5: "xhigh",
    reviewer_ultra: "ultra",
  }),
});

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function readCodexCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!Array.isArray(parsed?.models)) return null;
    const supported = new Map();
    for (const entry of parsed.models) {
      if (typeof entry?.slug !== "string") continue;
      const levels = (entry.supported_reasoning_levels ?? [])
        .map((level) => level?.effort)
        .filter((effort) => EFFORT_ORDER.includes(effort));
      supported.set(entry.slug, levels);
    }
    return supported;
  } catch {
    return null;
  }
}

function clampEffort(requested, supportedLevels) {
  if (supportedLevels.includes(requested)) return requested;
  const requestedRank = EFFORT_ORDER.indexOf(requested);
  const below = supportedLevels
    .filter((level) => EFFORT_ORDER.indexOf(level) < requestedRank)
    .sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a));
  return below[0] ?? supportedLevels[0] ?? requested;
}

export function resolveModels(runtime, override, modelsCachePath) {
  const source = override ? "override" : "default_ceiling";
  const efforts = EFFORTS[runtime];
  const cache = runtime === "codex"
    ? readCodexCache(modelsCachePath ?? join(homedir(), ".codex", "models_cache.json"))
    : null;
  let warning = null;
  const rows = {};

  for (const [row, requested] of Object.entries(efforts)) {
    let model = override ?? ROW_MODELS[runtime][row];
    let levels = null;
    if (cache !== null && cache.has(model)) {
      levels = cache.get(model);
    } else if (cache !== null && override) {
      warning = "override_not_in_models_cache";
    } else if (cache !== null) {
      // The default is missing from the cache: inherit the session model.
      if (!row.startsWith("research")) warning = "ceiling_not_in_models_cache";
      model = null;
    }
    rows[row] = { model, effort: levels ? clampEffort(requested, levels) : requested };
  }
  return { source, warning_reason: warning, ...rows };
}

// The launcher parameters the role passes verbatim, one object per row it
// launches itself — copying a ready object leaves nothing to omit. An
// inherited model (null) is an absent key, never `model: null`.
export function spawnArgs(runtime, models) {
  const args = {};
  for (const row of Object.keys(EFFORTS[runtime])) {
    if (row.startsWith("research")) continue;
    const { model, effort } = models[row];
    const withModel = model === null ? {} : { model };
    args[row] = runtime === "codex"
      ? { fork_turns: "none", ...withModel, reasoning_effort: effort }
      : withModel;
  }
  return args;
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// The task branch may already carry the gate a developer declared in it
// (modifier `гейт`) before the primary checkout does.
function branchDeclaresChecks(toplevel, key) {
  if (typeof key !== "string" || key === "") return false;
  const text = git(toplevel, ["show", `refs/heads/${key}:dreamteam.json`]);
  if (text === null) return false;
  try {
    const raw = JSON.parse(text);
    return raw?.checks !== undefined && profileProblems(raw).length === 0 && checkItems(raw).length > 0;
  } catch {
    return false;
  }
}

// The repository's own default branch: origin/HEAD, else main, else master,
// else the current branch.
function defaultBranch(toplevel) {
  const head = git(toplevel, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["main", "master"]) if (git(toplevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null) return name;
  return git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function profileReport(toplevel, key) {
  if (toplevel === null) return { gate: null, report: { present: false, worktree: false, stage: false, checks: false, local_config: false, ignored: null, error: null, tracker: null, references: { terminology: null } } };
  const gate = loadEnvironment(toplevel);
  return {
    gate,
    report: {
      present: gate.present,
      worktree: Boolean(gate.profile?.worktree),
      stage: Boolean(gate.profile?.stage),
      checks: Boolean(gate.profile?.checks?.length) || branchDeclaresChecks(toplevel, key),
      local_config: gate.local_config,
      ignored: gate.ignored,
      error: gate.error,
      tracker: gate.profile?.tracker ?? null,
      references: gate.profile?.references ?? { terminology: null },
    },
  };
}

// One directory per run under the OS temp dir: the resolution's files, the
// packet and the role packs land there, and it stays after the run for
// inspection. The key segment keeps runs of different items apart.
function createRunDir(key) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(tmpdir(), "dream-team", typeof key === "string" && key !== "" ? key : "no-key", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const optional = (path) => (existsSync(path) ? path : null);

const USAGE = `bootstrap.mjs — DreamTeam's half of the one-call startup probe. Read-only.
Arg: single JSON:
 {runtime:"codex"|"claude", projectRoot, repo?, key?, model?, modelsCachePath?,
  defaults?: {base?, delivery?, returns?}, tracker?: {kind, label?}}
model — the per-run override from the "модель <значение>" token; defaults —
the adapter's policy defaults; tracker — the dispatcher's kind and label.
Output: one JSON line {ok, version, plugin_root, roles{present, missing},
scripts{prepare_worktree, stage, deliver, assignment, adapter_file, validate_profile,
validate_adapter, validate_assignment, review_pack, mockup_render, agent_usage},
run_dir, repo{toplevel, current_branch, default_branch}, profile{present, worktree,
stage, checks, local_config, ignored, error{code, key, detail}|null, tracker, references},
policy{base, delivery, returns, source}, tracker{declared, kind, prefix, problems[]},
references{terminology}, references_missing[], models (launch table {model, effort}
per row: research, research_xs … research_xl, research_ultra, developer_xs …
developer_xl, developer_ultra, reviewer_depth_1 … reviewer_depth_5, reviewer_ultra),
spawn_args (ready launcher parameters per launch row, passed verbatim: codex
{fork_turns, model?, reasoning_effort} — model absent = inherit the session model;
claude {model}, the effort phrase stays in models)}.
ok:false codes: bad_args | bootstrap_error.
`;

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
  const { runtime, projectRoot, repo, model, modelsCachePath, key, defaults, tracker } = args ?? {};
  if (!["codex", "claude"].includes(runtime) || typeof projectRoot !== "string" || projectRoot === "") {
    out({ ok: false, code: "bad_args" });
  }
  const repoPath = typeof repo === "string" && repo !== "" ? repo : projectRoot;
  const modelOverride = typeof model === "string" && model !== "" ? model : null;
  const cachePathOverride = typeof modelsCachePath === "string" && modelsCachePath !== "" ? modelsCachePath : null;

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = resolve(scriptsDir, "..", "..", "..");
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version ?? null;
  } catch {
    version = null;
  }
  const present = ROLES.filter((role) => existsSync(join(pluginRoot, "skills", role, "SKILL.md")));

  const toplevel = git(repoPath, ["rev-parse", "--show-toplevel"]);
  const { gate, report } = profileReport(toplevel, key);
  const policy = resolvePolicy(gate?.profile ?? null, defaults ?? {});
  if (policy.base === null && toplevel) { policy.base = defaultBranch(toplevel); policy.source.base = "repository"; }
  const terminology = report.references?.terminology ?? null;
  const terminologyPath = terminology && toplevel ? join(toplevel, terminology) : null;
  const models = resolveModels(runtime, modelOverride, cachePathOverride);

  const runDir = createRunDir(key);
  const line = {
    ok: true,
    version,
    plugin_root: pluginRoot,
    roles: { present, missing: ROLES.filter((role) => !present.includes(role)) },
    scripts: {
      prepare_worktree: join(scriptsDir, "prepare-worktree.mjs"),
      stage: join(scriptsDir, "stage.mjs"),
      deliver: join(scriptsDir, "deliver.mjs"),
      assignment: join(scriptsDir, "assignment.mjs"),
      adapter_file: join(scriptsDir, "adapter-file.mjs"),
      validate_profile: join(pluginRoot, "contracts", "validate-profile.mjs"),
      validate_adapter: join(pluginRoot, "contracts", "validate-adapter.mjs"),
      validate_assignment: join(pluginRoot, "contracts", "validate-assignment.mjs"),
      review_pack: optional(join(pluginRoot, "skills", "code-reviewer", "scripts", "review-pack.mjs")),
      mockup_render: optional(join(pluginRoot, "skills", "product-technologist", "scripts", "mockup-render.mjs")),
      agent_usage: optional(join(pluginRoot, "skills", "agent-usage", "scripts", "agent-usage.mjs")),
    },
    run_dir: runDir,
    repo: {
      toplevel,
      current_branch: toplevel ? git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]) : null,
      default_branch: toplevel ? defaultBranch(toplevel) : null,
    },
    profile: report,
    policy,
    tracker: {
      declared: report.tracker !== null,
      kind: report.tracker?.kind ?? null,
      prefix: report.tracker?.prefix ?? null,
      problems: trackerProblems(gate?.profile ?? null, { kind: tracker?.kind ?? null, caller: tracker?.label ?? null, key: typeof key === "string" ? key : null }),
    },
    references: { terminology: terminologyPath && existsSync(terminologyPath) ? terminologyPath : null },
    references_missing: terminology && !(terminologyPath && existsSync(terminologyPath)) ? ["terminology"] : [],
    models,
    spawn_args: spawnArgs(runtime, models),
  };
  // A compacted context loses this line; the run directory keeps it.
  try { writeFileSync(join(runDir, "bootstrap.json"), `${JSON.stringify(line, null, 1)}\n`); } catch { /* the line below is the report */ }
  out(line);
}

try {
  main();
} catch {
  out({ ok: false, code: "bootstrap_error" });
}
