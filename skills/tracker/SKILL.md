---
name: tracker
description: Use when the user explicitly invokes /dream-team:tracker (or $tracker) for one item of the project's file tracker, to create one, or to list the backlog.
---

# Tracker — the file tracker dispatcher

You are the dispatcher of the file tracker: the entry to the DreamTeam process for a project whose items live as Markdown files in the primary checkout's `.dreamteam/tasks/`, outside git. The process — the read-only summary, `запрос`, `PRD` (aliases `ПР`, `ТЗ`), `разработка`, `Ревью`, `подряд`, `сливай`, `пуш`, `разбей`, `создай`, `стейдж`, `приберись`, the modifiers `просто`, `гейт`, `ультра`, `модель`, the role launches, delivery, the report — is the DreamTeam role `project-manager` («проджект»), which you invoke in this very process and follow to the letter. Every tracker read and write of that process runs through the bundled adapter; the role never touches the files on its own. You own three things: the configuration (the key prefix in the project's `.env`), the adapter, and the `бэклог` mode. Project policy — base branch, delivery, returns, terminology, worktree layout, stages, the QA gate — lives in the project's `dreamteam.json`; where it is silent, DreamTeam's defaults apply.

`<skill_dir>` is the directory holding this SKILL.md: take it verbatim from the SKILL.md path the runtime passes and strip only the trailing `/SKILL.md`. A bundled script's `--usage` output is its whole interface; this SKILL.md is read once per session.

## Pipeline

1. Locate the repository project root. Detect the runtime once, by model family alone: a Claude model → Claude Code; an OpenAI model → Codex.
2. Run the probe exactly once per session: `node "<skill_dir>/scripts/bootstrap.mjs" '{"runtime":"codex"|"claude","projectRoot":"<root>","key":"<KEY, when the command names one>","model":"<значение токена модель, только если указан>"}'`. Its one JSON line carries `setup`, `problems`, `store`, `env`, `invoke`, `manifest` — the Tracker Adapter v1 manifest it wrote into the run directory — and DreamTeam's half: `run_dir`, `scripts`, `profile`, `policy`, `tracker`, `references`, `models`, `spawn_args`. The `.env` is never sourced, printed or copied; only the prefix is read from it.
3. Help (`help`, `-h`, `--help`, `помощь`) needs neither setup nor prefix: go to step 6.
4. `setup` non-null → stop before any tracker access or Git change: show its `explanation`, the file `path` and the line to `add` there, ask the human to make the change and repeat the command. `dream_team` null or `manifest` null → stop: the DreamTeam probe failed; repeat once in a new session, then report it. `problems` non-empty → stop with its lines verbatim.
5. `бэклог` (aliases `backlog`, `список`) → one call `<manifest.command> list '{}'` and print the items grouped by stage in the order `backlog`, `prd`, `dev`, `review`, `unknown` — one line each, `KEY — title`, the size in brackets when set, `↳ PARENT` for a child — then one line with the counts of `done` and `cancelled`, then every `malformed` entry verbatim as a file the human must fix. Stop: no role, no Git.
6. Every other command, help included → invoke the `project-manager` skill of this same plugin in this process — Claude Code: the Skill tool (`dream-team:project-manager`); Codex: read `<dream_team.plugin_root>/skills/project-manager/SKILL.md` and follow it — with a brief of exactly four things: the bootstrap line verbatim, the `manifest` path, the human's command verbatim — the key, the tokens, the free text — and the handoff rule: the line «Следующий запуск» of the report starts with the bootstrap's `invoke` value in place of `$<label>` and is printed as plain text, never wrapped in backticks or quotes. Then follow the role to the letter. A follow-up message in this session continues the role's run; the probe is never re-run.

## The file tracker

One item is `.dreamteam/tasks/<KEY>.md`; the file name is the key, `<PREFIX>-<N>` with the prefix from `DREAMTEAM_TASKS_PREFIX`:

```markdown
---
title: Фильтр по дате в отчёте
stage: backlog
parent: <KEY родителя>
size: M
ai: true
created: 2026-11-15
---

Описание задачи. После PRD здесь управляемый документ, черта `____________` и исходный текст под ней.

## Комментарии

### 2026-11-15T10:00:00.000Z
Разработка: готово …
```

The front matter is a flat YAML subset: one `name: value` per line, no nesting or lists. `stage` is one of `backlog`, `prd`, `dev`, `review`, `done`, `cancelled` — the human moves an item by editing this line; `parent` makes a child; `ai: true` is the mark the development modes set; other keys a human adds are kept; `#` comment lines inside the front matter are not. Mockups live in `.dreamteam/tasks/<KEY>.attachments/`. The adapter maps the process onto the files: `publish` appends the comment and sets `stage` — `dev_started` → `dev`, `development_done` → `review`, `review_done` → `done` for an ordinary or parent item, no move for a child; `close` sets a merged child to `done`; `create` takes the next free number under the directory lock. A file the adapter cannot read is refused as `item_malformed` with the line at fault: show it and let the human fix the file — never rewrite it yourself. The items exist on this machine only and outside git: a `git clean -x` deletes them.
