#!/usr/bin/env node
// One-call Assignment v1 composer for the launched roles (project-manager routes/develop.md).
// The Dispatcher passes only what it decided — mode, key, title, base, the
// files the resolution wrote, its own checks and rails, the retry material —
// and never retypes a text: the item, the parent and the mockups ride as file
// paths. The packet is validated with DreamTeam's contracts/validate-assignment.mjs
// (the installed DreamTeam's copy, resolved by bootstrap) and written to
// <runDir>/assignment-<id>.json; the launch names that path.
// Input: single CLI arg — JSON:
//   {runDir, mode: "develop"|"review", key, title, baseRef, validator,
//    files: {issue, parentIssue?, mockups?: [path, …]}, position?: "N из M",
//    verification?: [text, …], excluded?: [text, …],
//    declareGate?: true (develop, modifier `гейт`: the scope gains declaring
//    the project's QA gate — `checks` in dreamteam.json; ignored on review),
//    feedbackPath? (develop: the resolution's `files.comments.path`, the
//    absolute path of comments.md → material `feedback`,
//    the tracker comments as evidence of what did not work; ignored on review),
//    reviewPath? (the reviewer's Result file: develop retry → material `review`,
//    the retry note and top-level `required_fixes` taken from its own fixes;
//    repeat review → material `previous_review`),
//    developmentResultPath? (review: the developer's Result file → material
//    `development_result`),
//    qaResultPath? (the QA role's result file, read here — it must be a JSON of
//    kind "qa_result" with verdict green | red | unconfirmed, and the route is
//    checked against that verdict, not against the chat line: review → material
//    `qa_result`, required by DreamTeam's contract, refused on a red verdict;
//    develop → only after a red gate: material `qa_result`, the retry note and
//    top-level `required_fixes` composed from its failed items as `Q<n>` lines),
//    environmentText? (develop: stage.mjs `environment_text` → material
//    `environment`), migrationErrorPath? (develop: stage.mjs
//    `migrations.error_path` of a failed branch migration → material
//    `migration_error` with the file's text, bounded)}
// Output: one JSON line; exit 0 on ok:true, exit 1 on ok:false.
//   ok:true  → {ok, path, assignment_id, role, qa?}; review with qaResultPath
//               adds qa: {verdict, obstacles: [text], executor_broken} —
//               executor_broken: the file's executor.status is neither "ok"
//               nor "host" (obstacles then open with `executor: <detail>`
//               unless a broken check already names it),
//               or every check is broken without having run (a baseline
//               item, an exit 0 or an empty test selection ran in the
//               environment)
//   ok:false → {ok, code, detail?}: bad_args | validator_missing |
//               qa_result_invalid (qaResultPath is not a QA result file) |
//               qa_red (review on a red verdict: the change returns to
//               Development) | qa_gate_undeclared (review on a QA result
//               whose gate did not come from dreamteam.json `checks`) | qa_not_red (develop with a QA file whose verdict
//               is not red) | invalid_packet (detail lists every problem; the
//               file is kept for inspection) | write_failed

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = Object.freeze({
  develop: {
    role: "software-developer",
    objective: (key, title) => `Реализовать ${key}: ${title}`,
    excluded: ["правки вне задачи и попутная чистка", "коммиты, ветки, слияния, публикация в трекер"],
  },
  review: {
    role: "code-reviewer",
    objective: (key, title) => `Независимое ревью ${key}: ${title}`,
    excluded: ["правки кода и документации", "коммиты, ветки, слияния, публикация в трекер"],
  },
});

const DECLARE_GATE = "объявить гейт QA проекта, если его ещё нет: ключ `checks` в `dreamteam.json` корня репозитория — непустой список команд полного набора проверок проекта (линтеры, статический анализ, тесты, сборка), каждая ровно так, как её запускают правила репозитория, с хоста из корня checkout; файла нет — создать `{ \"version\": 1, \"checks\": […] }`; остальные ключи файла не трогать; команды, переписывающие файлы, и подстановки вида `{slug}` не включать";
const RETRY_NOTE = "В рабочем дереве уже лежит предыдущая попытка по этой задаче коммитами на ветке задачи; правки — в материале review.";
const QA_TAIL_CHARS = 300;
const QA_VERDICTS = ["green", "red", "unconfirmed"];
const EXECUTOR_ALIVE = ["ok", "host"];
const MIGRATION_ERROR_CHARS = 4000;

const USAGE = `assignment.mjs — composes, validates and writes one Assignment v1 (project-manager routes/develop.md).
Arg: single JSON:
 {runDir, mode: "develop"|"review", key, title, baseRef, validator,
  files: {issue, parentIssue?, mockups?: [path, …]}, position?: "N из M",
  verification?: [text, …], excluded?: [text, …],
  declareGate?: true (develop: the scope gains declaring \`checks\` in
  dreamteam.json; ignored on review),
  feedbackPath? (develop: the resolution's files.comments.path, an absolute
  path → material feedback, the tracker comments as evidence; ignored on
  review),
  reviewPath? (reviewer's Result file: develop retry → material review + retry
  note + required_fixes from its fixes; repeat review → material previous_review),
  developmentResultPath? (review: developer's Result file → material
  development_result),
  qaResultPath? (QA result file, read here: kind "qa_result", verdict
  green|red|unconfirmed. review → material qa_result, required, refused on
  verdict red; develop → only on verdict red: material qa_result +
  required_fixes Q<n> from its failed items),
  environmentText? (develop: stage.mjs environment_text → material
  environment), migrationErrorPath? (develop: stage.mjs migrations.error_path
  → material migration_error, the file's text)}
validator — the installed DreamTeam's contracts/validate-assignment.mjs
(bootstrap scripts.validate_assignment). files.* and the Result paths are
absolute paths: the resolution's issue.md, parent_issue.md and mockups, the
roles' result-<id>.json files named by their envelopes.
Output: one JSON line {ok, path, assignment_id, role, qa?}; review with
qaResultPath adds qa{verdict, obstacles[], executor_broken} — executor_broken:
executor.status outside ok|host (obstacles then open with executor: <detail>),
or every check broken without having run (a baseline item, an exit 0 or an
empty test selection ran in the environment).
ok:false codes: bad_args | validator_missing | qa_result_invalid (not a QA
result file) | qa_red (review on verdict red — return to Development) |
qa_gate_undeclared (review: the QA gate did not come from dreamteam.json) |
qa_not_red (develop with a QA file whose verdict is not red) |
invalid_packet (detail) | write_failed.
`;

const isText = (value) => typeof value === "string" && value.trim() !== "";
const textList = (value) => (Array.isArray(value) ? value.filter(isText) : []);

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(value.ok ? 0 : 1);
}

function compose(args, qa) {
  const mode = MODES[args.mode];
  const materials = [
    { kind: "attachment_reference", name: "issue", content: args.files.issue, provenance: "текст задачи из трекера" },
  ];
  if (isText(args.files.parentIssue)) {
    materials.push({ kind: "attachment_reference", name: "parent_issue", content: args.files.parentIssue, provenance: "текст родительской задачи из трекера" });
  }
  for (const mockup of textList(args.files.mockups)) {
    materials.push({ kind: "attachment_reference", name: basename(mockup), content: mockup, provenance: "макет из ТЗ, вложение задачи" });
  }
  if (isText(args.position)) {
    materials.push({ kind: "text", name: "position", content: `Подзадача ${args.position}`, provenance: "диспетчер" });
  }
  if (args.mode === "develop" && isText(args.feedbackPath)) {
    materials.push({ kind: "attachment_reference", name: "feedback", content: args.feedbackPath, provenance: "комментарии задачи из трекера" });
  }
  if (args.mode === "develop" && isText(args.reviewPath)) {
    materials.push({ kind: "attachment_reference", name: "review", content: args.reviewPath, provenance: "результат ревью" });
  }
  if (args.mode === "develop" && isText(args.qaResultPath)) {
    materials.push({ kind: "attachment_reference", name: "qa_result", content: args.qaResultPath, provenance: "результат QA: красный гейт" });
  }
  if (args.mode === "develop" && isText(args.environmentText)) {
    materials.push({ kind: "text", name: "environment", content: args.environmentText.trim(), provenance: "диспетчер" });
  }
  if (args.mode === "develop" && isText(args.migrationErrorPath)) {
    const text = readFileSync(args.migrationErrorPath, "utf8").trim().slice(-MIGRATION_ERROR_CHARS) || "(вывод пуст)";
    materials.push({ kind: "text", name: "migration_error", content: text, provenance: "ошибка базы при применении миграции ветки" });
  }
  if (args.mode === "develop" && (isText(args.reviewPath) || isText(args.qaResultPath))) {
    materials.push({ kind: "text", name: "retry_note", content: RETRY_NOTE, provenance: "диспетчер" });
  }
  if (args.mode === "review" && isText(args.qaResultPath)) {
    materials.push({ kind: "attachment_reference", name: "qa_result", content: args.qaResultPath, provenance: "результат QA" });
  }
  if (args.mode === "review" && isText(args.developmentResultPath)) {
    materials.push({ kind: "attachment_reference", name: "development_result", content: args.developmentResultPath, provenance: "результат разработки" });
  }
  if (args.mode === "review" && isText(args.reviewPath)) {
    materials.push({ kind: "attachment_reference", name: "previous_review", content: args.reviewPath, provenance: "предыдущее ревью" });
  }

  const packet = {
    contract_version: 1,
    assignment_id: `${args.mode}-${args.key}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`.toLowerCase(),
    role: mode.role,
    objective: mode.objective(args.key, args.title),
    scope: {
      included: [
        `изменение, описанное в PRD задачи ${args.key} (материал issue); без PRD — минимальное изменение по её названию и тексту`,
        ...(args.mode === "develop" && args.declareGate === true ? [DECLARE_GATE] : []),
      ],
      excluded: [...new Set([...mode.excluded, ...textList(args.excluded)])],
    },
    repository: { base_ref: args.baseRef },
    source_materials: materials,
  };
  const verification = textList(args.verification);
  if (verification.length) packet.verification = [...new Set(verification)];
  if (args.mode === "develop") {
    const fixes = [
      ...(isText(args.reviewPath) ? reviewFixes(args.reviewPath) : []),
      ...(qa ? qaFixes(qa) : []),
    ];
    if (fixes.length) packet.required_fixes = fixes;
  }
  return packet;
}

// Reviewer fixes ride verbatim; the review file rides beside them as the
// `review` material, so a fix that names a finding by ID alone is read there.
const reviewFixes = (path) => textList(JSON.parse(readFileSync(path, "utf8")).required_fixes);

// A red gate returns to the developer as fixes: one self-contained line per
// failed item, carrying the command and the tail that names the file and the
// message. The QA file rides beside them as `qa_result` for the rest.
function qaFixes(result) {
  const failed = (Array.isArray(result.checks) ? result.checks : []).filter((item) => item.status === "failed");
  return failed.map((item, index) => {
    const tail = String(item.tail ?? "").replace(/\s+/g, " ").trim().slice(-QA_TAIL_CHARS);
    return `Q${index + 1}: провал проверки ${item.tool ?? "гейта"} (${item.width ?? "width unknown"}): ${item.command}${tail ? ` — ${tail}` : ""}; ожидается зелёный прогон той же команды`;
  });
}

// The QA file is the gate's record and the chat line only its trail: the file
// is read here so the route is decided by its `verdict`, fail-closed on
// anything that is not a QA result.
function readQa(path) {
  let result;
  try {
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: "not a readable JSON file" };
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.kind !== "qa_result") return { error: 'kind must be "qa_result"' };
  if (!QA_VERDICTS.includes(result.verdict)) return { error: `verdict must be ${QA_VERDICTS.join(" | ")}` };
  return { result };
}

// What a batch needs from the gate beside the packet: a dead executor — it did
// not start, saw another checkout, or ran no check at all — fails the next
// change the same way, while one broken check among others does not. A broken
// item the executor still ran — a baseline failure the base shares, a clean
// exit its evidence does not confirm, a run that selected no test — proves the
// executor alive. A dead
// executor no broken check names yet opens the obstacles, since a gate with no
// checks lists none.
function qaSummary(result) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const notRun = (item) => item?.status === "broken" && item.attribution !== "baseline" && item.exit !== 0 && !/^no test selected/.test(item.reason ?? "");
  const executorDead = !EXECUTOR_ALIVE.includes(result.executor?.status);
  const executorBroken = executorDead || (checks.length > 0 && checks.every(notRun));
  const obstacles = textList(result.obstacles);
  if (executorDead) {
    const detail = isText(result.executor?.detail) ? result.executor.detail : `status ${result.executor?.status ?? "missing"}`;
    if (!obstacles.some((item) => item.includes("executor: "))) obstacles.unshift(`executor: ${detail}`);
  }
  return { verdict: result.verdict, obstacles, executor_broken: executorBroken };
}

async function main() {
  if (process.argv[2] === "--usage") {
    process.stdout.write(USAGE);
    return;
  }
  let args;
  try {
    args = JSON.parse(process.argv[2] ?? "");
  } catch {
    out({ ok: false, code: "bad_args", detail: "single JSON argument required" });
  }
  const problems = [];
  if (!args || typeof args !== "object") out({ ok: false, code: "bad_args", detail: "single JSON argument required" });
  if (!isText(args.runDir) || !isAbsolute(args.runDir)) problems.push("runDir must be an absolute path");
  if (!MODES[args.mode]) problems.push("mode must be develop | review");
  for (const field of ["key", "title", "baseRef"]) if (!isText(args[field])) problems.push(`${field} missing`);
  if (!args.files || typeof args.files !== "object" || !isText(args.files.issue) || !isAbsolute(args.files.issue)) problems.push("files.issue must be an absolute path");
  if (!isText(args.validator)) problems.push("validator missing");
  for (const field of ["feedbackPath", "reviewPath", "developmentResultPath", "qaResultPath", "migrationErrorPath"]) {
    if (args[field] !== undefined && !(isText(args[field]) && isAbsolute(args[field]))) problems.push(`${field} must be an absolute path`);
  }
  if (args.mode === "develop" && isText(args.reviewPath) && isAbsolute(args.reviewPath)) {
    try { JSON.parse(readFileSync(args.reviewPath, "utf8")); } catch { problems.push("reviewPath is not a readable JSON file"); }
  }
  if (isText(args.feedbackPath) && isAbsolute(args.feedbackPath)) {
    try { readFileSync(args.feedbackPath); } catch { problems.push("feedbackPath is not a readable file"); }
  }
  if (isText(args.migrationErrorPath) && isAbsolute(args.migrationErrorPath) && !existsSync(args.migrationErrorPath)) problems.push("migrationErrorPath is not a readable file");
  if (problems.length) out({ ok: false, code: "bad_args", detail: problems });
  if (!existsSync(args.validator)) out({ ok: false, code: "validator_missing", detail: args.validator });

  let qa = null;
  if (isText(args.qaResultPath)) {
    const read = readQa(args.qaResultPath);
    if (read.error) out({ ok: false, code: "qa_result_invalid", detail: `${args.qaResultPath}: ${read.error}` });
    qa = read.result;
    if (args.mode === "review" && qa.verdict === "red") out({ ok: false, code: "qa_red", detail: "verdict red: the change returns to Development, not to Review" });
    if (args.mode === "review" && qa.gate !== "profile") out({ ok: false, code: "qa_gate_undeclared", detail: "the QA result's gate did not come from `checks` of the workspace's dreamteam.json" });
    if (args.mode === "develop" && qa.verdict !== "red") out({ ok: false, code: "qa_not_red", detail: `verdict ${qa.verdict}: a QA return is composed only from a red gate` });
  }

  const { packetProblems } = await import(pathToFileURL(resolve(args.validator)).href);
  const packet = compose(args, qa);
  const path = join(resolve(args.runDir), `assignment-${packet.assignment_id}.json`);
  try {
    mkdirSync(resolve(args.runDir), { recursive: true });
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
  } catch (error) {
    out({ ok: false, code: "write_failed", detail: String(error.message) });
  }
  const invalid = packetProblems(packet);
  if (invalid.length) out({ ok: false, code: "invalid_packet", detail: invalid, path });
  out({ ok: true, path, assignment_id: packet.assignment_id, role: packet.role, ...(args.mode === "review" && qa ? { qa: qaSummary(qa) } : {}) });
}

main();
