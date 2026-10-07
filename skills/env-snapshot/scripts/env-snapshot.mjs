#!/usr/bin/env node
// One-pass read-only workspace environment snapshot for role agents.
// Run from the assignment workspace (process cwd). Prints Markdown by default.
//   --json            machine-readable JSON instead of Markdown
//   --skip=a,b        skip sections: rules, docs, git, runtime, validation
//   --base=<ref>      comparison base of the change (default: detected from origin)
//   --max-bytes=N     per-document embed cap for rule documents (default 16384)
// Never mutates anything. Never prints contents of .env* files.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const skip = new Set((args.find(a => a.startsWith("--skip=")) ?? "").replace("--skip=", "").split(",").filter(Boolean));
const baseFlag = (args.find(a => a.startsWith("--base=")) ?? "").replace("--base=", "").trim();
const maxBytes = Number((args.find(a => a.startsWith("--max-bytes=")) ?? "").replace("--max-bytes=", "")) || 16384;

const cwd = process.cwd();

function run(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], cwd, ...opts }).trim();
  } catch {
    return null;
  }
}
const lines = (s, cap) => (s ?? "").split("\n").filter(Boolean).slice(0, cap);
const readIf = (p, cap = maxBytes) => {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    const buf = readFileSync(p, "utf8");
    return { bytes: st.size, truncated: st.size > cap, content: buf.slice(0, cap) };
  } catch {
    return null;
  }
};
const exists = p => existsSync(join(root, p));

// ---------- workspace / git ----------
const snapshot = { ok: true, generated_at: new Date().toISOString(), cwd, os: { platform: os.platform(), release: os.release(), arch: os.arch() } };

// Roles run in the tree the wrapper prepared for the task: a linked worktree
// cut from the synchronized remote base, or the primary checkout. The local
// base branch is shared by every tree and lags its remote, so the remote ref
// is the comparison base unless the caller names one.
const toplevel = run("git", ["rev-parse", "--show-toplevel"]);
const root = toplevel ?? cwd;
if (!skip.has("git")) {
  const ws = { git_toplevel: toplevel };
  if (toplevel) {
    const gitDir = run("git", ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    ws.placement = gitDir && commonDir && gitDir !== commonDir ? "worktree" : "primary";
    if (ws.placement === "worktree") ws.primary = dirname(commonDir);
    ws.head_short = run("git", ["rev-parse", "--short", "HEAD"]);
    ws.current_ref = run("git", ["branch", "--show-current"]) || "(detached)";
    ws.status = lines(run("git", ["status", "--short"]), 80);
    ws.recent_commits = lines(run("git", ["log", "--oneline", "-8"]), 8);
    ws.uncommitted_diffstat = lines(run("git", ["diff", "--stat", "HEAD"]), 80);
    const verify = ref => run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
    const names = ["main", "master", "develop"];
    let base = null;
    if (baseFlag) {
      base = [baseFlag, `origin/${baseFlag}`].find(verify) ?? null;
      if (base) ws.base_note = "base given by --base";
      else ws.base_error = `base ref not found: ${baseFlag}`;
    } else {
      const originHead = run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      base = [originHead, ...names.map(n => `origin/${n}`)].filter(Boolean).find(verify) ?? null;
      if (base) ws.base_note = "base auto-detected from origin; a subtask is based on its parent branch — pass --base=<ref> when the assignment names one";
      else if ((base = names.find(verify) ?? null)) ws.base_note = "base auto-detected by local branch name, which may lag its remote; pass --base=<ref> when the assignment names one";
    }
    if (base && ws.current_ref !== base.replace(/^origin\//, "")) {
      const mergeBase = run("git", ["merge-base", base, "HEAD"]);
      ws.detected_base = base;
      if (mergeBase) {
        ws.commits_on_top_of_base = lines(run("git", ["log", "--oneline", `${mergeBase}..HEAD`]), 20);
        ws.changed_paths_vs_base = lines(run("git", ["diff", "--name-status", `${mergeBase}..HEAD`]), 120);
        ws.diffstat_vs_base_tail = lines(run("git", ["diff", "--stat", `${mergeBase}..HEAD`]), 200).slice(-3);
      }
    } else if (!ws.base_error) delete ws.base_note;
    try {
      ws.env_file_names = readdirSync(root).filter(n => n.startsWith(".env")).sort();
    } catch { ws.env_file_names = []; }
  }
  snapshot.workspace = ws;
}

// ---------- project manifests ----------
const kinds = [];
const project = {};
const pkgRaw = readIf(join(root, "package.json"), 64 * 1024);
if (pkgRaw) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    kinds.push("node");
    project.node = { name: pkg.name, packageManager: pkg.packageManager, engines: pkg.engines, scripts: pkg.scripts ?? {} };
  } catch { project.node = { error: "package.json unreadable" }; }
}
const composerRaw = readIf(join(root, "composer.json"), 64 * 1024);
if (composerRaw) {
  try {
    const composer = JSON.parse(readFileSync(join(root, "composer.json"), "utf8"));
    kinds.push("php");
    project.php = { name: composer.name, php_require: composer.require?.php, scripts: composer.scripts ?? {} };
  } catch { project.php = { error: "composer.json unreadable" }; }
}
project.kinds = kinds;
project.lockfiles = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "composer.lock"].filter(exists);
if (exists("Makefile")) {
  const mk = readIf(join(root, "Makefile"), 32 * 1024);
  project.makefile_targets = [...(mk?.content ?? "").matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*):(?!=)/gm)].map(m => m[1]).slice(0, 25);
}
// A tree gets its dependencies from the wrapper's setup — links to the primary
// checkout or an install; a tree without them cannot run the project's tools.
const depState = p => {
  try {
    return lstatSync(join(root, p)).isSymbolicLink() ? `symlink → ${readlinkSync(join(root, p))}` : "present";
  } catch {
    return "absent";
  }
};
project.dependencies = {};
if (kinds.includes("node")) project.dependencies.node_modules = depState("node_modules");
if (kinds.includes("php")) project.dependencies.vendor = depState("vendor");
snapshot.project = project;

// ---------- runtime versions ----------
if (!skip.has("runtime")) {
  const rt = { node: process.version };
  if (kinds.includes("node")) {
    for (const tool of ["pnpm", "npm", "yarn"]) rt[tool] = run(tool, ["--version"]);
  }
  if (kinds.includes("php")) {
    rt.php = (run("php", ["-v"]) ?? "").split("\n")[0] || null;
    rt.composer = (run("composer", ["--version", "--no-ansi"]) ?? "").split("\n")[0] || null;
  }
  for (const f of [".nvmrc", ".node-version", ".tool-versions", ".php-version"]) {
    const v = readIf(join(root, f), 512);
    if (v) (rt.version_files ??= {})[f] = v.content.trim();
  }
  snapshot.runtime = rt;
}

// ---------- validation command derivation ----------
// A check is evidence about a change only when the role can point it at that
// change. Whether a check narrows, and how, follows from the binary its script
// actually runs — never from the name the author gave the script.
const TOOLS = [
  { tool: "vitest", lang: "node", re: /vitest$/, scope: "related", arg: "related {paths}", value: ["--config", "-c", "--reporter", "--project", "--environment"],
    note: "related follows the module graph to the tests that import the change; a bare path argument matches test file names instead" },
  { tool: "jest", lang: "node", re: /jest$/, scope: "related", arg: "--findRelatedTests {paths}", value: ["--config", "-c", "--reporters", "--maxWorkers", "--testPathPattern"],
    note: "a global coverage threshold fails a partial run; drop it or accept the coverage item as uncovered" },
  { tool: "eslint", lang: "node", re: /eslint$/, scope: "paths", arg: "{paths}", bool: ["--fix", "--quiet", "--cache", "--no-warn-ignored", "--no-eslintrc"], strip: ["--fix"], skip: /--prune-suppressions/, value: ["--config", "-c", "--ext", "--format", "-f", "--max-warnings", "--rulesdir", "--resolve-plugins-relative-to"],
    note: "add --no-warn-ignored when a changed path is ignored by the configuration" },
  { tool: "biome", lang: "node", re: /biome$/, scope: "paths", arg: "{paths}", sub: ["check", "lint", "format", "ci"], value: ["--config-path"] },
  { tool: "stylelint", lang: "node", re: /stylelint$/, scope: "paths", arg: "{paths}", bool: ["--fix", "--quiet"], strip: ["--fix"], value: ["--config", "--custom-syntax", "--formatter"] },
  { tool: "prettier", lang: "node", re: /prettier$/, scope: "paths", arg: "--check {paths}", bool: ["--check", "-c", "--write", "-w", "--list-different", "-l"], strip: ["--write", "-w"], value: ["--config", "--ignore-path", "--parser"] },
  { tool: "phpunit", lang: "php", re: /phpunit$/, scope: "tests-by-path", arg: "{test paths}", bool: ["--testdox", "--no-coverage", "--stop-on-failure", "--fail-on-warning"], value: ["--configuration", "-c", "--testsuite", "--filter", "--group", "--bootstrap"],
    note: "takes test files or directories, never source paths; map a changed unit to its test by the suite's own mirror convention and widen when no test claims it" },
  { tool: "artisan test", lang: "php", re: /artisan$/, bin: "php artisan", sub: ["test"], scope: "tests-by-path", arg: "{test paths}", value: ["--testsuite", "--filter", "--group"],
    note: "forwards its arguments to phpunit: test paths, never source paths" },
  { tool: "pint", lang: "php", re: /pint$/, scope: "paths", arg: "--test {paths}", bool: ["--test", "--dirty"], value: ["--config"] },
  { tool: "phpcs", lang: "php", re: /phpcs$/, scope: "paths", arg: "{paths}", value: ["--standard", "--report"] },
  { tool: "php-cs-fixer", lang: "php", re: /php-cs-fixer$/, scope: "paths", arg: "--dry-run --path-mode=intersection {paths}", sub: ["fix"], bool: ["--dry-run"], value: ["--config", "--path-mode"],
    note: "without --path-mode=intersection the given paths replace the finder of the configuration instead of narrowing it; only --dry-run is a check" },
  { tool: "rector", lang: "php", re: /rector$/, scope: "paths", arg: "--dry-run {paths}", sub: ["process"], bool: ["--dry-run", "--clear-cache", "-n"], value: ["--config", "-c", "--memory-limit"],
    note: "rector rewrites files; only the --dry-run form is a check" },
  { tool: "phpstan", lang: "php", re: /phpstan$/, scope: "none", sub: ["analyse", "analyze"], skip: /--generate-baseline/, value: ["-c", "--configuration", "--memory-limit", "-a", "--autoload-file", "-l", "--level", "--error-format"],
    note: "narrowing to changed paths drops the errors the change causes in the files that consume it; its result cache makes the second run in a workspace cheap, so only the first is cold" },
  { tool: "psalm", lang: "php", re: /psalm$/, scope: "none", note: "same as phpstan: a partial run loses the consumers of the change; use its own cache instead" },
  { tool: "tsc", lang: "node", re: /tsc$/, scope: "none", note: "passing files to tsc ignores tsconfig.json and type-checks them with default options, so a narrowed run says nothing about the project" },
];
const PATH_SHAPED = /[\/*]|^\.$|^\.\.$|\.[A-Za-z0-9]+$/;
const tokenize = (text) => text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
const unquote = (token) => token.replace(/^["']|["']$/g, "");

// Keeps the flags the script already carries — a check run without its own
// configuration is a different check — and drops the targets it hardcodes.
// A flag that makes the tool rewrite files is dropped (`strip`), and a script
// whose whole purpose is a rewrite is not a check at all (`skip`). A bare flag
// whose value looks like a path and is not a known value flag is
// indistinguishable from a target, so that check is reported as unnarrowable
// rather than guessed at.
function narrowSegment(segment, spec, runner) {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((token) => spec.re.test(unquote(token)));
  if (at < 0) return null;
  if (spec.skip && spec.skip.test(segment)) return null;
  const binary = unquote(tokens[at]);
  const kept = [spec.bin ?? (binary.includes("/") ? binary : spec.lang === "php" ? `vendor/bin/${binary}` : `${runner} ${binary}`)];
  const targets = [];
  let pending = null;
  for (const raw of tokens.slice(at + 1)) {
    const token = unquote(raw);
    if (token.startsWith("-")) {
      if (!(spec.strip ?? []).includes(token)) kept.push(raw);
      pending = token.includes("=") ? null : token;
      continue;
    }
    if (pending && !(spec.bool ?? []).includes(pending)) {
      if ((spec.value ?? []).includes(pending)) { kept.push(raw); pending = null; continue; }
      if (PATH_SHAPED.test(token)) return { ambiguous: `${pending} ${token}` };
      kept.push(raw);
      pending = null;
      continue;
    }
    pending = null;
    if ((spec.sub ?? []).includes(token)) { kept.push(raw); continue; }
    targets.push(raw);
  }
  // A configured PHPUnit suite owns its bootstrap and targets. Replacing
  // those with application tests runs a different suite, often with exit 0.
  if (["phpunit", "artisan test"].includes(spec.tool) && (targets.length || /(?:^|\s)(?:-c|--configuration|--testsuite|--group)(?:=|\s)/.test(segment))) {
    return { command: [...kept, ...targets].join(" "), configuredSuite: true };
  }
  return { command: kept.join(" ") };
}

if (!skip.has("validation")) {
  const checks = [];
  const suite = [];
  const notes = [];
  const runner = exists("pnpm-lock.yaml") ? "pnpm exec" : exists("yarn.lock") ? "yarn" : "npx";
  const seen = new Set();

  const classify = (source, body, lang) => {
    // A watch or interactive run never returns, so it is not a check.
    if (/--watch\b|--ui\b/.test(String(body))) return;
    for (const segment of String(body).split(/&&|\|\||;|\|/)) {
      for (const spec of TOOLS) {
        if (spec.lang !== lang) continue;
        const parsed = narrowSegment(segment, spec, runner);
        if (!parsed) continue;
        let check;
        if (parsed.configuredSuite) {
          check = { tool: spec.tool, lang: spec.lang, source, scope: "none", command: source, run: parsed.command, reason: "preserves the declared PHPUnit suite, configuration and bootstrap" };
        } else if (spec.scope === "none") {
          check = { tool: spec.tool, lang: spec.lang, source, scope: "none", command: source, run: parsed.command, reason: spec.note };
        } else if (parsed.ambiguous) {
          check = { tool: spec.tool, lang: spec.lang, source, scope: "none", command: source, reason: `cannot tell the target from the value of ${parsed.ambiguous}; run it as the script defines it` };
        } else {
          const already = new Set(tokenize(parsed.command).map(unquote));
          const arg = spec.arg.split(" ").filter((token) => !already.has(token)).join(" ");
          check = { tool: spec.tool, lang: spec.lang, source, scope: spec.scope, command: `${parsed.command} ${arg}`, ...(spec.note ? { note: spec.note } : {}) };
        }
        // Two scripts that resolve to the same run are one check.
        const key = `${spec.tool}:${check.run ?? check.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push(check);
      }
    }
  };

  if (project.node?.scripts) {
    const mgr = exists("pnpm-lock.yaml") ? "pnpm" : exists("yarn.lock") ? "yarn" : "npm run";
    const s = project.node.scripts;
    const pick = names => names.find(n => Object.hasOwn(s, n));
    const seq = [pick(["check:types", "typecheck", "type-check", "types:check", "tsc"]), pick(["lint:ci", "lint"]), pick(["test:unit", "test"])].filter(Boolean);
    if (seq.length) suite.push(seq.map(n => `${mgr} ${n}`).join(" && "));
    for (const [name, body] of Object.entries(s)) classify(`${mgr} ${name}`, body, "node");
  }
  if (project.php) {
    const s = project.php.scripts ?? {};
    const phpSeq = [];
    for (const key of ["lint", "cs", "analyse", "analyze", "stan", "types:check", "test"]) if (Object.hasOwn(s, key)) phpSeq.push(`composer ${key}`);
    if (!Object.hasOwn(s, "test") && (exists("phpunit.xml") || exists("phpunit.xml.dist"))) {
      phpSeq.push(exists("artisan") ? "php artisan test" : "vendor/bin/phpunit");
    }
    if (phpSeq.length) suite.push(phpSeq.join(" && "));
    for (const [name, body] of Object.entries(s)) {
      for (const line of Array.isArray(body) ? body : [body]) classify(`composer ${name}`, line, "php");
    }
    if (!Object.hasOwn(s, "test") && (exists("phpunit.xml") || exists("phpunit.xml.dist"))) {
      classify(exists("artisan") ? "php artisan test" : "vendor/bin/phpunit", exists("artisan") ? "artisan test" : "vendor/bin/phpunit", "php");
    }
  }
  if (!checks.length && !suite.length) notes.push("no validation commands derived; check project manifests or repository docs");
  else if (!checks.some(c => c.scope !== "none")) notes.push("nothing here narrows to changed paths; the suite is the check, and its width is a stated gap, not coverage");
  snapshot.validation = {
    scope_source: "the paths this assignment changed against its base: git diff --name-only <base>...HEAD, plus the working tree (git diff --name-only HEAD and untracked entries of git status --short); the QA role takes them from its plan instead",
    checks,
    suite,
    notes,
  };
}

// ---------- docs index ----------
if (!skip.has("docs")) {
  const docsDir = join(root, "docs");
  let docFiles = [];
  if (existsSync(docsDir)) {
    docFiles = toplevel
      ? lines(run("git", ["ls-files", "docs/*.md", "docs/**/*.md"]), 150)
      : [];
  }
  snapshot.docs_index = docFiles;
}

// ---------- rules documents ----------
{
  const found = [];
  const queue = ["AGENTS.md", "CLAUDE.md"].filter(exists);
  const seen = new Set(queue);
  for (const f of queue) {
    const doc = readIf(join(root, f));
    if (!doc) continue;
    found.push({ path: f, ...doc });
    for (const m of doc.content.matchAll(/(?:^|[\s(`\["'])@([A-Za-z0-9._/-]+\.md)\b/gm)) {
      const ref = m[1];
      if (!seen.has(ref) && exists(ref)) { seen.add(ref); queue.push(ref); }
    }
  }
  for (const extra of ["CONTRIBUTING.md"]) {
    if (!seen.has(extra) && exists(extra)) { const d = readIf(join(root, extra)); if (d) found.push({ path: extra, ...d }); }
  }
  snapshot.rules = skip.has("rules")
    ? found.map(({ path, bytes }) => ({ path, bytes, content_skipped: true }))
    : found;
  // The README is orientation, not a rule: listed for a later read, never embedded.
  const readme = readIf(join(root, "README.md"), 0);
  if (readme && !seen.has("README.md")) snapshot.rules.push({ path: "README.md", bytes: readme.bytes, content_skipped: true });
}

// ---------- output ----------
if (asJson) {
  process.stdout.write(JSON.stringify(snapshot, null, 1) + "\n");
  process.exit(0);
}

const out = [];
out.push(`# env-snapshot — ${cwd} — ${snapshot.generated_at}`);
out.push(`os: ${snapshot.os.platform} ${snapshot.os.release} ${snapshot.os.arch}`);
if (snapshot.workspace) {
  const w = snapshot.workspace;
  out.push(`\n## workspace`);
  out.push(`git toplevel: ${w.git_toplevel ?? "(not a git repository)"}`);
  if (w.git_toplevel) {
    out.push(`placement: ${w.placement === "worktree" ? `linked worktree of ${w.primary}` : "primary checkout"}`);
    out.push(`HEAD ${w.head_short} on ${w.current_ref}`);
    if (w.detected_base) out.push(`base: ${w.detected_base} (${w.base_note})`);
    if (w.base_error) out.push(w.base_error);
    out.push(`env files (names only, contents never read): ${w.env_file_names.join(", ") || "(none)"}`);
    out.push(`\nstatus --short:${w.status.length ? "" : " (clean)"}`);
    out.push(...w.status.map(s => "  " + s));
    out.push(`\nrecent commits:`);
    out.push(...w.recent_commits.map(s => "  " + s));
    if (w.commits_on_top_of_base?.length) { out.push(`\ncommits on top of ${w.detected_base}:`); out.push(...w.commits_on_top_of_base.map(s => "  " + s)); }
    if (w.changed_paths_vs_base?.length) { out.push(`\nchanged paths vs ${w.detected_base} (name-status):`); out.push(...w.changed_paths_vs_base.map(s => "  " + s)); if (w.diffstat_vs_base_tail?.length) out.push("  " + w.diffstat_vs_base_tail.join(" ")); }
    if (w.uncommitted_diffstat?.length) { out.push(`\nuncommitted diffstat:`); out.push(...w.uncommitted_diffstat.map(s => "  " + s)); }
  }
}
if (snapshot.runtime) {
  out.push(`\n## runtime`);
  for (const [k, v] of Object.entries(snapshot.runtime)) if (typeof v === "string" && v) out.push(`${k}: ${v}`);
  for (const [f, v] of Object.entries(snapshot.runtime.version_files ?? {})) out.push(`${f}: ${v}`);
}
out.push(`\n## project (${project.kinds.join(", ") || "unknown kind"})`);
if (project.node) {
  out.push(`node package: ${project.node.name ?? "?"}${project.node.packageManager ? ` — packageManager ${project.node.packageManager}` : ""}${project.node.engines ? ` — engines ${JSON.stringify(project.node.engines)}` : ""}`);
  out.push(`scripts: ${Object.keys(project.node.scripts ?? {}).join(", ") || "(none)"}`);
}
if (project.php) {
  out.push(`php package: ${project.php.name ?? "?"}${project.php.php_require ? ` — php ${project.php.php_require}` : ""}`);
  out.push(`composer scripts: ${Object.keys(project.php.scripts ?? {}).join(", ") || "(none)"}`);
}
if (project.lockfiles?.length) out.push(`lockfiles: ${project.lockfiles.join(", ")}`);
if (project.makefile_targets?.length) out.push(`Makefile targets: ${project.makefile_targets.join(", ")}`);
for (const [dir, state] of Object.entries(project.dependencies)) out.push(`${dir}: ${state}`);
if (snapshot.docs_index) {
  out.push(`\n## docs index (${snapshot.docs_index.length} files${snapshot.docs_index.length === 150 ? ", capped" : ""})`);
  out.push(...snapshot.docs_index.map(s => "  " + s));
}
if (snapshot.rules?.length) {
  out.push(`\n## rules documents`);
  for (const d of snapshot.rules) {
    if (d.content_skipped) { out.push(`- ${d.path} (${d.bytes} bytes, content skipped)`); continue; }
    out.push(`\n----- BEGIN ${d.path} (${d.bytes} bytes${d.truncated ? ", truncated" : ""}${d.note ? ", " + d.note : ""}) -----`);
    out.push(d.content.trimEnd());
    out.push(`----- END ${d.path} -----`);
  }
}
process.stdout.write(out.join("\n") + "\n");
