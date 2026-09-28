#!/usr/bin/env node
// The findings harness of the code-reviewer role: every finding, verdict,
// coverage item and phase status goes into the review journal through this
// script, and the Result v1 file is written from that journal — the model
// never assembles the Result JSON itself. Each record is checked on the way in:
// a finding hangs on lines the change touched, rests on cited evidence, names
// one consequence, and carries a failure scenario at P0/P1. Zero dependencies.
//
//   node review-findings.mjs --manifest <path> <command> [flags]
//
// The manifest is the one review-pack.mjs wrote (its `harness` output is this
// prefix). Commands, each answering one JSON line (exit 1 on a refusal):
//   finding   record a finding               list      print the journal
//   amend     correct an own finding         verdict   the sceptic's verdict
//   covered   account for a file/scenario    resolve   a previous fix's disposition
//   phase     close a phase with its status  batch     several records in one call
//   summary   write the Result, print the envelope
// `<command> --help` prints its flags.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { envelopeOf, resultProblems } from "../../../contracts/validate-result.mjs";

const PHASES = { behavior: "B", rules: "R", quality: "Q", comments: "C", gate: "G" };
const PHASE_ORDER = ["behavior", "rules", "quality", "comments", "sceptic"];
const SEVERITIES = ["P0", "P1", "P2", "P3"];
const CONFIDENCES = ["confirmed", "plausible"];
const COVERAGE = ["reviewed", "not_applicable", "blocked"];
const RESOLUTIONS = ["resolved", "unresolved", "regressed"];
const STATUSES = ["done", "blocked", "needs_human", "failed"];
const RELATED = /^[^\s:,]+(?::\d+(?:-\d+)?)?$/;

const FINDING_FLAGS = {
  phase: `the phase that found it: ${Object.keys(PHASES).join(" | ")} [required]`,
  severity: `${SEVERITIES.join(" | ")} [required]`,
  category: "correctness, security, data, rule, design, comment, test, verification/… [required]",
  file: "repository-relative path, as in the diff [required]",
  line: "first line of the fragment [required]",
  lineEnd: "last line of it; defaults to --line",
  deleted: "the fragment is deleted lines, numbered on the base side (flag)",
  problem: "what is wrong, in terse Russian [required]",
  impact: "the one consequence that puts it at its severity, distinct from --problem [required]",
  fix: "the smallest safe fix [required]",
  related: "what it rests on: «path», «path:line» or «path:line-line», comma-separated; code outside the change goes here, never into the anchor [required]",
  scenario: "the triggering input or state and expected versus actual [required at P0/P1]",
  confidence: `${CONFIDENCES.join(" | ")} [required]`,
  optional: "P2 only: why acceptance and release safety stay unaffected, keeping it out of required fixes",
  owner: "qa, when the fault is the gate's selection or bootstrap",
  check: "the qa_result check id a gate finding stands on [required for --phase gate]",
  reopens: "a previous required fix this finding keeps open: its original ID becomes this finding's ID",
};

const COMMANDS = {
  finding: { summary: "record a finding anchored to lines the change touched", flags: FINDING_FLAGS },
  amend: { summary: "correct a finding by its ID; only the named fields change", flags: { id: "the finding ID [required]", ...Object.fromEntries(Object.entries(FINDING_FLAGS).filter(([key]) => !["phase", "reopens"].includes(key)).map(([key, hint]) => [key, hint.replace(" [required]", "")])) } },
  list: { summary: "print every finding with its verdict, and what coverage and phases still lack", flags: {} },
  verdict: { summary: "the sceptic's verdict on one finding; a revised severity rides along", flags: { id: "the finding ID [required]", holds: "the finding stands (flag)", refuted: "code proves the opposite of its claim (flag)", reason: "the code that settles it, or why the severity moves [required]", severity: `a revised ${SEVERITIES.join(" | ")}` } },
  covered: { summary: "account for a manifest file, an acceptance scenario or a rule", flags: { item: "the exact manifest path, or the scenario or rule [required]", status: `${COVERAGE.join(" | ")} [required]`, evidence: "what was read, or why it does not apply, or the gap [required]" } },
  resolve: { summary: "the disposition of a previous required fix", flags: { id: "the previous fix ID [required]", status: `${RESOLUTIONS.join(" | ")} [required]`, evidence: "what the code shows now [required]" } },
  phase: { summary: "close a phase with a one-line status", flags: { name: `${PHASE_ORDER.join(" | ")} [required]`, status: "one line: what it walked and what it found [required]" } },
  batch: { summary: "several records in one call; a refused one comes back named, the rest are in", flags: { json: "a JSON array of {\"type\":\"finding|amend|verdict|covered|resolve|phase\", …flags in camelCase} [required]" } },
  summary: { summary: "write the Result v1 file from the journal and print its envelope", flags: { status: `${STATUSES.join(" | ")} [required]`, summary: "one sentence for the wrapper, in Russian [required]", verdict: "the verdict on the change as a whole, in Russian [required]", blocker: "the precise cause, when the status is not done" } },
};

class Refusal extends Error {}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const camel = (flag) => flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
const kebab = (key) => key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
const BOOLEAN_FLAGS = new Set(["deleted", "holds", "refuted"]);

export function parseFlags(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new Refusal(`unexpected argument ${JSON.stringify(arg)}: every value follows its --flag`);
    const key = camel(arg.slice(2));
    if (BOOLEAN_FLAGS.has(key) || key === "help") { values[key] = true; continue; }
    if (i + 1 >= args.length) throw new Refusal(`${arg} needs a value`);
    values[key] = args[i + 1];
    i += 1;
  }
  return values;
}

function help(command) {
  const spec = COMMANDS[command];
  const rows = Object.entries(spec.flags).map(([key, hint]) => `  --${kebab(key)}  ${hint}`);
  return `${command}: ${spec.summary}\n${rows.join("\n")}`;
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// Lines the change touched, per file: new-side added lines and base-side
// deleted lines, from the zero-context diff of the whole reviewed range.
export function changedLineMap(diffText) {
  const map = new Map();
  let entry = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    const target = /^\+\+\+ (?:b\/)?(.*)$/.exec(raw);
    if (target) {
      if (target[1] !== "/dev/null") { entry = map.get(target[1]) ?? { added: new Set(), deleted: new Set() }; map.set(target[1], entry); }
      continue;
    }
    const source = /^--- (?:a\/)?(.*)$/.exec(raw);
    if (source) {
      entry = null;
      if (source[1] !== "/dev/null") { entry = map.get(source[1]) ?? { added: new Set(), deleted: new Set() }; map.set(source[1], entry); }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!entry) continue;
    if (raw.startsWith("+")) { entry.added.add(newLine); newLine += 1; }
    else if (raw.startsWith("-")) { entry.deleted.add(oldLine); oldLine += 1; }
  }
  return map;
}

// A renamed file's lines land under its new path, a deleted file's under its
// old one.
function lineMap(manifest) {
  return changedLineMap(git(manifest.root, ["diff", "-U0", "-M", `${manifest.base}..${manifest.head}`]) ?? "");
}

const compress = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else ranges.push([n, n]);
  }
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
};

function parseRelated(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter((item) => RELATED.test(item));
}

function positive(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Refusal(`--${flag} must be a positive line number`);
  return number;
}

function nextId(journal, manifest, letter) {
  const taken = new Set([...journal.findings.map((item) => item.id), ...manifest.previous_ids ?? [], ...manifest.previous_fixes ?? []]);
  for (let n = 1; ; n += 1) if (!taken.has(`${letter}${n}`)) return `${letter}${n}`;
}

// Every rule a finding must meet, whether it is new or amended.
function checkFinding(finding, context) {
  const { manifest } = context;
  for (const key of ["severity", "category", "file", "problem", "impact", "fix", "confidence"]) {
    if (!isText(finding[key])) throw new Refusal(`--${kebab(key)} is required`);
  }
  if (!SEVERITIES.includes(finding.severity)) throw new Refusal(`--severity must be ${SEVERITIES.join(" | ")}`);
  if (!CONFIDENCES.includes(finding.confidence)) throw new Refusal(`--confidence must be ${CONFIDENCES.join(" | ")}`);
  if (finding.impact.trim().toLowerCase() === finding.problem.trim().toLowerCase()) throw new Refusal("--impact restates --problem: name the one consequence that puts the finding at its severity");
  if (["P0", "P1"].includes(finding.severity) && !isText(finding.scenario)) throw new Refusal(`--scenario is required at ${finding.severity}: the triggering input or state and expected versus actual`);
  if (isText(finding.optional) && finding.severity !== "P2") throw new Refusal("--optional applies to P2 only");
  if (finding.related.length === 0) throw new Refusal("--related is required: where you looked to establish the finding («path:line», comma-separated); an obvious one-line finding gives that line");
  if (finding.owner !== undefined && finding.owner !== "qa") throw new Refusal("--owner takes qa only");
  if (finding.lineEnd < finding.line) throw new Refusal("--line-end is less than --line");
  if (finding.phase === "gate") {
    const check = (manifest.qa_checks ?? []).find((item) => item.id === finding.check);
    if (!check) throw new Refusal(`--check must name a qa_result check: ${(manifest.qa_checks ?? []).map((item) => item.id).join(", ") || "the gate lists none"}`);
    if (!["failed", "broken"].includes(check.status)) throw new Refusal(`check ${check.id} is ${check.status}: only a failed or broken check stands under a gate finding`);
    if (!/^verification(?:\/|$)/.test(finding.category)) throw new Refusal("a gate finding's --category starts with verification/");
    return;
  }
  const lines = context.lines();
  const entry = lines.get(finding.file);
  const side = finding.deleted ? "deleted" : "added";
  if (!entry || entry[side].size === 0) {
    throw new Refusal(finding.deleted
      ? `${finding.file} deleted no lines in this change — there is nothing for --deleted to anchor to`
      : `${finding.file} is not among the lines this change added; code outside the change goes into --related, the anchor stays on the changed line that causes the problem`);
  }
  for (const number of [finding.line, finding.lineEnd]) {
    if (!entry[side].has(number)) {
      throw new Refusal(`line ${number} of ${finding.file} was not ${finding.deleted ? "deleted" : "changed"} by this change — ${finding.deleted ? "deleted" : "changed"} lines: ${compress(entry[side])}`);
    }
  }
}

function toFinding(values, base = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(values)) if (key !== "id" && key !== "type" && value !== undefined) merged[key] = value;
  if (values.line !== undefined) merged.line = positive(values.line, "line");
  if (values.lineEnd !== undefined) merged.lineEnd = positive(values.lineEnd, "line-end");
  else if (values.line !== undefined && base.lineEnd === undefined) merged.lineEnd = merged.line;
  if (values.related !== undefined) merged.related = parseRelated(values.related);
  merged.related ??= [];
  merged.deleted = Boolean(merged.deleted);
  return merged;
}

const handlers = {
  finding(values, context) {
    const { journal, manifest } = context;
    if (!Object.hasOwn(PHASES, values.phase)) throw new Refusal(`--phase must be ${Object.keys(PHASES).join(" | ")}`);
    if (values.phase === "gate") {
      values.file ??= "qa_result";
      values.line ??= "1";
    }
    if (!isText(values.file)) throw new Refusal("--file is required");
    if (values.line === undefined) throw new Refusal("--line is required");
    const finding = toFinding(values);
    checkFinding(finding, context);
    let id;
    if (isText(values.reopens)) {
      if (!(manifest.previous_fixes ?? []).includes(values.reopens)) throw new Refusal(`--reopens must name a previous required fix: ${(manifest.previous_fixes ?? []).join(", ") || "none"}`);
      if (journal.findings.some((item) => item.id === values.reopens)) throw new Refusal(`${values.reopens} is already recorded; amend it`);
      id = values.reopens;
    } else id = nextId(journal, manifest, PHASES[values.phase]);
    journal.findings.push({ id, ...finding });
    return { id, anchor: `${finding.file}:${finding.line}-${finding.lineEnd}` };
  },
  amend(values, context) {
    const at = context.journal.findings.findIndex((item) => item.id === values.id);
    if (at < 0) throw new Refusal(`no finding ${values.id}; list prints the IDs`);
    const current = context.journal.findings[at];
    const { phase, reopens, ...changes } = values;
    if (phase !== undefined || reopens !== undefined) throw new Refusal("--phase and --reopens are fixed when a finding is recorded");
    const next = toFinding(changes, current);
    checkFinding(next, context);
    context.journal.findings[at] = next;
    return { id: current.id, amended: Object.keys(values).filter((key) => !["id", "type"].includes(key)) };
  },
  verdict(values, context) {
    const finding = context.journal.findings.find((item) => item.id === values.id);
    if (!finding) throw new Refusal(`no finding ${values.id}; list prints the IDs`);
    if (Boolean(values.holds) === Boolean(values.refuted)) throw new Refusal("give exactly one of --holds or --refuted");
    if (!isText(values.reason)) throw new Refusal("--reason is required: the code that settles the claim");
    if (values.severity !== undefined) {
      if (!SEVERITIES.includes(values.severity)) throw new Refusal(`--severity must be ${SEVERITIES.join(" | ")}`);
      if (["P0", "P1"].includes(values.severity) && !isText(finding.scenario)) throw new Refusal(`raising ${finding.id} to ${values.severity} needs its failure scenario first: amend --scenario`);
      if (values.severity !== "P2") delete finding.optional;
      finding.severityFrom = finding.severity;
      finding.severity = values.severity;
    }
    finding.verdict = { holds: Boolean(values.holds), reason: values.reason };
    return { id: finding.id, status: finding.verdict.holds ? "stands" : "refuted", severity: finding.severity };
  },
  covered(values, context) {
    if (!isText(values.item)) throw new Refusal("--item is required");
    if (!COVERAGE.includes(values.status)) throw new Refusal(`--status must be ${COVERAGE.join(" | ")}`);
    if (!isText(values.evidence)) throw new Refusal("--evidence is required");
    context.journal.coverage[values.item] = { status: values.status, evidence: values.evidence };
    return { item: values.item, status: values.status };
  },
  resolve(values, context) {
    const fixes = context.manifest.previous_fixes ?? [];
    if (!fixes.includes(values.id)) throw new Refusal(`--id must name a previous required fix: ${fixes.join(", ") || "none"}`);
    if (!RESOLUTIONS.includes(values.status)) throw new Refusal(`--status must be ${RESOLUTIONS.join(" | ")}`);
    if (!isText(values.evidence)) throw new Refusal("--evidence is required");
    context.journal.fix_resolution[values.id] = { status: values.status, evidence: values.evidence };
    return { id: values.id, status: values.status, ...(values.status === "resolved" ? {} : { next: `record the open defect with finding --reopens ${values.id}` }) };
  },
  phase(values, context) {
    if (!PHASE_ORDER.includes(values.name)) throw new Refusal(`--name must be ${PHASE_ORDER.join(" | ")}`);
    if (!isText(values.status)) throw new Refusal("--status is required");
    context.journal.phases[values.name] = values.status;
    return { phase: values.name };
  },
  list(_values, context) {
    const { journal, manifest } = context;
    return {
      findings: journal.findings.map((item) => `${item.id} ${item.severity} ${item.verdict ? (item.verdict.holds ? "stands" : "refuted") : "open"} ${item.file}:${item.line}-${item.lineEnd} — ${item.problem}`),
      uncovered: manifest.files.filter((path) => !journal.coverage[path]),
      phases_open: PHASE_ORDER.filter((name) => !journal.phases[name]),
      fixes_open: (manifest.previous_fixes ?? []).filter((id) => !journal.fix_resolution[id]),
    };
  },
};

function applyBatch(values, context) {
  let events;
  try { events = JSON.parse(values.json); } catch { throw new Refusal("--json is not parseable JSON; nothing was recorded"); }
  if (!Array.isArray(events)) throw new Refusal("--json must be an array");
  const recorded = [];
  const refused = [];
  for (const [index, event] of events.entries()) {
    const type = event?.type;
    if (!["finding", "amend", "verdict", "covered", "resolve", "phase"].includes(type)) { refused.push({ index, refused: `type must be finding | amend | verdict | covered | resolve | phase` }); continue; }
    const flags = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "number" ? String(value) : value]));
    try { recorded.push({ index, type, ...handlers[type](flags, context) }); } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refused.push({ index, type, refused: error.message });
    }
  }
  return { recorded, refused };
}

// The Result v1 file, whole, from the journal; required fixes follow the
// severity rules so the model never decides them by hand.
export function buildResult(values, { journal, manifest, manifestPath }) {
  if (!STATUSES.includes(values.status)) throw new Refusal(`--status must be ${STATUSES.join(" | ")}`);
  for (const key of ["summary", "verdict"]) if (!isText(values[key])) throw new Refusal(`--${key} is required`);
  const uncovered = manifest.files.filter((path) => !journal.coverage[path]);
  const unjudged = journal.findings.filter((item) => !item.verdict).map((item) => item.id);
  const phasesOpen = PHASE_ORDER.filter((name) => !journal.phases[name]);
  const fixesOpen = (manifest.previous_fixes ?? []).filter((id) => !journal.fix_resolution[id]);
  const reopened = Object.entries(journal.fix_resolution).filter(([id, item]) => item.status !== "resolved" && !journal.findings.some((finding) => finding.id === id)).map(([id]) => id);
  if (values.status === "done") {
    const gaps = [
      uncovered.length ? `uncovered files: ${uncovered.join(", ")}` : "",
      phasesOpen.length ? `phases not closed: ${phasesOpen.join(", ")}` : "",
      unjudged.length ? `findings without a sceptic verdict: ${unjudged.join(", ")}` : "",
      fixesOpen.length ? `previous fixes without a disposition: ${fixesOpen.join(", ")}` : "",
      reopened.length ? `unresolved previous fixes without a finding --reopens: ${reopened.join(", ")}` : "",
    ].filter(Boolean);
    if (gaps.length) throw new Refusal(`a done review accounts for everything — ${gaps.join("; ")}`);
  } else if (!isText(values.blocker)) throw new Refusal(`--blocker is required for ${values.status}`);

  const findings = journal.findings.map((item) => ({
    id: item.id,
    severity: item.severity,
    category: item.category,
    path: item.file,
    line: item.line,
    line_end: item.lineEnd,
    ...(item.deleted ? { deleted: true } : {}),
    problem: item.problem,
    impact: item.impact,
    evidence: item.related,
    fix: item.fix,
    confidence: item.confidence,
    ...(isText(item.scenario) ? { failure_scenario: item.scenario } : {}),
    phase: item.phase,
    ...(item.owner ? { owner: item.owner } : {}),
    ...(item.check ? { check: item.check } : {}),
    ...(isText(item.optional) ? { optional: item.optional } : {}),
    status: item.verdict ? (item.verdict.holds ? "stands" : "refuted") : "unjudged",
    ...(item.verdict ? { verdict_reason: item.verdict.reason } : {}),
    ...(item.severityFrom ? { severity_from: item.severityFrom } : {}),
  }));
  const required = findings.filter((item) => item.status !== "refuted" && item.confidence === "confirmed" && (
    ["P0", "P1"].includes(item.severity) || (item.severity === "P2" && !manifest.repeat && !isText(item.optional))
  ));
  const covered = manifest.files.filter((path) => journal.coverage[path]);
  const reviewComplete = uncovered.length === 0 && covered.every((path) => journal.coverage[path].status !== "blocked") && phasesOpen.length === 0;
  const content = {
    verdict: values.verdict,
    review_manifest: resolve(manifestPath),
    review_complete: reviewComplete,
    coverage: Object.entries(journal.coverage).map(([item, entry]) => ({ item, status: entry.status, evidence: entry.evidence })),
    phases: journal.phases,
    ...(Object.keys(journal.fix_resolution).length ? { fix_resolution: Object.entries(journal.fix_resolution).map(([id, item]) => ({ id, ...item })) } : {}),
    path: manifest.result,
  };
  const verification = (manifest.qa_checks ?? []).map((item) => ({
    command: item.command,
    status: ["passed", "failed", "broken", "skipped"].includes(item.status) ? item.status : "broken",
    evidence: `по результату QA${item.width ? `: ${item.width}` : ""}`,
    ...(item.width ? { width: item.width } : {}),
  }));
  return {
    contract_version: 1,
    assignment_id: manifest.assignment_id,
    role: "code-reviewer",
    status: values.status,
    summary: values.summary,
    deliverable: { kind: "review_report", content },
    verification,
    findings,
    required_fixes: required.map((item) => `${item.id}: ${item.problem} — ${item.fix}`),
    ...(isText(values.blocker) ? { blocker: values.blocker } : {}),
  };
}

const context = {};

function main() {
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const args = process.argv.slice(2);
  try {
    if (args[0] !== "--manifest" || !args[1]) throw new Refusal("usage: review-findings.mjs --manifest <path> <command> [flags]; commands: " + Object.keys(COMMANDS).join(", "));
    const command = args[2];
    if (!Object.hasOwn(COMMANDS, command)) throw new Refusal(`unknown command ${JSON.stringify(command ?? "")}; commands: ${Object.keys(COMMANDS).join(", ")}`);
    const values = parseFlags(args.slice(3));
    if (values.help) { process.stdout.write(`${help(command)}\n`); return; }
    context.manifestPath = args[1];
    context.manifest = JSON.parse(readFileSync(args[1], "utf8"));
    context.journal = JSON.parse(readFileSync(context.manifest.journal, "utf8"));
    let cached = null;
    context.lines = () => (cached ??= lineMap(context.manifest));
    if (command === "summary") {
      const result = buildResult(values, context);
      const problems = resultProblems(result);
      if (problems.length) throw new Refusal(`the Result would not validate: ${problems.join("; ")}`);
      writeFileSync(context.manifest.result, `${JSON.stringify(result, null, 1)}\n`);
      out(envelopeOf(result));
      return;
    }
    const answer = command === "batch" ? applyBatch(values, context) : handlers[command](values, context);
    if (command !== "list") writeFileSync(context.manifest.journal, `${JSON.stringify(context.journal)}\n`);
    out({ ok: !(answer.refused?.length), ...answer });
    if (answer.refused?.length) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    out({ ok: false, refused: error.message });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
