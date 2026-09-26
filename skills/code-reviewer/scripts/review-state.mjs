// Small projections keep role history out of every subsequent model turn.
// Full evidence stays in the original Result files named by the pack.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));

export function parseResult(material) {
  try { return JSON.parse(material?.text); } catch { return null; }
}

export function previousManifest(result) {
  try { return JSON.parse(readFileSync(result.deliverable.content.review_manifest, "utf8")); } catch { return null; }
}

export function compactResult(material) {
  const result = parseResult(material);
  if (!result || typeof result !== "object" || Array.isArray(result)) return material.text;
  const projected = pick(result, ["role", "status", "summary", "changed_paths", "required_fixes", "blocker"]);
  if (Array.isArray(result.findings)) projected.findings = result.findings;
  if (Array.isArray(result.verification)) projected.verification = result.verification.map((item) => pick(item, ["command", "status", "evidence", "width"]));
  const content = result.deliverable?.content;
  if (content && typeof content === "object") {
    projected.review = pick(content, ["verdict", "review_manifest", "review_complete", "fix_resolution", "limitations", "verification_limits"]);
    if (Array.isArray(content.coverage)) projected.review.coverage = content.coverage.map((item) => pick(item, ["item", "status", "evidence"]));
  }
  return JSON.stringify(projected);
}

export function compactQa(material) {
  const result = parseResult(material);
  if (!result || typeof result !== "object" || !Array.isArray(result.checks)) return material.text;
  return JSON.stringify({
    ...pick(result, ["kind", "verdict", "workspace", "executor", "obstacles", "summary"]),
    checks: result.checks.map((item) => ({
      ...pick(item, ["id", "tool", "command", "status", "width", "exit", "reason", "attribution", "log", "expected_test_paths", "executed_test_paths"]),
      ...(["failed", "broken"].includes(item.status) ? pick(item, ["tail"]) : {}),
    })),
  });
}
