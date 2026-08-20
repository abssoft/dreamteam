---
type: regex
pattern: '"required_fixes"\s*:\s*\[\s*\]'
match: not_contains
target: last_message
---
The seeded defect must produce a non-empty required_fixes list.
