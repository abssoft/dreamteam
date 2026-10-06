// The code-reviewer's own Result v1 checks, run by its harness before the file
// is written and by review-pack.mjs on a previous Result. The harness builds the
// Result from the journal, so shape, identity and vocabulary hold by
// construction; what is left are the invariants between the parts: findings and
// fixes, coverage and the manifest, the committed change and the workspace.
// Wrappers read the Result file themselves.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENVELOPE_CONTENT = ["path", "verdict"];

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A done review with a failed gate item needs a required fix; the invariants
// between findings, fixes, manifest and git follow.
export function reviewProblems(result) {
  const problems = [];
  if (result.status !== "done") return problems;
  const failed = (Array.isArray(result.verification) ? result.verification : []).filter((item) => isPlainObject(item) && item.status === "failed").map((item) => item.command);
  const fixes = Array.isArray(result.required_fixes) ? result.required_fixes : [];
  if (failed.length > 0 && fixes.length === 0) problems.push(`done with a failed verification item (${failed.join(", ")}) and no required fix`);
  return [...problems, ...doneReviewProblems(result)];
}

function doneReviewProblems(result) {
  const problems = [];
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const content = isPlainObject(result.deliverable?.content) ? result.deliverable.content : {};
  const fixes = Array.isArray(result.required_fixes) ? result.required_fixes.filter(isText) : [];
  const ids = new Set();
  const evidence = (value) => isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText));
  for (const finding of findings) {
    if (!isPlainObject(finding)) { problems.push("review finding must be an object"); continue; }
    if (!/^[A-Za-z]+\d+$/.test(finding.id ?? "") || ids.has(finding.id)) problems.push("review finding IDs must be unique letter/number identifiers");
    ids.add(finding.id);
    for (const key of ["category", "path", "problem", "impact", "fix"]) if (!isText(finding[key])) problems.push(`${finding.id}: ${key} missing`);
    if (!Number.isInteger(finding.line) || finding.line < 1) problems.push(`${finding.id}: positive line required`);
    if (!evidence(finding.evidence)) problems.push(`${finding.id}: evidence missing`);
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) problems.push(`${finding.id}: invalid severity`);
    if (!["confirmed", "plausible"].includes(finding.confidence)) problems.push(`${finding.id}: invalid confidence`);
    if (["P0", "P1"].includes(finding.severity)) {
      if (!isText(finding.failure_scenario ?? finding.scenario)) problems.push(`${finding.id}: failure scenario required`);
      // A finding the sceptic refuted stays for audit and asks for nothing.
      if (finding.confidence === "confirmed" && finding.status !== "refuted" && !fixes.some((fix) => fixId(fix) === finding.id)) problems.push(`${finding.id}: confirmed ${finding.severity} requires a fix`);
      // A standing unproven one is an open question; a gate finding rests on the QA result.
      if (finding.confidence === "plausible" && finding.status !== "refuted" && !/^verification(?:\/|$)/.test(finding.category ?? "")) problems.push(`${finding.id}: done with a standing plausible ${finding.severity} — confirm it, re-weigh its severity, refute it or return needs_human`);
    }
  }
  for (const fix of fixes) {
    const finding = findings.find((item) => item?.id === fixId(fix));
    if (!finding) problems.push(`required fix ${fixId(fix)} has no finding`);
    else if (finding.confidence !== "confirmed" || finding.severity === "P3" || finding.status === "refuted") problems.push(`required fix ${finding.id} must be a confirmed P0/P1/P2 finding the sceptic did not refute`);
  }
  // Older Result v1 files still validate by shape. New runs bind their
  // coverage and coordinates to the manifest the pack actually wrote.
  if (content.review_manifest !== undefined) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(content.review_manifest, "utf8")); } catch { return [...problems, "review manifest unreadable"]; }
    if (manifest.version !== 1 || manifest.assignment_id !== result.assignment_id || !Array.isArray(manifest.files) || !manifest.files.every(isText) || !isText(manifest.root) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.head ?? "") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.base ?? "")) return [...problems, "review manifest invalid or belongs to another assignment"];
    const git = (args) => {
      try { return execFileSync("git", args, { cwd: manifest.root, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trimEnd(); } catch { return null; }
    };
    if (git(["rev-parse", "HEAD"]) !== manifest.head) problems.push("review manifest HEAD changed");
    if (git(["status", "--porcelain"]) !== "") problems.push("review workspace changed after the committed input");
    const changed = git(["diff", "--name-only", "-z", `${manifest.base}..${manifest.head}`]);
    if (changed === null || JSON.stringify(changed.split("\0").filter(Boolean).sort()) !== JSON.stringify([...manifest.files].sort())) problems.push("review manifest files differ from the committed change");
    const coverage = Array.isArray(content.coverage) ? content.coverage : [];
    for (const path of manifest.files) {
      const entries = coverage.filter((item) => item?.item === path);
      if (entries.length !== 1) { problems.push(`coverage must contain exactly one entry for ${path}`); continue; }
      const entry = entries[0];
      if (!["reviewed", "not_applicable", "blocked"].includes(entry.status) || !evidence(entry.evidence)) problems.push(`coverage invalid for ${path}`);
      if (entry.status === "blocked" && content.review_complete === true) problems.push(`review_complete contradicts blocked coverage for ${path}`);
    }
    if (typeof content.review_complete !== "boolean") problems.push("review_complete boolean required");
    for (const id of manifest.previous_fixes ?? []) {
      const entries = (Array.isArray(content.fix_resolution) ? content.fix_resolution : []).filter((item) => item?.id === id);
      if (entries.length !== 1 || !["resolved", "unresolved", "regressed"].includes(entries[0]?.status) || !evidence(entries[0]?.evidence)) problems.push(`fix_resolution missing or invalid for ${id}`);
      else if (entries[0].status !== "resolved" && !fixes.some((fix) => fixId(fix) === id)) problems.push(`unresolved fix ${id} must remain required`);
    }
    for (const finding of findings.filter(isPlainObject)) {
      if (!isText(finding.path) || /^verification(?:\/|$)/.test(finding.category ?? "")) continue;
      const source = git(["show", `${manifest.head}:${finding.path}`]) ?? git(["show", `${manifest.base}:${finding.path}`]);
      if (source === null || finding.line > source.split("\n").length) problems.push(`${finding.id}: coordinates outside reviewed source`);
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
  if (Array.isArray(result.required_fixes)) envelope.required_fixes = result.required_fixes;
  if (typeof result.blocker === "string") envelope.blocker = result.blocker;
  return envelope;
}
