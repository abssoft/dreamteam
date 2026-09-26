#!/usr/bin/env node
// A bounded page reader for packs, source and evidence. Offsets count UTF-16
// characters; next_offset also preserves the rest of an unusually long line.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
try {
  const path = option("--file");
  let offset = Number(option("--offset") ?? 0);
  const line = Number(option("--line") ?? 1);
  const limit = Math.min(Number(option("--limit") ?? 12000), 12000);
  if (!path || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(line) || line < 1 || !Number.isInteger(limit) || limit < 1 || (option("--line") && option("--offset"))) throw new Error("use --file <path> [--line <line> | --offset <characters>] [--limit <characters>], limit at most 12000");
  const source = readFileSync(path, "utf8");
  if (option("--line")) {
    for (let at = 1; at < line && offset < source.length; at += 1) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end + 1;
    }
  }
  const page = source.slice(offset, offset + limit).split("\n").slice(0, 200).join("\n");
  const startLine = source.slice(0, offset).split("\n").length;
  const next = offset + page.length;
  process.stdout.write(`${JSON.stringify({ file: path, offset, start_line: startLine, text: page, next_offset: next < source.length ? next : null, complete: next >= source.length })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
}
