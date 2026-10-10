#!/usr/bin/env node
// One-call Git delivery procedures for the project-manager role.
// Input: single CLI arg — JSON. Output: one JSON line; always exit 0.
// Fail-closed: no force, no reset, no cleanup beyond the requested worktree
// removal; the only recovery action is `merge --abort` on a conflicted merge.
// The caller passes gates (an accepted review, «сливай») BEFORE calling; the
// script is purely mechanical.
// Hook-independent: commit and merge run with --no-verify. Task-repo hooks
// (a pre-commit shelling into docker compose) depend on host state a worktree
// does not have and may even mutate the wrong checkout; the project's gate
// already ran in the QA role, and style gates belong to the repository's CI.
// `base` names the branch no mode may commit on, merge into (but `merge`) or
// push: commit, subtask and push refuse it with base_forbidden, so a
// `delivery: branch` project can never see its base touched by the role.
//
// Modes:
//  {mode:"commit",  workspace, key, base?, paths?:[...], message?, resultPath?, subject?}
//    resultPath (a role's Result v1 file) + subject: paths default to the
//    Result's changed_paths and the message is composed from the file —
//    subject, «## Что сделано» from the deliverable (behavior, else summary),
//    «## Почему» from its why, «## Проверено» from the verification items.
//    → stage exactly `paths` on branch <key> and commit when staged changes
//      exist. Reports {committed, head}.
//  {mode:"subtask", workspace, key, parentKey, base?, paths?, message?}
//    → optional stage+commit on <key>; ancestor check; checkout <parentKey>;
//      merge --no-ff <key>. Conflict → abort, {conflict:true}.
//      Already merged → {already_merged:true}, workspace left on <parentKey>.
//  {mode:"merge",   workspace, key, base?="main", remote?="origin", push?=true}
//    → delivery `merge_push`: workspace must hold a clean checkout of <base>,
//      or of <key> itself (an in-place run), which is switched to <base> first;
//      sync base from the remote (ff-only), merge --no-ff <key>, push.
//      Divergence, dirty state, conflict, or rejected push are reported, never repaired.
//  {mode:"push",    workspace, key, base?, remote?="origin", toplevel?, removeWorktree?=false}
//    → delivery `branch`: workspace must hold a clean checkout of <key>;
//      push -u <remote> <key>. removeWorktree:true (with toplevel != workspace)
//      then removes the worktree; a failed removal is a warning, never a rollback.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return { ok: true, status: 0, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    const result = { ok: false, status: error.status ?? null, stdout: (error.stdout ?? "").toString().trim(), stderr: (error.stderr ?? "").toString().trim() };
    if (allowFail) return result;
    out({ ok: false, code: "git_error", command: args.join(" "), detail: result.stderr.slice(0, 400) });
  }
}

const isText = (value) => typeof value === "string" && value !== "";

function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
}

function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]).stdout;
}

function isAncestor(cwd, a, b) {
  const res = git(cwd, ["merge-base", "--is-ancestor", a, b], { allowFail: true });
  if (res.ok) return true;
  if (res.status === 1) return false;
  out({ ok: false, code: "ancestor_check_failed", detail: res.stderr.slice(0, 400) });
}

function forbidBase(base, ...branches) {
  if (isText(base) && branches.includes(base)) out({ ok: false, code: "base_forbidden", base });
}

function stageAndCommit(cwd, key, paths, message) {
  if (currentBranch(cwd) !== key) out({ ok: false, code: "wrong_branch", expected: key, actual: currentBranch(cwd) });
  if (Array.isArray(paths) && paths.length > 0) {
    if (paths.some((p) => typeof p !== "string" || p === "" || p.startsWith("/") || p.split(/[\\/]/).includes(".."))) {
      out({ ok: false, code: "bad_paths" });
    }
    git(cwd, ["add", "--", ...paths]);
  }
  const staged = git(cwd, ["diff", "--cached", "--name-only"]).stdout;
  if (staged === "") return { committed: false };
  if (typeof message !== "string" || message.trim() === "") out({ ok: false, code: "message_required" });
  git(cwd, ["commit", "--no-verify", "-m", message]);
  return { committed: true };
}

function mergeNoFf(cwd, from, message) {
  const merge = git(cwd, ["merge", "--no-ff", "--no-verify", from, "-m", message], { allowFail: true });
  if (merge.ok) return { merged: true };
  const conflicted = git(cwd, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true });
  const files = conflicted.ok ? conflicted.stdout.split("\n").filter((f) => f !== "").slice(0, 10) : [];
  git(cwd, ["merge", "--abort"], { allowFail: true });
  return { merged: false, conflict: true, conflict_files: files };
}

// Commit inputs from a role's Result file: the staged paths and the body come
// from what the role wrote, the subject from the caller.
function commitInputs({ paths, message, resultPath, subject }) {
  if (typeof resultPath !== "string" || resultPath === "") return { paths, message };
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    out({ ok: false, code: "result_unreadable", path: resultPath });
  }
  if (typeof subject !== "string" || subject.trim() === "") out({ ok: false, code: "subject_required" });
  const content = result?.deliverable?.content && typeof result.deliverable.content === "object" ? result.deliverable.content : {};
  const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  const sections = [`## Что сделано\n${text(content.behavior) ?? text(result?.summary) ?? "(не указано)"}`];
  if (text(content.why)) sections.push(`## Почему\n${text(content.why)}`);
  const checks = (Array.isArray(result?.verification) ? result.verification : [])
    .filter((item) => item && typeof item.command === "string")
    .map((item) => `- ${item.command} — ${String(item.status ?? "").toUpperCase()}${text(item.evidence) ? `: ${text(item.evidence)}` : ""}`);
  if (checks.length) sections.push(`## Проверено\n${checks.join("\n")}`);
  const fromResult = Array.isArray(result?.changed_paths) ? result.changed_paths : [];
  return {
    paths: Array.isArray(paths) && paths.length > 0 ? paths : fromResult,
    message: `${subject.trim()}\n\n${sections.join("\n\n")}\n`,
  };
}

function modeCommit({ workspace, key, base, paths, message, resultPath, subject }) {
  forbidBase(base, key);
  const inputs = commitInputs({ paths, message, resultPath, subject });
  const result = stageAndCommit(workspace, key, inputs.paths, inputs.message);
  out({ ok: true, mode: "commit", ...result, branch: key, head: head(workspace) });
}

function modeSubtask({ workspace, key, parentKey, base, paths, message }) {
  if (typeof parentKey !== "string" || parentKey === "") out({ ok: false, code: "bad_args" });
  forbidBase(base, key, parentKey);
  const onKey = currentBranch(workspace) === key;
  let committed = false;
  if (onKey) {
    committed = stageAndCommit(workspace, key, paths ?? [], message ?? "").committed;
  }
  const dirty = git(workspace, ["status", "--porcelain"]).stdout;
  if (dirty !== "") out({ ok: false, code: "workspace_dirty", sample: dirty.split("\n").slice(0, 5) });

  if (isAncestor(workspace, key, parentKey)) {
    if (currentBranch(workspace) !== parentKey) git(workspace, ["checkout", parentKey]);
    out({ ok: true, mode: "subtask", committed, already_merged: true, merged: false, branch: parentKey, head: head(workspace) });
  }
  const ahead = git(workspace, ["rev-list", "--count", `${parentKey}..${key}`]).stdout;
  if (ahead === "0") out({ ok: false, code: "nothing_to_merge" });
  if (currentBranch(workspace) !== parentKey) git(workspace, ["checkout", parentKey]);
  const merge = mergeNoFf(workspace, key, `Merge ${key} into ${parentKey}`);
  if (merge.conflict) {
    out({ ok: false, code: "merge_conflict", committed, conflict_files: merge.conflict_files, branch: currentBranch(workspace) });
  }
  out({ ok: true, mode: "subtask", committed, already_merged: false, merged: true, branch: parentKey, head: head(workspace) });
}

function modeMerge({ workspace, key, base = "main", remote = "origin", push = true }) {
  // An in-place run (placement "primary") leaves the checkout on <key>: that
  // clean checkout switches to <base> first; any other branch blocks.
  const onKey = currentBranch(workspace) === key;
  if (!onKey && currentBranch(workspace) !== base) out({ ok: false, code: "not_on_base", expected: base, actual: currentBranch(workspace) });
  const dirty = git(workspace, ["status", "--porcelain"]).stdout;
  if (dirty !== "") out({ ok: false, code: "dirty_base_checkout", sample: dirty.split("\n").slice(0, 5) });
  if (onKey) {
    const checkout = git(workspace, ["checkout", base], { allowFail: true });
    if (!checkout.ok) out({ ok: false, code: "base_checkout_failed", detail: checkout.stderr.slice(0, 400) });
  }

  const remotes = git(workspace, ["remote"]).stdout.split("\n");
  const hasRemote = remotes.includes(remote);
  let synced = false;
  if (hasRemote) {
    const probe = git(workspace, ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${base}`], { allowFail: true });
    if (probe.ok) {
      const sha = probe.stdout.match(/^([0-9a-f]{40})\t/)?.[1];
      if (!sha) out({ ok: false, code: "malformed_ls_remote" });
      git(workspace, ["fetch", remote, `refs/heads/${base}:refs/remotes/${remote}/${base}`]);
      const local = head(workspace);
      if (local !== sha) {
        if (isAncestor(workspace, local, sha)) {
          const ff = git(workspace, ["merge", "--ff-only", `refs/remotes/${remote}/${base}`], { allowFail: true });
          if (!ff.ok) out({ ok: false, code: "base_ff_failed", detail: ff.stderr.slice(0, 400) });
        } else if (!isAncestor(workspace, sha, local)) {
          out({ ok: false, code: "base_diverged", local, remote_sha: sha });
        }
      }
      synced = true;
    } else if (probe.status !== 2) {
      out({ ok: false, code: "transport_failure", detail: probe.stderr.slice(0, 400) });
    }
  }

  const merge = mergeNoFf(workspace, key, `Merge ${key} into ${base}`);
  if (merge.conflict) out({ ok: false, code: "merge_conflict", conflict_files: merge.conflict_files, branch: currentBranch(workspace) });

  let pushed = false;
  if (push && hasRemote) {
    const pushRes = git(workspace, ["push", remote, base], { allowFail: true });
    if (!pushRes.ok) {
      out({ ok: false, code: "push_rejected", merged: true, pushed: false, head: head(workspace), detail: pushRes.stderr.slice(0, 400) });
    }
    pushed = true;
  }
  out({ ok: true, mode: "merge", merged: true, synced, pushed, branch: base, head: head(workspace) });
}

function modePush({ workspace, key, base, remote = "origin", toplevel, removeWorktree = false }) {
  forbidBase(base, key);
  if (currentBranch(workspace) !== key) out({ ok: false, code: "wrong_branch", expected: key, actual: currentBranch(workspace) });
  const dirty = git(workspace, ["status", "--porcelain"]).stdout;
  if (dirty !== "") out({ ok: false, code: "workspace_dirty", sample: dirty.split("\n").slice(0, 5) });

  const remotes = git(workspace, ["remote"]).stdout.split("\n");
  if (!remotes.includes(remote)) out({ ok: false, code: "remote_missing", remote });

  const pushRes = git(workspace, ["push", "-u", remote, key], { allowFail: true });
  if (!pushRes.ok) {
    out({ ok: false, code: "push_rejected", pushed: false, head: head(workspace), detail: pushRes.stderr.slice(0, 400) });
  }

  let worktreeRemoved = false;
  const warnings = [];
  if (removeWorktree) {
    if (typeof toplevel !== "string" || toplevel === "" || toplevel === workspace) {
      warnings.push("worktree_remove_skipped");
    } else {
      const removal = git(toplevel, ["worktree", "remove", workspace], { allowFail: true });
      if (removal.ok) worktreeRemoved = true;
      else warnings.push("worktree_remove_failed");
    }
  }

  out({ ok: true, mode: "push", pushed: true, branch: key, worktree_removed: worktreeRemoved, warnings });
}

const USAGE = `deliver.mjs — one-call Git delivery for the project-manager role. Fail-closed:
no force, no reset; the only recovery is merge --abort on a conflicted merge;
commit and merge run --no-verify; \`base\` is never committed on or pushed as a
task branch (base_forbidden).
Arg: single JSON, one of:
 {mode:"commit",  workspace, key, base?, paths?:[...], message?, resultPath?, subject?}
   stage exactly paths on branch <key>, commit when staged -> {committed,head}
   resultPath (a role's Result v1 file) + subject: paths default to the Result's
   changed_paths, the message is composed from the file (subject, ## Что сделано,
   ## Почему, ## Проверено); paths + message instead take both verbatim.
   Codes: result_unreadable|subject_required.
 {mode:"subtask", workspace, key, parentKey, base?, paths?, message?}
   optional commit; checkout <parentKey>; merge --no-ff <key>;
   -> {committed, merged|already_merged, branch, head}
 {mode:"merge",   workspace, key, base?="main", remote?="origin", push?=true}
   delivery merge_push: clean <base> checkout required — a clean <key> checkout
   (in-place run) is switched to <base> first; sync base (ff-only), merge --no-ff, push.
 {mode:"push",    workspace, key, base?, remote?="origin", toplevel?, removeWorktree?=false}
   delivery branch: clean checkout of <key> required; push -u <remote> <key>;
   optionally remove the run-owned worktree (toplevel != workspace).
Output: one JSON line. ok:false codes: bad_args|git_error|wrong_branch|base_forbidden|
result_unreadable|subject_required|bad_paths|message_required|workspace_dirty|nothing_to_merge|merge_conflict|
not_on_base|base_checkout_failed|dirty_base_checkout|base_ff_failed|base_diverged|
malformed_ls_remote|transport_failure|remote_missing|push_rejected|ancestor_check_failed|
deliver_error.
`;

function main() {
  if (["--usage", "--help", "-h"].includes(process.argv[2])) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  let args;
  try {
    args = JSON.parse(process.argv[2] ?? "");
  } catch {
    out({ ok: false, code: "bad_args" });
  }
  const { mode, workspace, key } = args ?? {};
  if (!["commit", "subtask", "merge", "push"].includes(mode) || typeof workspace !== "string" || workspace === "" || typeof key !== "string" || key === "") {
    out({ ok: false, code: "bad_args" });
  }
  if (mode === "commit") modeCommit(args);
  if (mode === "subtask") modeSubtask(args);
  if (mode === "merge") modeMerge(args);
  modePush(args);
}

try {
  main();
} catch {
  out({ ok: false, code: "deliver_error" });
}
