import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "project-manager", "scripts", "assignment.mjs");

function run(arg) {
    try {
        return { code: 0, json: JSON.parse(execFileSync("node", [scriptPath, typeof arg === "string" ? arg : JSON.stringify(arg)], { encoding: "utf8" })) };
    } catch (error) {
        return { code: error.status, json: JSON.parse(String(error.stdout).trim().split("\n").pop()) };
    }
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dt-assignment-"));
    const validator = join(root, "validate-assignment.mjs");
    // A stand-in for DreamTeam's contract: rejects a packet whose objective says so.
    await writeFile(validator, 'export function packetProblems(a) { return a.objective.includes("REJECT") ? ["rejected by validator"] : []; }\n');
    const media = join(root, "media");
    await writeFile(join(root, "issue.md"), "# PRJ-7 Title\n\nbody\n");
    await writeFile(join(root, "parent_issue.md"), "# PRJ-1 Parent\n\nparent body\n");
    // The reviewer's and the developer's Result files a retry and a repeat review ride on.
    await writeFile(join(root, "result-review.json"), JSON.stringify({ required_fixes: [] }));
    await writeFile(join(root, "result-dev.json"), JSON.stringify({ status: "done" }));
    return { root, validator, media, issue: join(root, "issue.md"), parent: join(root, "parent_issue.md") };
}

// The shape DreamTeam's qa-run.mjs writes; only the fields the composer reads.
function qaResult(overrides = {}) {
    return {
        kind: "qa_result", executor: { status: "ok" }, gate: "profile", verdict: "green",
        checks: [{ id: "c1", tool: "phpunit", command: "vendor/bin/phpunit", width: "full", status: "passed", tail: "" }],
        obstacles: [], summary: { passed: 1, failed: 0, broken: 0, skipped: 0 },
        ...overrides
    };
}

test("--usage prints the contract", () => {
    const usage = execFileSync("node", [scriptPath, "--usage"], { encoding: "utf8" });
    assert.match(usage, /^assignment\.mjs — /);
    assert.match(usage, /invalid_packet/);
});

test("develop packet: files ride as attachment references, rails and checks are built in, retry adds the review file and a note", async () => {
    const f = await fixture();
    try {
        const first = run({ runDir: f.root, mode: "develop", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue } });
        assert.equal(first.code, 0, JSON.stringify(first.json));
        assert.equal(first.json.role, "software-developer");
        assert.match(first.json.assignment_id, /^develop-prj-7-/);
        const packet = JSON.parse(await readFile(first.json.path, "utf8"));
        assert.equal(packet.contract_version, 1);
        assert.equal(packet.objective, "Реализовать PRJ-7: Title");
        assert.deepEqual(packet.repository, { base_ref: "master" });
        assert.equal(packet.verification, undefined, "no built-in prose check: the gate is the QA role's");
        assert.deepEqual(packet.source_materials, [
            { kind: "attachment_reference", name: "issue", content: f.issue, provenance: "текст задачи из трекера" }
        ]);
        assert.equal(packet.required_fixes, undefined);

        const retry = run({
            runDir: f.root, mode: "develop", key: "PRJ-7", title: "Title", baseRef: "PRJ-1", validator: f.validator,
            files: { issue: f.issue, parentIssue: f.parent, mockups: [join(f.root, "shot.png")] },
            position: "2 из 3", verification: ["npm test"], excluded: ["миграции"], reviewPath: join(f.root, "result-review.json")
        });
        assert.equal(retry.code, 0, JSON.stringify(retry.json));
        const again = JSON.parse(await readFile(retry.json.path, "utf8"));
        assert.equal(again.required_fixes, undefined, "fixes travel inside the review file");
        assert.deepEqual(again.verification, ["npm test"]);
        assert.ok(again.scope.excluded.includes("миграции"));
        assert.deepEqual(again.source_materials.map((m) => [m.kind, m.name]), [
            ["attachment_reference", "issue"], ["attachment_reference", "parent_issue"], ["attachment_reference", "shot.png"],
            ["text", "position"], ["attachment_reference", "review"], ["text", "retry_note"]
        ]);
        assert.equal(again.source_materials[3].content, "Подзадача 2 из 3");
        assert.equal(again.source_materials[4].content, join(f.root, "result-review.json"));

        const qaFile = join(f.root, "qa-result.json");
        await writeFile(qaFile, JSON.stringify({ kind: "qa_result", verdict: "red", checks: [
            { id: "c1", tool: "phpunit", command: "vendor/bin/phpunit tests/ATest.php", width: "narrowed to the change", status: "failed", tail: "1) ATest::testSum\nFailed asserting that 0 matches expected 3.\n\nFAILURES!" },
            { id: "c2", tool: "phpcs", command: "vendor/bin/phpcs src/A.php", width: "narrowed to the change", status: "passed", tail: "" },
            { id: "c3", tool: "rector", command: "vendor/bin/rector process --dry-run src/A.php", width: "narrowed to the change", status: "failed", tail: "" }
        ] }));
        const afterQa = run({ runDir: f.root, mode: "develop", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue }, qaResultPath: qaFile });
        assert.equal(afterQa.code, 0, JSON.stringify(afterQa.json));
        const fixes = JSON.parse(await readFile(afterQa.json.path, "utf8"));
        assert.deepEqual(fixes.required_fixes, [
            "Q1: провал проверки phpunit (narrowed to the change): vendor/bin/phpunit tests/ATest.php — 1) ATest::testSum Failed asserting that 0 matches expected 3. FAILURES!; ожидается зелёный прогон той же команды",
            "Q2: провал проверки rector (narrowed to the change): vendor/bin/rector process --dry-run src/A.php; ожидается зелёный прогон той же команды"
        ]);
        assert.deepEqual(fixes.source_materials.map((m) => [m.kind, m.name]), [["attachment_reference", "issue"], ["attachment_reference", "qa_result"], ["text", "retry_note"]]);
        assert.equal(fixes.source_materials[1].provenance, "результат QA: красный гейт");
        await writeFile(qaFile, "not json");
        assert.equal(run({ runDir: f.root, mode: "develop", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue }, qaResultPath: qaFile }).json.code, "qa_result_invalid");
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("review packet carries the QA result, the development result and the previous review as files; the validator's verdict is final", async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.root, "qa-result.json"), JSON.stringify(qaResult()));
        const review = run({
            runDir: f.root, mode: "review", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator,
            files: { issue: f.issue }, developmentResultPath: join(f.root, "result-dev.json"), reviewPath: join(f.root, "result-review.json"), qaResultPath: join(f.root, "qa-result.json")
        });
        assert.equal(review.code, 0, JSON.stringify(review.json));
        assert.deepEqual(review.json.qa, { verdict: "green", obstacles: [], executor_broken: false });
        const packet = JSON.parse(await readFile(review.json.path, "utf8"));
        assert.equal(packet.role, "code-reviewer");
        assert.equal(packet.objective, "Независимое ревью PRJ-7: Title");
        assert.deepEqual(packet.repository, { base_ref: "master" });
        assert.equal(packet.required_fixes, undefined);
        assert.deepEqual(packet.source_materials.slice(1), [
            { kind: "attachment_reference", name: "qa_result", content: join(f.root, "qa-result.json"), provenance: "результат QA" },
            { kind: "attachment_reference", name: "development_result", content: join(f.root, "result-dev.json"), provenance: "результат разработки" },
            { kind: "attachment_reference", name: "previous_review", content: join(f.root, "result-review.json"), provenance: "предыдущее ревью" }
        ]);
        const relative = run({ runDir: f.root, mode: "review", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue }, developmentResultPath: "result-dev.json" });
        assert.deepEqual(relative.json, { ok: false, code: "bad_args", detail: ["developmentResultPath must be an absolute path"] });

        const rejected = run({ runDir: f.root, mode: "review", key: "PRJ-7", title: "REJECT me", baseRef: "master", validator: f.validator, files: { issue: f.issue } });
        assert.equal(rejected.code, 1);
        assert.equal(rejected.json.code, "invalid_packet");
        assert.deepEqual(rejected.json.detail, ["rejected by validator"]);
        assert.ok(rejected.json.path.startsWith(f.root), "the rejected packet stays on disk for inspection");
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("feedbackPath rides the task's comments file into a develop packet as the feedback material", async () => {
    const f = await fixture();
    try {
        const comments = join(f.root, "comments.md");
        await writeFile(comments, "### tester\n\nне работает на проде\n");
        const base = { runDir: f.root, key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue, parentIssue: f.parent }, position: "2 из 3" };

        const develop = run({ ...base, mode: "develop", feedbackPath: comments, reviewPath: join(f.root, "result-review.json") });
        assert.equal(develop.code, 0, JSON.stringify(develop.json));
        const packet = JSON.parse(await readFile(develop.json.path, "utf8"));
        assert.deepEqual(packet.source_materials.map((m) => m.name), ["issue", "parent_issue", "position", "feedback", "review", "retry_note"]);
        assert.deepEqual(packet.source_materials[3], { kind: "attachment_reference", name: "feedback", content: comments, provenance: "комментарии задачи из трекера" });

        await writeFile(join(f.root, "qa-result.json"), JSON.stringify(qaResult()));
        const review = run({ ...base, mode: "review", feedbackPath: comments, qaResultPath: join(f.root, "qa-result.json") });
        assert.equal(review.code, 0, JSON.stringify(review.json));
        const reviewPacket = JSON.parse(await readFile(review.json.path, "utf8"));
        assert.ok(!reviewPacket.source_materials.some((m) => m.name === "feedback"), "the reviewer gets no feedback material");

        assert.deepEqual(run({ ...base, mode: "develop", feedbackPath: "comments.md" }).json, { ok: false, code: "bad_args", detail: ["feedbackPath must be an absolute path"] });
        assert.deepEqual(run({ ...base, mode: "develop", feedbackPath: join(f.root, "absent.md") }).json, { ok: false, code: "bad_args", detail: ["feedbackPath is not a readable file"] });
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("the route is checked against the QA file: a red gate never reaches review, a QA return needs a red gate", async () => {
    const f = await fixture();
    try {
        const qaFile = join(f.root, "qa-result.json");
        const base = { runDir: f.root, key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue }, qaResultPath: qaFile };
        const failed = { id: "c1", tool: "phpunit", command: "vendor/bin/phpunit", width: "full", status: "failed", tail: "FAILURES!" };

        await writeFile(qaFile, JSON.stringify(qaResult({ verdict: "red", checks: [failed] })));
        const red = run({ ...base, mode: "review" });
        assert.equal(red.code, 1);
        assert.equal(red.json.code, "qa_red");
        assert.equal(red.json.path, undefined, "no review packet is written for a red gate");
        assert.equal(run({ ...base, mode: "develop" }).code, 0, "a red gate is the one verdict a QA return is composed from");

        for (const verdict of ["green", "unconfirmed"]) {
            await writeFile(qaFile, JSON.stringify(qaResult({ verdict })));
            const notRed = run({ ...base, mode: "develop" });
            assert.equal(notRed.code, 1);
            assert.equal(notRed.json.code, "qa_not_red", verdict);
            assert.equal(run({ ...base, mode: "review" }).code, 0, verdict);
        }

        for (const mode of ["develop", "review"]) {
            await writeFile(qaFile, "not json");
            assert.equal(run({ ...base, mode }).json.code, "qa_result_invalid");
            await writeFile(qaFile, JSON.stringify({ status: "done", verdict: "green" }));
            assert.equal(run({ ...base, mode }).json.code, "qa_result_invalid");
            await writeFile(qaFile, JSON.stringify({ kind: "qa_result", verdict: "maybe" }));
            assert.equal(run({ ...base, mode }).json.code, "qa_result_invalid");
        }
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("a review packet reports the gate it rides on: verdict, obstacles and a dead executor", async () => {
    const f = await fixture();
    try {
        const qaFile = join(f.root, "qa-result.json");
        const base = { runDir: f.root, mode: "review", key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue }, qaResultPath: qaFile };
        const check = (id, status) => ({ id, tool: "phpunit", command: "vendor/bin/phpunit", width: "full", status, tail: "" });
        const qaOf = async (overrides) => {
            await writeFile(qaFile, JSON.stringify(qaResult(overrides)));
            const result = run(base);
            assert.equal(result.code, 0, JSON.stringify(result.json));
            return result.json.qa;
        };

        assert.deepEqual(await qaOf({ executor: { status: "host" } }), { verdict: "green", obstacles: [], executor_broken: false });
        assert.deepEqual(
            await qaOf({ verdict: "unconfirmed", checks: [check("c1", "passed"), check("c2", "broken")], obstacles: ["c2: timeout"] }),
            { verdict: "unconfirmed", obstacles: ["c2: timeout"], executor_broken: false },
            "one broken check among settled ones is not a dead executor"
        );
        assert.deepEqual(
            await qaOf({ verdict: "unconfirmed", checks: [check("c1", "broken"), check("c2", "broken")], obstacles: ["c1: spawn: ENOENT", "c2: spawn: ENOENT"] }),
            { verdict: "unconfirmed", obstacles: ["c1: spawn: ENOENT", "c2: spawn: ENOENT"], executor_broken: true }
        );
        for (const status of ["failed", "mismatch"]) {
            assert.equal((await qaOf({ verdict: "unconfirmed", executor: { status, detail: "executor did not start" }, checks: [check("c1", "broken")] })).executor_broken, true, status);
        }
        assert.equal((await qaOf({ verdict: "unconfirmed", checks: [] })).executor_broken, false, "nothing to run is not a dead executor");
        const lone = (fields) => qaOf({ verdict: "unconfirmed", executor: { status: "host" }, checks: [{ ...check("c1", "broken"), ...fields }] });
        assert.equal((await lone({ exit: 127, reason: "tooling: the command did not run, see the log" })).executor_broken, true, "a lone check the host could not start is a dead executor");
        assert.equal((await lone({ exit: 1, attribution: "baseline", reason: "baseline: fails on master too" })).executor_broken, false, "a baseline failure ran in the environment");
        assert.equal((await lone({ exit: 0, reason: "JUnit does not confirm execution of every selected test file" })).executor_broken, false, "a clean exit its evidence does not confirm ran in the environment");
        assert.equal((await qaOf({ verdict: "unconfirmed", executor: undefined, checks: [check("c1", "passed")] })).executor_broken, true, "an executor the file does not vouch for is not trusted");

        const develop = run({ ...base, mode: "develop", qaResultPath: undefined });
        assert.equal(develop.json.qa, undefined, "only a review packet reports the gate");
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("bad arguments and a missing validator fail closed", async () => {
    const f = await fixture();
    try {
        assert.equal(run("nope").json.code, "bad_args");
        const missing = run({ runDir: "relative", mode: "ship", key: "", title: "T", baseRef: "master", validator: f.validator, files: { issue: "issue.md" } });
        assert.equal(missing.json.code, "bad_args");
        assert.deepEqual(missing.json.detail, ["runDir must be an absolute path", "mode must be develop | review", "key missing", "files.issue must be an absolute path"]);
        const gone = run({ runDir: f.root, mode: "develop", key: "PRJ-7", title: "T", baseRef: "master", validator: join(f.root, "nope.mjs"), files: { issue: f.issue } });
        assert.equal(gone.json.code, "validator_missing");
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test("the QA gate comes from dreamteam.json: declareGate widens the developer's scope, a review refuses a gate that was not declared", async () => {
    const f = await fixture();
    try {
        const base = { runDir: f.root, key: "PRJ-7", title: "Title", baseRef: "master", validator: f.validator, files: { issue: f.issue } };
        const scope = async (extra) => JSON.parse(await readFile(run({ ...base, ...extra }).json.path, "utf8")).scope.included;

        assert.equal((await scope({ mode: "develop" })).length, 1);
        const declared = await scope({ mode: "develop", declareGate: true });
        assert.equal(declared.length, 2);
        assert.match(declared[1], /`checks` в `dreamteam\.json`/);

        const qaFile = join(f.root, "qa-result.json");
        await writeFile(qaFile, JSON.stringify(qaResult()));
        assert.equal((await scope({ mode: "review", declareGate: true, qaResultPath: qaFile })).length, 1, "the reviewer declares nothing");

        for (const gate of ["derived", undefined]) {
            await writeFile(qaFile, JSON.stringify(qaResult({ gate })));
            const refused = run({ ...base, mode: "review", qaResultPath: qaFile });
            assert.equal(refused.code, 1);
            assert.equal(refused.json.code, "qa_gate_undeclared", String(gate));
            assert.equal(refused.json.path, undefined, "no review packet is written");
        }
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});
