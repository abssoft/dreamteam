#!/usr/bin/env node
// Prints the newest entries of the plugin's bundled CHANGELOG.md, newest first.
//   --last=N   how many `## [X.Y.Z] - YYYY-MM-DD` entries to print (default 10)
// Read-only: one file read, no git, no network. Exit 1 when CHANGELOG.md is missing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const requested = Number((process.argv.find((arg) => arg.startsWith("--last=")) ?? "").slice("--last=".length));
const limit = Number.isInteger(requested) && requested > 0 ? requested : 10;

let source;
try {
  source = readFileSync(resolve(pluginRoot, "CHANGELOG.md"), "utf8");
} catch {
  console.error(`CHANGELOG.md not found in ${pluginRoot}`);
  process.exit(1);
}

const lines = source.split("\n");
const starts = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
const title = lines.find((line) => line.startsWith("# ")) ?? "# Changelog";
const shown = starts.slice(0, limit);
const entries = shown.length === 0
  ? "(no entries)"
  : lines.slice(shown[0], starts[limit] ?? lines.length).join("\n").trim();
const older = starts.length - shown.length;
const trailer = older > 0 ? `\n\n(ещё ${older} в CHANGELOG.md)` : "";

process.stdout.write(`${title}\n\n${entries}${trailer}\n`);
