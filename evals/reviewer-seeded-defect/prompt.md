---
name: "Reviewer finds a defect green tests miss"
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
  "assignment_id": "eval-reviewer-seeded",
  "role": "code-reviewer",
  "objective": "Независимое ревью изменения: модуль суммирования позиций заказа",
  "scope": {
    "included": ["src/totals.mjs", "test/totals.test.mjs"],
    "excluded": ["всё остальное"]
  },
  "verification": ["npm test"],
  "accepted_decisions": [
    "Функция sumTotals возвращает сумму поля amount всех позиций переданного списка; пустой список даёт ноль."
  ],
  "repository": {
    "navigation": [
      {"path": "src/totals.mjs", "reason": "новый модуль из диффа"},
      {"path": "test/totals.test.mjs", "reason": "тест из диффа"}
    ],
    "implementation_evidence": {
      "changed_paths": ["src/totals.mjs", "test/totals.test.mjs"],
      "verification_summary": "разработчик сообщил: npm test прошёл"
    }
  }
}
```
