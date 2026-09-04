#!/usr/bin/env node
// Prints the newest rows of the plugin's bundled CHANGELOG.md, newest first.
//   --last=N   how many `- X.Y.Z — YYYY-MM-DD — …` rows to print (default 10)
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

const rows = source.split("\n").filter((line) => /^- \d+\.\d+\.\d+ — /.test(line));
const shown = rows.slice(0, limit);
const older = rows.length - shown.length;
const trailer = older > 0 ? `\n\n(ещё ${older} в CHANGELOG.md)` : "";

process.stdout.write(`${shown.length === 0 ? "(no rows)" : shown.join("\n")}${trailer}\n`);
