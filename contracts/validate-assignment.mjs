#!/usr/bin/env node
// The executable side of the Assignment v1 contract for launched roles. A
// wrapper runs it on the packet file before every launch; role scripts import
// `packetProblems` for the same judgement. Zero dependencies, read-only.
//   node validate-assignment.mjs --assignment <path|->
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, role, assignment_id, materials: [{name, kind, path}]}
//   ok:false → {ok, code, detail}: bad_args | bad_packet (detail lists every problem)
// Beyond the JSON Schema: the role is a launched one; `code-reviewer` names
// `repository.base_ref`; both roles carry a material named `issue` with the
// task text — inline (`kind: text`) or as the file the wrapper wrote (`kind:
// attachment_reference`, content an absolute path that exists; `issue` and
// `parent_issue` files are non-empty).

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LAUNCHED_ROLES = ["software-developer", "code-reviewer"];
export const PACKET_FIELDS = ["contract_version", "assignment_id", "role", "objective", "scope", "repository", "verification", "required_fixes", "accepted_decisions", "source_materials"];
export const MATERIAL_FIELDS = ["kind", "name", "content", "provenance"];
export const MATERIAL_KINDS = ["text", "repository_evidence", "attachment_reference"];
const TEXT_FILE_MATERIALS = ["issue", "parent_issue"];

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function fileProblem(label, content, mustBeNonEmpty) {
  const path = String(content).trim();
  if (!isAbsolute(path)) return `${label}: attachment_reference content must be an absolute path`;
  if (!existsSync(path)) return `${label}: file not found: ${path}`;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `${label}: not a file: ${path}`;
    if (mustBeNonEmpty && stat.size === 0) return `${label}: empty file: ${path}`;
  } catch {
    return `${label}: file not readable: ${path}`;
  }
  return null;
}

export function packetProblems(assignment) {
  const problems = [];
  if (!isPlainObject(assignment)) return ["assignment must be a JSON object"];
  for (const key of Object.keys(assignment)) if (!PACKET_FIELDS.includes(key)) problems.push(`unknown field ${key}`);
  if (assignment.contract_version !== 1) problems.push("contract_version must be 1");
  if (!isText(assignment.assignment_id)) problems.push("assignment_id missing");
  const role = assignment.role;
  if (!LAUNCHED_ROLES.includes(role)) problems.push(`role must be ${LAUNCHED_ROLES.join(" | ")}, got ${JSON.stringify(role ?? null)}`);
  if (!isText(assignment.objective)) problems.push("objective missing");
  const scope = assignment.scope;
  if (!isPlainObject(scope) || !Array.isArray(scope.included) || !Array.isArray(scope.excluded)) {
    problems.push("scope.included and scope.excluded must be arrays");
  }
  for (const key of ["verification", "required_fixes", "accepted_decisions"]) {
    const value = assignment[key];
    if (value !== undefined && !(Array.isArray(value) && value.every(isText))) problems.push(`${key} must be an array of strings`);
  }
  if (assignment.repository !== undefined && !isPlainObject(assignment.repository)) problems.push("repository must be an object");
  if (role === "code-reviewer" && !isText(assignment.repository?.base_ref)) problems.push("repository.base_ref missing (code-reviewer)");

  const materials = assignment.source_materials;
  if (materials !== undefined && !Array.isArray(materials)) problems.push("source_materials must be an array");
  let issueSeen = false;
  for (const [index, item] of (Array.isArray(materials) ? materials : []).entries()) {
    const name = isPlainObject(item) && isText(item.name) ? item.name : "unnamed";
    const label = `source_materials[${index}] (${name})`;
    if (!isPlainObject(item)) { problems.push(`${label} must be an object`); continue; }
    if (!MATERIAL_KINDS.includes(item.kind)) problems.push(`${label}: kind must be ${MATERIAL_KINDS.join(" | ")}`);
    if (!isText(item.content)) problems.push(`${label}: content missing`);
    if (!isText(item.provenance)) problems.push(`${label}: provenance missing`);
    for (const key of Object.keys(item)) if (!MATERIAL_FIELDS.includes(key)) problems.push(`${label}: unknown field ${key}`);
    if (item.kind === "attachment_reference" && isText(item.content)) {
      const problem = fileProblem(label, item.content, TEXT_FILE_MATERIALS.includes(name));
      if (problem) problems.push(problem);
    }
    if (name === "issue") issueSeen = true;
  }
  if (!issueSeen) problems.push("source_materials entry named issue missing");
  return problems;
}

function readPacket(source) {
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8");
  return JSON.parse(raw);
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--assignment");
  const source = at >= 0 ? args[at + 1] : null;
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!source || args.length !== 2) {
    out({ ok: false, code: "bad_args", detail: "usage: validate-assignment.mjs --assignment <path|->" });
    process.exit(1);
  }
  let assignment;
  try {
    assignment = readPacket(source);
  } catch (error) {
    out({ ok: false, code: "bad_args", detail: `packet unreadable: ${error.message}` });
    process.exit(1);
  }
  const problems = packetProblems(assignment);
  if (problems.length > 0) {
    out({ ok: false, code: "bad_packet", detail: problems });
    process.exit(1);
  }
  out({
    ok: true,
    role: assignment.role,
    assignment_id: assignment.assignment_id,
    materials: (assignment.source_materials ?? []).map((item) => ({
      name: item.name ?? null, kind: item.kind, path: item.kind === "attachment_reference" ? String(item.content).trim() : null,
    })),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
