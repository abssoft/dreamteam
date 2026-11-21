#!/usr/bin/env node
// One-call startup probe of the `tracker` dispatcher — the file tracker that
// keeps the items in the primary checkout's `.dreamteam/tasks/`, outside git:
// the tracker half (the key prefix from the project's `.env`, the git-ignore
// gate of `.dreamteam/`, the adapter manifest) merged with DreamTeam's half
// (skills/project-manager/scripts/bootstrap.mjs: run_dir, scripts, profile,
// policy, tracker check, references, models, spawn_args). Read-only but the
// run directory: no network, no Git mutation.
// Input: single CLI arg — JSON {runtime:"codex"|"claude", projectRoot, repo?, key?, model?, modelsCachePath?}
// Output: one JSON line; always exit 0. Setup gaps are data (`setup`); the
// dispatcher decides to stop.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_DIR, ignored, listCheckouts } from "../../project-manager/scripts/lib/profile.mjs";

const LABEL = "tracker";
const KIND = "file";
const PREFIX_VAR = "DREAMTEAM_TASKS_PREFIX";
const PREFIX = /^[A-Z][A-Z0-9]*$/;
const KEY = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;
const INVOKE = { claude: "/dream-team:tracker", codex: "$tracker" };
const MODES = [{ token: "бэклог", aliases: ["backlog", "список"], summary: "все задачи файлового трекера по стадиям" }];
const HELP = ["$tracker бэклог — все задачи по стадиям"];

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

// `NAME=value` lines; the file is never sourced. Only the prefix is read.
function readPrefix(envPath) {
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] === PREFIX_VAR) return match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return null;
}

function dreamTeamProbe({ runtime, projectRoot, repo, key, model, modelsCachePath }) {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "project-manager", "scripts", "bootstrap.mjs");
  try {
    const line = execFileSync(process.execPath, [script, JSON.stringify({ runtime, projectRoot, repo, key, model, modelsCachePath, defaults: {}, tracker: { kind: KIND, label: LABEL } })], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const answer = JSON.parse(line.trim().split("\n").pop());
    return answer.ok ? answer : null;
  } catch {
    return null;
  }
}

const USAGE = `bootstrap.mjs — one-call startup probe of the tracker dispatcher (SKILL.md Pipeline). Read-only.
Arg: single JSON {runtime:"codex"|"claude", projectRoot, repo?, key?, model?, modelsCachePath?}
Output: one JSON line {ok, setup (null, or {code: no_repository | store_not_ignored |
prefix_missing | prefix_invalid, path, add, explanation} — the dispatcher stops and
shows it), problems[] (the key against the prefix), store{root (<primary>/.dreamteam/tasks),
ignored}, env{path, prefix}, invoke, manifest (the Tracker Adapter v1 manifest written
into run_dir), run_dir, scripts{adapter, bootstrap + DreamTeam's}, workflow, repo,
profile, policy, tracker, references, references_missing, models, spawn_args,
dream_team{version, plugin_root, roles}} — DreamTeam's half is null when its probe fails.
ok:false codes: bad_args | bootstrap_error.
`;

function main() {
  if (["--usage", "--help", "-h"].includes(process.argv[2])) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  let args;
  try { args = JSON.parse(process.argv[2] ?? ""); } catch { out({ ok: false, code: "bad_args" }); }
  const { runtime, projectRoot, repo, key, model, modelsCachePath } = args ?? {};
  if (!["codex", "claude"].includes(runtime) || typeof projectRoot !== "string" || projectRoot === "") out({ ok: false, code: "bad_args" });
  const repoPath = typeof repo === "string" && repo !== "" ? repo : projectRoot;
  const scriptsDir = dirname(fileURLToPath(import.meta.url));

  // The items, the .env and the workflow live in the primary checkout, so a
  // command from any worktree sees the same tracker.
  const primary = listCheckouts(repoPath)[0]?.path ?? null;
  const storeRoot = primary ? join(primary, LOCAL_DIR, "tasks") : null;
  const storeIgnored = primary ? ignored(primary, `${LOCAL_DIR}/`) : false;
  const envPath = primary ? join(primary, ".env") : null;
  const prefix = envPath ? readPrefix(envPath) : null;
  const template = `${PREFIX_VAR}=DT`;
  let setup = null;
  if (!primary) setup = { code: "no_repository", path: projectRoot, add: null, explanation: "Файловый трекер живёт в git-репозитории проекта: запусти команду из его чекаута." };
  else if (!storeIgnored) setup = { code: "store_not_ignored", path: join(primary, ".gitignore"), add: `${LOCAL_DIR}/`, explanation: `Задачи лежат в ${LOCAL_DIR}/tasks/ вне git: добавь строку ${LOCAL_DIR}/ в .gitignore основного чекаута.` };
  else if (prefix === null) setup = { code: "prefix_missing", path: envPath, add: template, explanation: `Префикс ключей задач (DT → DT-1, DT-2…) берётся из ${PREFIX_VAR} в .env основного чекаута.` };
  else if (!PREFIX.test(prefix)) setup = { code: "prefix_invalid", path: envPath, add: template, explanation: `${PREFIX_VAR} — заглавные латинские буквы и цифры, первой идёт буква.` };

  const problems = [];
  if (setup === null && typeof key === "string" && key !== "" && key.match(KEY)?.[1] !== prefix) problems.push(`Ключ ${key} не из этого трекера: префикс задач проекта — ${prefix}`);

  const dt = dreamTeamProbe({ runtime, projectRoot, repo: repoPath, key, model: typeof model === "string" && model !== "" ? model : undefined, modelsCachePath: typeof modelsCachePath === "string" && modelsCachePath !== "" ? modelsCachePath : undefined });
  const runDir = dt?.run_dir ?? null;
  let manifest = null;
  if (runDir && storeRoot) {
    manifest = join(runDir, "adapter.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(manifest, `${JSON.stringify({
      contract_version: 1,
      kind: KIND,
      label: LABEL,
      command: `node "${join(scriptsDir, "adapter.mjs")}" --root "${storeRoot}"${prefix && PREFIX.test(prefix) ? ` --prefix "${prefix}"` : ""}`,
      operations: ["resolve", "publish", "prd", "create", "attach", "comment", "close"],
      modes: MODES,
      help: HELP,
    }, null, 2)}\n`);
  }

  out({
    ok: true,
    setup,
    problems,
    store: { root: storeRoot, ignored: storeIgnored },
    env: { path: envPath, prefix: prefix && PREFIX.test(prefix) ? prefix : null },
    invoke: INVOKE[runtime],
    manifest,
    run_dir: runDir,
    scripts: { ...(dt?.scripts ?? {}), adapter: join(scriptsDir, "adapter.mjs"), bootstrap: join(scriptsDir, "bootstrap.mjs") },
    workflow: dt?.workflow ?? null,
    repo: dt?.repo ?? null,
    profile: dt?.profile ?? null,
    policy: dt?.policy ?? null,
    tracker: dt?.tracker ?? null,
    references: dt?.references ?? { terminology: null },
    references_missing: dt?.references_missing ?? [],
    models: dt?.models ?? null,
    spawn_args: dt?.spawn_args ?? null,
    dream_team: dt ? { version: dt.version, plugin_root: dt.plugin_root, roles: dt.roles } : null,
  });
}

try {
  main();
} catch {
  out({ ok: false, code: "bootstrap_error" });
}
