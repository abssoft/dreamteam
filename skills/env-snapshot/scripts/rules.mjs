// The repository's instruction chain, selected the same way for every role:
// the developer's snapshot and the reviewer's pack both call collectRules, so
// the rules a change is judged by are the rules its author was handed. Entry
// files go in whole, with the documents they import by `@path`; the rule
// directories go in whole minus the rules whose `paths:` front matter (the
// Claude Code rules convention) match none of the given paths; the documents
// the entries link go in whole when their `paths:` match, and as routes —
// path plus the line that names them — when they declare none. The `lsd`
// probes live here for the same reason: both roles navigate by it.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const RULES_ENTRIES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "docs/engineering/README.md"];
export const RULES_DIRS = ["docs/engineering/rules", ".claude/rules"];
export const RULES_ROUTE_CAP = 40;
const ROUTE_HINT_CHARS = 160;
const DOCS_LIST_CAP = 150;
// A markdown link or bare path naming a document of this repository; a URL, an
// absolute path or a traversal is not one.
const DOC_LINK = /(?:^|[\s(<"'`[])([A-Za-z0-9._][A-Za-z0-9._/-]*\.md)\b/g;
// An `@path` import of an entry file: the hosting runtime injects it with the
// entry, so it is an entry here too.
const DOC_IMPORT = /(?:^|[\s(`["'])@([A-Za-z0-9._][A-Za-z0-9._/-]*\.md)\b/g;

const inside = (root, relative) => {
  const target = resolve(root, relative);
  return target === join(root, relative) && existsSync(target) ? target : null;
};

// Documents an entry file names, resolved inside the repository only, each with
// the line that names it: that line is the condition for reading the document.
function routes(text, root, seen, state) {
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(DOC_LINK)) {
      const relative = match[1];
      if (seen.has(relative) || !inside(root, relative)) continue;
      seen.add(relative);
      if (state.list.length >= RULES_ROUTE_CAP) { state.cut.push(relative); continue; }
      const hint = line.replace(/^[\s>*+-]*/, "").trim().slice(0, ROUTE_HINT_CHARS);
      state.list.push(hint && hint !== relative ? `${relative} — ${hint}` : relative);
    }
  }
}

// The front matter's `paths:` globs — an inline list, a YAML list or one scalar.
export function rulePaths(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) return { paths: null, body: text };
  const body = text.slice(front[0].length);
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^paths:/.test(line));
  if (at < 0) return { paths: null, body };
  const unquote = (value) => value.trim().replace(/^["']|["']$/g, "").trim();
  const inline = lines[at].slice("paths:".length).trim();
  let paths;
  if (inline.startsWith("[")) paths = inline.replace(/^\[|\]$/g, "").split(",").map(unquote);
  else if (inline) paths = [unquote(inline)];
  else {
    paths = [];
    for (const line of lines.slice(at + 1)) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item) break;
      paths.push(unquote(item[1]));
    }
  }
  return { paths: paths.filter(Boolean), body };
}

export function globRegExp(glob) {
  let source = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") { i += 1; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") { braces += 1; source += "(?:"; }
    else if (char === "}" && braces > 0) { braces -= 1; source += ")"; }
    else if (char === "," && braces > 0) source += "|";
    else source += char.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source.replace(/^\/+/, "")}$`);
}

// null changed paths: no applicability filter (the policy hash enumerates every
// candidate rule, applicable or not).
const applies = (paths, changed) => changed === null || paths.map(globRegExp).some((glob) => changed.some((path) => glob.test(path)));

function trackedDocs(cwd) {
  try {
    return execFileSync("git", ["ls-files", "docs/*.md", "docs/**/*.md"], { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean).slice(0, DOCS_LIST_CAP);
  } catch {
    return [];
  }
}

export function collectRules(root, cwd, budget, changed = null) {
  const seen = new Set();
  const entries = [];
  const queue = RULES_ENTRIES.filter((entry) => !seen.has(entry) && inside(root, entry) && seen.add(entry));
  for (const entry of queue) {
    const text = readFileSync(join(root, entry), "utf8");
    entries.push({ path: entry, text });
    for (const match of text.matchAll(DOC_IMPORT)) {
      if (!seen.has(match[1]) && inside(root, match[1])) { seen.add(match[1]); queue.push(match[1]); }
    }
  }
  if (entries.length === 0) {
    return { mode: "paths", paths: trackedDocs(cwd), routes: [], routes_cut: [], items: [], dropped: [], skipped: [] };
  }
  const items = [...entries];
  const skipped = [];
  for (const dirPath of RULES_DIRS) {
    const dir = join(root, dirPath);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { recursive: true }).map(String).filter((entry) => entry.endsWith(".md")).sort()) {
      const relative = `${dirPath}/${name}`;
      if (seen.has(relative)) continue;
      seen.add(relative);
      const { paths, body } = rulePaths(readFileSync(join(dir, name), "utf8"));
      if (paths && !applies(paths, changed)) { skipped.push(relative); continue; }
      items.push({ path: relative, text: body });
    }
  }
  // Routes are drawn from the entry files only, and never repeat a document the
  // pack already carries whole. A routed document that declares its paths is no
  // longer a route: applicable, it rides whole; otherwise it stays out.
  const state = { list: [], cut: [] };
  for (const entry of entries) routes(entry.text, root, seen, state);
  const routed = [];
  for (const route of state.list) {
    const path = route.split(" — ")[0];
    const { paths, body } = rulePaths(readFileSync(join(root, path), "utf8"));
    if (!paths || changed === null) routed.push(route);
    else if (applies(paths, changed)) items.push({ path, text: body });
    else skipped.push(path);
  }
  const kept = [];
  const dropped = [];
  // Routes come first: when the budget is tight, knowing where a rule lives
  // beats holding one rule and losing the map to the rest.
  let used = routed.reduce((total, route) => total + route.length + 3, 0);
  for (const item of items) {
    const size = item.path.length + item.text.length + 8;
    if (used + size <= budget) { kept.push(item); used += size; } else dropped.push(item.path);
  }
  return { mode: "content", paths: [], routes: routed, routes_cut: state.cut, items: kept, dropped, skipped };
}

// The `lsd` of this skill, not the ls replacement of the same name: its help
// names the declaration lookup.
export function lsdAvailable(cwd) {
  try {
    return /Where a symbol is declared/.test(execFileSync("lsd", ["--help"], { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

// The first question in a tree waits for its index; the rebuild starts now,
// detached, so it walks while the role reads its pack or snapshot.
export function warmLsd(root) {
  try {
    spawn("lsd", ["reindex", root], { cwd: root, detached: true, stdio: "ignore" }).unref();
  } catch {
    // A warm index is a saving, never a precondition.
  }
}
