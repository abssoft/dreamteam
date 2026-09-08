#!/usr/bin/env node
// The executable side of the Result v1 contract for launched roles. A role
// writes its full Result to a file and returns the envelope; the wrapper runs
// this on the file before any translation, publication or state move.
//   node validate-result.mjs --result <path|-> [--expect-id <assignment_id>] [--expect-role <role>]
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, envelope}: the slim form the wrapper routes on — findings
//               dropped, deliverable content reduced to its decision fields
//               (path, verdict, behavior, why, lenses_mode), required_fixes
//               reduced to finding IDs, verification to command and status
//   ok:false → {ok, code, detail}: bad_args | bad_result (detail lists every problem)
// Beyond the JSON Schema: the role is a launched one and the deliverable kind
// matches it; a review carries no changed_paths; verification items use the
// vocabulary passed | failed | skipped | broken; `done` carries verification
// evidence and no failed item unless a required fix names it (review).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RESULT_FIELDS = ["contract_version", "assignment_id", "role", "status", "summary", "deliverable", "changed_paths", "verification", "findings", "required_fixes", "blocker"];
export const DELIVERABLE_KINDS = { "software-developer": "implementation_summary", "code-reviewer": "review_report" };
export const STATUSES = ["done", "blocked", "needs_human", "failed"];
export const VERIFICATION_STATUSES = ["passed", "failed", "skipped", "broken"];
const ENVELOPE_CONTENT = ["path", "verdict", "behavior", "why", "lenses_mode"];

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function resultProblems(result, { expectId = null, expectRole = null } = {}) {
  const problems = [];
  if (!isPlainObject(result)) return ["result must be a JSON object"];
  for (const key of Object.keys(result)) if (!RESULT_FIELDS.includes(key)) problems.push(`unknown field ${key}`);
  if (result.contract_version !== 1) problems.push("contract_version must be 1");
  if (!isText(result.assignment_id)) problems.push("assignment_id missing");
  else if (expectId !== null && result.assignment_id !== expectId) problems.push(`assignment_id ${JSON.stringify(result.assignment_id)} does not match the launched ${JSON.stringify(expectId)}`);
  const role = result.role;
  const kind = DELIVERABLE_KINDS[role];
  if (!kind) problems.push(`role must be ${Object.keys(DELIVERABLE_KINDS).join(" | ")}, got ${JSON.stringify(role ?? null)}`);
  else if (expectRole !== null && role !== expectRole) problems.push(`role ${role} does not match the launched ${expectRole}`);
  if (!STATUSES.includes(result.status)) problems.push(`status must be ${STATUSES.join(" | ")}`);
  if (typeof result.summary !== "string") problems.push("summary must be a string");
  const deliverable = result.deliverable;
  if (!isPlainObject(deliverable) || !isText(deliverable.kind) || !("content" in deliverable)) problems.push("deliverable must be {kind, content}");
  else if (kind && deliverable.kind !== kind) problems.push(`deliverable.kind must be ${kind} for ${role}, got ${JSON.stringify(deliverable.kind)}`);
  const paths = result.changed_paths;
  if (paths !== undefined && !(Array.isArray(paths) && paths.every(isText))) problems.push("changed_paths must be an array of strings");
  else if (role === "code-reviewer" && Array.isArray(paths) && paths.length > 0) problems.push("changed_paths must be empty for code-reviewer");
  const verification = result.verification;
  if (verification !== undefined && !Array.isArray(verification)) problems.push("verification must be an array");
  for (const [index, item] of (Array.isArray(verification) ? verification : []).entries()) {
    if (!isPlainObject(item) || !isText(item.command)) { problems.push(`verification[${index}] must be {command, status, evidence}`); continue; }
    if (!VERIFICATION_STATUSES.includes(item.status)) problems.push(`verification[${index}] (${item.command}): status must be ${VERIFICATION_STATUSES.join(" | ")}`);
  }
  if (result.findings !== undefined && !Array.isArray(result.findings)) problems.push("findings must be an array");
  const fixes = result.required_fixes;
  if (fixes !== undefined && !(Array.isArray(fixes) && fixes.every(isText))) problems.push("required_fixes must be an array of strings");
  if (result.blocker !== undefined && typeof result.blocker !== "string") problems.push("blocker must be a string");
  if (result.status === "done") {
    const items = Array.isArray(verification) ? verification : [];
    if (items.length === 0) problems.push("done requires verification evidence");
    const failed = items.filter((item) => isPlainObject(item) && item.status === "failed").map((item) => item.command);
    const fixCount = Array.isArray(fixes) ? fixes.length : 0;
    if (failed.length > 0 && (role !== "code-reviewer" || fixCount === 0)) {
      problems.push(`done with a failed verification item (${failed.join(", ")})${role === "code-reviewer" ? " and no required fix" : ""}`);
    }
  }
  return problems;
}

function fixId(fix) {
  const match = /^\s*([A-Za-z]+\d+)\b/.exec(fix);
  return match ? match[1] : fix.slice(0, 60);
}

export function envelopeOf(result) {
  const content = isPlainObject(result.deliverable?.content) ? result.deliverable.content : {};
  const slim = {};
  for (const key of ENVELOPE_CONTENT) if (content[key] !== undefined) slim[key] = content[key];
  const envelope = {
    contract_version: 1,
    assignment_id: result.assignment_id,
    role: result.role,
    status: result.status,
    summary: result.summary,
    deliverable: { kind: result.deliverable?.kind, content: slim },
  };
  if (Array.isArray(result.changed_paths)) envelope.changed_paths = result.changed_paths;
  if (Array.isArray(result.verification)) {
    envelope.verification = result.verification.map((item) => ({ command: item.command, status: item.status }));
  }
  if (Array.isArray(result.required_fixes)) envelope.required_fixes = result.required_fixes.map(fixId);
  if (Array.isArray(result.findings)) envelope.findings = result.findings.length ? [{ count: result.findings.length }] : [];
  if (typeof result.blocker === "string") envelope.blocker = result.blocker;
  return envelope;
}

function main() {
  const args = process.argv.slice(2);
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] ?? null : null; };
  const source = option("--result");
  const known = new Set(["--result", "--expect-id", "--expect-role"]);
  const stray = args.filter((arg, index) => arg.startsWith("--") ? !known.has(arg) : !known.has(args[index - 1]));
  if (!source || stray.length) {
    out({ ok: false, code: "bad_args", detail: "usage: validate-result.mjs --result <path|-> [--expect-id <id>] [--expect-role <role>]" });
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8"));
  } catch (error) {
    out({ ok: false, code: "bad_args", detail: `result unreadable: ${error.message}` });
    process.exit(1);
  }
  const problems = resultProblems(result, { expectId: option("--expect-id"), expectRole: option("--expect-role") });
  if (problems.length) {
    out({ ok: false, code: "bad_result", detail: problems });
    process.exit(1);
  }
  out({ ok: true, envelope: envelopeOf(result) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
