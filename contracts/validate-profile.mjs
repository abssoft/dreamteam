#!/usr/bin/env node
// The executable side of the Project Profile v1 contract (dreamteam.json at
// the repository root). The project-manager role runs it in preflight; the
// role scripts (lib/profile.mjs, qa-run.mjs) import the same judgement so the
// file is read one way everywhere. Zero dependencies, read-only.
//   node validate-profile.mjs --profile <path|-> [--defaults '<json>'] [--tracker <kind>] [--caller <label>] [--key <KEY>]
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, profile (normalized), policy{base, delivery, returns, source{…}},
//               checks: [{run, baseline, diagnostic}], tracker{declared, kind, prefix,
//               problems: [text]}, references{terminology}}
//   ok:false → {ok, code, detail}: bad_args | bad_profile (detail lists every problem,
//               in Russian, each naming the key)
// Beyond the JSON Schema (profile-v1.schema.json): a key inside `tracker` that
// looks like a secret is refused; `diagnostic` must compile and carry a named
// group `file`; `stage` needs `worktree` and exactly one of `start` or the
// `up`/`down`/`status` trio. The tracker check (`--tracker`, `--key`) never
// fails the file: its problems ride in `tracker.problems`, in the words the
// role prints, and a profile without a tracker block passes with none.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROFILE_FILE = "dreamteam.json";
export const PROFILE_KEYS = ["version", "tracker", "base", "delivery", "returns", "references", "checks", "worktree", "stage"];
export const DELIVERY_MODES = ["merge_push", "branch"];
export const BASELINE_MODES = ["files_outside_diff"];
export const REFERENCE_KEYS = ["terminology"];
// DreamTeam's own defaults: the last rung of profile → adapter → DreamTeam.
export const DEFAULTS = Object.freeze({ base: null, delivery: "branch", returns: 2 });
const SECRET_KEY = /token|secret|passw|api[_-]?key|credential|private[_-]?key/i;
const MAX_RETURNS = 20;

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isList = (value) => Array.isArray(value) && value.every(isText);
const safeRelative = (value) => isText(value) && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");
const branchName = (value) => isText(value) && !/^-|\.\.|[\s~^:?*[\\]/.test(value);

function unknownKeys(object, allowed, prefix) {
  return Object.keys(object).filter((key) => !allowed.includes(key)).map((key) => `${PROFILE_FILE}: неизвестный ключ ${prefix}${key}`);
}

function secretKeys(object, prefix) {
  const found = [];
  for (const [key, value] of Object.entries(object)) {
    if (SECRET_KEY.test(key)) found.push(`${PROFILE_FILE}: ключ ${prefix}${key} похож на секрет; секреты живут в .env`);
    if (isObject(value)) found.push(...secretKeys(value, `${prefix}${key}.`));
  }
  return found;
}

function diagnosticProblem(pattern, label) {
  if (!isText(pattern)) return `${PROFILE_FILE}: ${label}.diagnostic — непустая регулярка с группой (?<file>…)`;
  try {
    const regex = new RegExp(pattern, "m");
    if (!/\(\?<file>/.test(pattern)) return `${PROFILE_FILE}: ${label}.diagnostic — нужна именованная группа (?<file>…)`;
    regex.test("");
    return null;
  } catch (error) {
    return `${PROFILE_FILE}: ${label}.diagnostic — регулярка не компилируется (${error.message})`;
  }
}

// Every violated rule, in order; an empty list means the file is a profile.
export function profileProblems(raw) {
  if (!isObject(raw)) return [`${PROFILE_FILE}: ожидается объект`];
  const problems = unknownKeys(raw, PROFILE_KEYS, "");
  if (raw.version !== 1) problems.push(`${PROFILE_FILE}: version должен быть 1`);
  if (raw.tracker !== undefined) {
    if (!isObject(raw.tracker)) problems.push(`${PROFILE_FILE}: tracker должен быть объектом`);
    else {
      if (raw.tracker.kind !== undefined && !(isText(raw.tracker.kind) && /^[a-z][a-z0-9_-]*$/.test(raw.tracker.kind))) problems.push(`${PROFILE_FILE}: tracker.kind — имя трекера строчными буквами`);
      if (raw.tracker.prefix !== undefined && !(isText(raw.tracker.prefix) && /^[A-Z][A-Z0-9]*$/.test(raw.tracker.prefix))) problems.push(`${PROFILE_FILE}: tracker.prefix — префикс ключей заглавными буквами`);
      problems.push(...secretKeys(raw.tracker, "tracker."));
    }
  }
  if (raw.base !== undefined && !branchName(raw.base)) problems.push(`${PROFILE_FILE}: base — имя ветки`);
  if (raw.delivery !== undefined && !DELIVERY_MODES.includes(raw.delivery)) problems.push(`${PROFILE_FILE}: delivery принимает ${DELIVERY_MODES.join(" или ")}, получено ${JSON.stringify(raw.delivery)}`);
  if (raw.returns !== undefined && !(Number.isInteger(raw.returns) && raw.returns >= 0 && raw.returns <= MAX_RETURNS)) problems.push(`${PROFILE_FILE}: returns — целое число от 0 до ${MAX_RETURNS}`);
  if (raw.references !== undefined) {
    if (!isObject(raw.references)) problems.push(`${PROFILE_FILE}: references должен быть объектом`);
    else {
      problems.push(...unknownKeys(raw.references, REFERENCE_KEYS, "references."));
      if (raw.references.terminology !== undefined && !safeRelative(raw.references.terminology)) problems.push(`${PROFILE_FILE}: references.terminology — относительный путь внутри репозитория`);
    }
  }
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks) || raw.checks.length === 0) problems.push(`${PROFILE_FILE}: checks — непустой список команд`);
    else {
      raw.checks.forEach((item, index) => {
        const label = `checks[${index}]`;
        if (isText(item)) return;
        if (!isObject(item)) { problems.push(`${PROFILE_FILE}: ${label} — команда строкой или объект {run, baseline, diagnostic, paths}`); return; }
        problems.push(...unknownKeys(item, ["run", "baseline", "diagnostic", "paths"], `${label}.`));
        if (!isText(item.run)) problems.push(`${PROFILE_FILE}: ${label}.run — команда`);
        if (item.paths !== undefined) {
          if (!isText(item.paths)) problems.push(`${PROFILE_FILE}: ${label}.paths — регулярка путей изменения`);
          else {
            try { new RegExp(item.paths); } catch (error) { problems.push(`${PROFILE_FILE}: ${label}.paths — регулярка не компилируется (${error.message})`); }
          }
        }
        if (isText(item.run) && item.run.includes("{paths}") && !isText(item.paths)) problems.push(`${PROFILE_FILE}: ${label}.run с {paths} требует paths`);
        if (item.baseline !== undefined && !BASELINE_MODES.includes(item.baseline)) problems.push(`${PROFILE_FILE}: ${label}.baseline принимает ${BASELINE_MODES.join(" или ")}`);
        if (item.baseline !== undefined && item.diagnostic === undefined) problems.push(`${PROFILE_FILE}: ${label}.baseline требует diagnostic`);
        if (item.diagnostic !== undefined) { const problem = diagnosticProblem(item.diagnostic, label); if (problem) problems.push(problem); }
      });
    }
  }
  const worktree = raw.worktree;
  if (worktree !== undefined) {
    if (!isObject(worktree)) problems.push(`${PROFILE_FILE}: worktree должен быть объектом`);
    else {
      problems.push(...unknownKeys(worktree, ["root", "link", "copy", "setup"], "worktree."));
      if (!safeRelative(worktree.root)) problems.push(`${PROFILE_FILE}: worktree.root — относительный путь внутри репозитория`);
      for (const list of ["link", "copy"]) {
        if (worktree[list] !== undefined && !(isList(worktree[list]) && worktree[list].every(safeRelative))) problems.push(`${PROFILE_FILE}: worktree.${list} — список относительных путей`);
      }
      if (worktree.setup !== undefined && !isList(worktree.setup)) problems.push(`${PROFILE_FILE}: worktree.setup — список команд`);
    }
  }
  const stage = raw.stage;
  if (stage !== undefined) {
    if (!isObject(stage)) problems.push(`${PROFILE_FILE}: stage должен быть объектом`);
    else {
      problems.push(...unknownKeys(stage, ["ports", "scheme", "start", "up", "down", "status", "health", "env", "migrations", "cleanup"], "stage."));
      if (worktree === undefined) problems.push(`${PROFILE_FILE}: stage требует блок worktree`);
      const ports = stage.ports;
      if (!Array.isArray(ports) || ports.length === 0 || !ports.every((slot) => typeof slot === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(slot)) || new Set(ports).size !== ports.length) problems.push(`${PROFILE_FILE}: stage.ports — уникальные имена слотов`);
      const compose = ["up", "down", "status"].filter((key) => stage[key] !== undefined);
      if (stage.start !== undefined) {
        if (!isText(stage.start)) problems.push(`${PROFILE_FILE}: stage.start — команда`);
        if (compose.length) problems.push(`${PROFILE_FILE}: stage.${compose[0]} несовместим со stage.start`);
      } else if (compose.length === 0) problems.push(`${PROFILE_FILE}: stage.start или stage.up/down/status`);
      else {
        const missing = ["up", "down", "status"].find((key) => !isText(stage[key]));
        if (missing) problems.push(`${PROFILE_FILE}: stage.${missing} — команда`);
      }
      if (stage.scheme !== undefined && stage.scheme !== "http" && stage.scheme !== "https") problems.push(`${PROFILE_FILE}: stage.scheme — http или https`);
      if (typeof stage.health !== "string" || !stage.health.startsWith("/")) problems.push(`${PROFILE_FILE}: stage.health — путь, начинающийся с /`);
      if (stage.env !== undefined && !(isObject(stage.env) && Object.entries(stage.env).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string"))) problems.push(`${PROFILE_FILE}: stage.env — переменные со строковыми значениями`);
      if (stage.migrations !== undefined) {
        if (!isObject(stage.migrations)) problems.push(`${PROFILE_FILE}: stage.migrations должен быть объектом`);
        else {
          problems.push(...unknownKeys(stage.migrations, ["pending", "apply"], "stage.migrations."));
          for (const key of ["pending", "apply"]) if (!isText(stage.migrations[key])) problems.push(`${PROFILE_FILE}: stage.migrations.${key} — команда`);
        }
      }
      if (stage.cleanup !== undefined && !isList(stage.cleanup)) problems.push(`${PROFILE_FILE}: stage.cleanup — список команд`);
    }
  }
  return problems;
}

// The check items as the QA role runs them: {run, baseline, diagnostic} and,
// for an item bound to the paths of the change, `paths`.
export function checkItems(raw) {
  if (!Array.isArray(raw?.checks)) return [];
  return raw.checks.map((item) => (isText(item)
    ? { run: item.trim(), baseline: null, diagnostic: null }
    : { run: String(item.run ?? "").trim(), baseline: item.baseline ?? null, diagnostic: item.diagnostic ?? null, ...(item.paths !== undefined ? { paths: item.paths } : {}) }));
}

// The profile with every optional block filled in; only for a file that
// passed profileProblems.
export function normalizeProfile(raw) {
  const worktree = raw.worktree ? { root: raw.worktree.root, link: raw.worktree.link ?? [], copy: raw.worktree.copy ?? [], setup: raw.worktree.setup ?? [] } : null;
  const stage = raw.stage ? { ...raw.stage, scheme: raw.stage.scheme ?? "http", env: raw.stage.env ?? {}, cleanup: raw.stage.cleanup ?? [] } : null;
  return {
    version: 1,
    tracker: raw.tracker ? { ...raw.tracker } : null,
    base: raw.base ?? null,
    delivery: raw.delivery ?? null,
    returns: raw.returns ?? null,
    references: { terminology: raw.references?.terminology ?? null },
    checks: raw.checks ? checkItems(raw) : null,
    worktree,
    stage,
  };
}

// profile → adapter defaults → DreamTeam defaults, with the rung each value
// came from. `base` stays null past every rung: the caller takes the
// repository's default branch then.
export function resolvePolicy(profile, adapterDefaults = {}) {
  const policy = {};
  const source = {};
  for (const key of ["base", "delivery", "returns"]) {
    if (profile?.[key] !== null && profile?.[key] !== undefined) { policy[key] = profile[key]; source[key] = "profile"; }
    else if (adapterDefaults?.[key] !== null && adapterDefaults?.[key] !== undefined) { policy[key] = adapterDefaults[key]; source[key] = "adapter"; }
    else { policy[key] = DEFAULTS[key]; source[key] = DEFAULTS[key] === null ? "repository" : "dream-team"; }
  }
  return { ...policy, source };
}

// The tracker block against the dispatcher that invoked the role and the key
// of the command. Problems in the words the role prints; none for a profile
// without the block.
export function trackerProblems(profile, { kind = null, caller = null, key = null } = {}) {
  const declared = profile?.tracker;
  if (!declared) return [];
  const problems = [];
  const where = caller ?? (kind ? `диспетчера ${kind}` : null);
  if (isText(declared.kind) && isText(kind) && declared.kind !== kind) {
    problems.push(`Профиль проекта объявляет трекер ${declared.kind}${isText(declared.prefix) ? ` с префиксом ${declared.prefix}` : ""}, а команда пришла из ${where ?? "другого диспетчера"}. Запусти задачу через её диспетчер или поправь блок tracker`);
  }
  if (isText(declared.prefix) && isText(key)) {
    const prefix = key.match(/^([A-Za-z][A-Za-z0-9]*)-\d+$/)?.[1] ?? null;
    if (prefix !== declared.prefix) problems.push(`Ключ ${key} не из проекта ${declared.prefix}, который объявляет ${PROFILE_FILE}`);
  }
  return problems;
}

function readJsonArg(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label}: not JSON`); }
}

function main() {
  const args = process.argv.slice(2);
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const opts = { profile: null, defaults: {}, tracker: null, caller: null, key: null };
  try {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const next = () => { i += 1; if (args[i] === undefined) throw new Error(`${arg} needs a value`); return args[i]; };
      if (arg === "--profile") opts.profile = next();
      else if (arg === "--defaults") opts.defaults = readJsonArg(next(), "--defaults");
      else if (arg === "--tracker") opts.tracker = next();
      else if (arg === "--caller") opts.caller = next();
      else if (arg === "--key") opts.key = next();
      else throw new Error(`unknown argument ${arg}`);
    }
    if (!opts.profile) throw new Error("usage: validate-profile.mjs --profile <path|-> [--defaults '<json>'] [--tracker <kind>] [--caller <label>] [--key <KEY>]");
  } catch (error) {
    out({ ok: false, code: "bad_args", detail: error.message });
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(opts.profile === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(opts.profile), "utf8"));
  } catch (error) {
    out({ ok: false, code: "bad_profile", detail: [`${PROFILE_FILE}: не читается как JSON (${error.message})`] });
    process.exit(1);
  }
  const problems = profileProblems(raw);
  if (problems.length) {
    out({ ok: false, code: "bad_profile", detail: problems });
    process.exit(1);
  }
  const profile = normalizeProfile(raw);
  out({
    ok: true,
    profile,
    policy: resolvePolicy(profile, opts.defaults),
    checks: profile.checks ?? [],
    tracker: { declared: profile.tracker !== null, kind: profile.tracker?.kind ?? null, prefix: profile.tracker?.prefix ?? null, problems: trackerProblems(profile, { kind: opts.tracker, caller: opts.caller, key: opts.key }) },
    references: profile.references,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
