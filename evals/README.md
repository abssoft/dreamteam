# Behavioral evals

Regression evals for role skills, runnable with the early-access `claude plugin eval` (Claude Code 2.1.198+; prints `plugin eval is currently in early access` when the account has no access yet).

```bash
claude plugin eval . --case reviewer-seeded-defect --verbose
claude plugin eval . --case reviewer-clean-change --verbose
claude plugin eval . --json evals/results/latest.json
```

Each case scaffolds a disposable git fixture (a base line plus a task change), then asks the session to run one role with a literal Assignment v1 packet. Graders check the Result v1 envelope, the verdict direction, and independent verification evidence.

- `reviewer-seeded-defect` — the change carries a real defect the bundled test suite does not catch (green tests, wrong behavior). Passing requires a non-empty `required_fixes` naming the defect: it proves the reviewer reads the diff instead of trusting green checks.
- `reviewer-clean-change` — the change is correct and covered. Passing requires `done` with empty `required_fixes`: it proves the reviewer does not invent blockers or style nits.

Keep fixtures self-contained: relative paths only, no tracker vocabulary, no real repository coordinates — `npm test` guards every tracked markdown/json/yaml file here.
