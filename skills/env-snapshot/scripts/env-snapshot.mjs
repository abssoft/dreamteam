#!/usr/bin/env node
// One-pass read-only workspace environment snapshot for role agents.
// Run from the assignment workspace (process cwd). Prints Markdown by default.
//   --json            machine-readable JSON instead of Markdown
//   --skip=a,b        skip sections: rules, docs, git, runtime, tooling
//   --max-bytes=N     per-document embed cap for rule documents (default 16384)
// Never mutates anything. Never prints contents of .env* files.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const skip = new Set((args.find(a => a.startsWith("--skip=")) ?? "").replace("--skip=", "").split(",").filter(Boolean));
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
const exists = p => existsSync(join(cwd, p));

// ---------- workspace / git ----------
const snapshot = { ok: true, generated_at: new Date().toISOString(), cwd, os: { platform: os.platform(), release: os.release(), arch: os.arch() } };

let toplevel = null;
if (!skip.has("git")) {
  toplevel = run("git", ["rev-parse", "--show-toplevel"]);
  const ws = { git_toplevel: toplevel };
  if (toplevel) {
    ws.head_short = run("git", ["rev-parse", "--short", "HEAD"]);
    ws.current_ref = run("git", ["branch", "--show-current"]) || "(detached)";
    ws.status = lines(run("git", ["status", "--short"]), 80);
    ws.recent_commits = lines(run("git", ["log", "--oneline", "-8"]), 8);
    ws.worktrees = lines(run("git", ["worktree", "list"]), 20);
    ws.uncommitted_diffstat = lines(run("git", ["diff", "--stat", "HEAD"]), 80);
    const base = ["main", "master", "develop"].find(b => run("git", ["rev-parse", "--verify", "--quiet", b]) !== null);
    if (base && ws.current_ref !== base) {
      const mergeBase = run("git", ["merge-base", base, "HEAD"]);
      ws.detected_base = base;
      if (mergeBase) {
        ws.commits_on_top_of_base = lines(run("git", ["log", "--oneline", `${mergeBase}..HEAD`]), 20);
        ws.changed_paths_vs_base = lines(run("git", ["diff", "--name-status", `${mergeBase}..HEAD`]), 120);
        ws.diffstat_vs_base_tail = lines(run("git", ["diff", "--stat", `${mergeBase}..HEAD`]), 200).slice(-3);
      }
      ws.base_note = "base auto-detected by name; if the assignment implies a different base, diff against that instead";
    }
  }
  snapshot.workspace = ws;
}
const root = toplevel ?? cwd;

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

// ---------- tooling presence ----------
if (!skip.has("tooling")) {
  const candidates = [
    "tsconfig.json", "eslint.config.mjs", "eslint.config.js", "eslint.config.ts", ".eslintrc.json", ".eslintrc.js",
    "vitest.config.ts", "vitest.config.mts", "vitest.config.js", "jest.config.js", "jest.config.ts",
    "playwright.config.ts", "prisma/schema.prisma", "phpunit.xml", "phpunit.xml.dist", "artisan",
    "Dockerfile", "docker-compose.yml", "docker-compose.dev.yml", ".editorconfig", "e2e",
  ];
  const tooling = { present: candidates.filter(exists) };
  try {
    tooling.env_file_names = readdirSync(root).filter(n => n.startsWith(".env")).sort();
  } catch { tooling.env_file_names = []; }
  if (toplevel) {
    const testFiles = run("git", ["ls-files", "*.test.*", "*Test.php", "*_test.*"]);
    tooling.test_file_count = testFiles ? testFiles.split("\n").filter(Boolean).length : 0;
  }
  snapshot.tooling = tooling;
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
  { tool: "eslint", lang: "node", re: /eslint$/, scope: "paths", arg: "{paths}", bool: ["--fix", "--quiet", "--cache", "--no-warn-ignored", "--no-eslintrc"], value: ["--config", "-c", "--ext", "--format", "-f", "--max-warnings", "--rulesdir", "--resolve-plugins-relative-to"],
    note: "add --no-warn-ignored when a changed path is ignored by the configuration" },
  { tool: "biome", lang: "node", re: /biome$/, scope: "paths", arg: "{paths}", sub: ["check", "lint", "format", "ci"], value: ["--config-path"] },
  { tool: "stylelint", lang: "node", re: /stylelint$/, scope: "paths", arg: "{paths}", bool: ["--fix", "--quiet"], value: ["--config", "--custom-syntax", "--formatter"] },
  { tool: "prettier", lang: "node", re: /prettier$/, scope: "paths", arg: "{paths}", bool: ["--check", "-c", "--write", "-w", "--list-different", "-l"], value: ["--config", "--ignore-path", "--parser"] },
  { tool: "phpunit", lang: "php", re: /phpunit$/, scope: "tests-by-path", arg: "{test paths}", bool: ["--testdox", "--no-coverage", "--stop-on-failure", "--fail-on-warning"], value: ["--configuration", "-c", "--testsuite", "--filter", "--group", "--bootstrap"],
    note: "takes test files or directories, never source paths; map a changed unit to its test by the suite's own mirror convention and widen when no test claims it" },
  { tool: "artisan test", lang: "php", re: /artisan$/, bin: "php artisan", sub: ["test"], scope: "tests-by-path", arg: "{test paths}", value: ["--testsuite", "--filter", "--group"],
    note: "forwards its arguments to phpunit: test paths, never source paths" },
  { tool: "pint", lang: "php", re: /pint$/, scope: "paths", arg: "{paths}", bool: ["--test", "--dirty"], value: ["--config"] },
  { tool: "phpcs", lang: "php", re: /phpcs$/, scope: "paths", arg: "{paths}", value: ["--standard", "--report"] },
  { tool: "php-cs-fixer", lang: "php", re: /php-cs-fixer$/, scope: "paths", arg: "--path-mode=intersection {paths}", sub: ["fix"], value: ["--config", "--path-mode"],
    note: "without --path-mode=intersection the given paths replace the finder of the configuration instead of narrowing it" },
  { tool: "rector", lang: "php", re: /rector$/, scope: "paths", arg: "--dry-run {paths}", sub: ["process"], bool: ["--dry-run", "--clear-cache", "-n"], value: ["--config", "-c", "--memory-limit"],
    note: "rector rewrites files; only the --dry-run form is a check" },
  { tool: "phpstan", lang: "php", re: /phpstan$/, scope: "none", sub: ["analyse", "analyze"], value: ["-c", "--configuration", "--memory-limit", "-a", "--autoload-file", "-l", "--level", "--error-format"],
    note: "narrowing to changed paths drops the errors the change causes in the files that consume it; the review pack runner pins its result cache per workspace, so only the first run in a worktree is cold" },
  { tool: "psalm", lang: "php", re: /psalm$/, scope: "none", note: "same as phpstan: a partial run loses the consumers of the change; use its own cache instead" },
  { tool: "tsc", lang: "node", re: /tsc$/, scope: "none", note: "passing files to tsc ignores tsconfig.json and type-checks them with default options, so a narrowed run says nothing about the project" },
];
const PATH_SHAPED = /[\/*]|^\.$|^\.\.$|\.[A-Za-z0-9]+$/;
const tokenize = (text) => text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
const unquote = (token) => token.replace(/^["']|["']$/g, "");

// Keeps the flags the script already carries — a check run without its own
// configuration is a different check — and drops the targets it hardcodes.
// A bare flag whose value looks like a path and is not a known value flag is
// indistinguishable from a target, so that check is reported as unnarrowable
// rather than guessed at.
function narrowSegment(segment, spec, runner) {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((token) => spec.re.test(unquote(token)));
  if (at < 0) return null;
  const binary = unquote(tokens[at]);
  const kept = [spec.bin ?? (binary.includes("/") ? binary : spec.lang === "php" ? `vendor/bin/${binary}` : `${runner} ${binary}`)];
  let pending = null;
  for (const raw of tokens.slice(at + 1)) {
    const token = unquote(raw);
    if (token.startsWith("-")) {
      kept.push(raw);
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
  }
  return { command: kept.join(" ") };
}

{
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
        const key = `${spec.tool}:${parsed.command ?? source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (spec.scope === "none") {
          checks.push({ tool: spec.tool, source, scope: "none", command: source, run: parsed.command, reason: spec.note });
        } else if (parsed.ambiguous) {
          checks.push({ tool: spec.tool, source, scope: "none", command: source, reason: `cannot tell the target from the value of ${parsed.ambiguous}; run it as the script defines it` });
        } else {
          const already = new Set(tokenize(parsed.command).map(unquote));
          const arg = spec.arg.split(" ").filter((token) => !already.has(token)).join(" ");
          checks.push({ tool: spec.tool, source, scope: spec.scope, command: `${parsed.command} ${arg}`, ...(spec.note ? { note: spec.note } : {}) });
        }
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
    scope_source: "the paths this assignment changed against its base: git diff --name-only <base>...HEAD, plus the working tree (git diff --name-only HEAD and untracked entries of git status --short); a review takes them from its pack instead",
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
  const readme = readIf(join(root, "README.md"), 4096);
  if (readme && !seen.has("README.md")) found.push({ path: "README.md", ...readme, note: "head only" });
  snapshot.rules = skip.has("rules")
    ? found.map(({ path, bytes }) => ({ path, bytes, content_skipped: true }))
    : found;
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
    out.push(`HEAD ${w.head_short} on ${w.current_ref}`);
    if (w.detected_base) out.push(`detected base: ${w.detected_base} (${w.base_note})`);
    out.push(`\nstatus --short:${w.status.length ? "" : " (clean)"}`);
    out.push(...w.status.map(s => "  " + s));
    out.push(`\nrecent commits:`);
    out.push(...w.recent_commits.map(s => "  " + s));
    if (w.commits_on_top_of_base?.length) { out.push(`\ncommits on top of ${w.detected_base}:`); out.push(...w.commits_on_top_of_base.map(s => "  " + s)); }
    if (w.changed_paths_vs_base?.length) { out.push(`\nchanged paths vs ${w.detected_base} (name-status):`); out.push(...w.changed_paths_vs_base.map(s => "  " + s)); if (w.diffstat_vs_base_tail?.length) out.push("  " + w.diffstat_vs_base_tail.join(" ")); }
    if (w.uncommitted_diffstat?.length) { out.push(`\nuncommitted diffstat:`); out.push(...w.uncommitted_diffstat.map(s => "  " + s)); }
    if (w.worktrees?.length > 1) { out.push(`\nworktrees:`); out.push(...w.worktrees.map(s => "  " + s)); }
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
out.push(`\n## validation (default width: the paths this change touched — the shared engineering reference states when a check runs at full width instead)`);
out.push(`scope of a run: ${snapshot.validation.scope_source}`);
for (const [label, kept] of [
  ["narrowed by dependents", (c) => c.scope === "related"],
  ["narrowed by paths", (c) => c.scope === "paths" || c.scope === "tests-by-path"],
  ["full width only", (c) => c.scope === "none"],
]) {
  const group = snapshot.validation.checks.filter(kept);
  if (!group.length) continue;
  out.push(`${label}:`);
  for (const c of group) out.push(`  ${c.command}   (${c.tool}, from ${c.source}${c.note ? `; ${c.note}` : c.reason ? `; ${c.reason}` : ""})`);
}
if (snapshot.validation.suite.length) {
  out.push(`project suite (only when the shared reference calls for full width):`);
  for (const c of snapshot.validation.suite) out.push("  " + c);
}
for (const n of snapshot.validation.notes) out.push("  note: " + n);
if (snapshot.tooling) {
  out.push(`\n## tooling`);
  out.push(`present: ${snapshot.tooling.present.join(", ") || "(none detected)"}`);
  out.push(`env files (names only, contents never read): ${snapshot.tooling.env_file_names.join(", ") || "(none)"}`);
  if (snapshot.tooling.test_file_count !== undefined) out.push(`tracked test files: ${snapshot.tooling.test_file_count}`);
}
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
