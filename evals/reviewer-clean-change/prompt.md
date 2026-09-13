---
name: "Reviewer passes a correct covered change"
tags: ["code-reviewer"]
plugins: ["."]
runs: 3
max_turns: 25
timeout_seconds: 600
allowed_tools: ["Skill", "Bash", "Read", "Grep", "Glob"]
---
Вызови навык dream-team:code-reviewer и выполни ровно одно ревью по этому Assignment v1 (рабочая директория процесса уже подготовлена):

```json
{
  "contract_version": 1,
  "assignment_id": "eval-reviewer-clean",
  "role": "code-reviewer",
  "objective": "Независимое ревью изменения: модуль суммирования позиций заказа",
  "scope": {
    "included": [
      "src/totals.mjs",
      "test/totals.test.mjs"
    ],
    "excluded": [
      "всё остальное"
    ]
  },
  "verification": [
    "npm test"
  ],
  "accepted_decisions": [
    "Функция sumTotals возвращает сумму поля amount всех позиций переданного списка; пустой список даёт ноль."
  ],
  "repository": {
    "navigation": [
      {
        "path": "src/totals.mjs",
        "reason": "новый модуль из диффа"
      },
      {
        "path": "test/totals.test.mjs",
        "reason": "тест из диффа"
      }
    ],
    "implementation_evidence": {
      "changed_paths": [
        "src/totals.mjs",
        "test/totals.test.mjs"
      ],
      "verification_summary": "разработчик сообщил: npm test прошёл"
    },
    "base_ref": "main"
  },
  "source_materials": [
    {
      "kind": "text",
      "name": "issue",
      "content": "Независимое ревью изменения: модуль суммирования позиций заказа. Функция sumTotals возвращает сумму поля amount всех позиций переданного списка; пустой список даёт ноль.",
      "provenance": "текст задачи из трекера"
    },
    {
      "kind": "text",
      "name": "qa_result",
      "content": "{\"kind\":\"qa_result\",\"verdict\":\"green\",\"executor\":{\"status\":\"host\"},\"checks\":[{\"id\":\"c1\",\"tool\":\"node:test\",\"command\":\"npm test\",\"width\":\"full\",\"status\":\"passed\",\"exit\":0}],\"obstacles\":[],\"summary\":{\"passed\":1,\"failed\":0,\"broken\":0,\"skipped\":0}}",
      "provenance": "результат QA"
    }
  ]
}
```
