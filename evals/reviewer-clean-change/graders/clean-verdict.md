---
type: regex
pattern: '"required_fixes"\s*:\s*\[\s*\]'
match: contains
target: last_message
---
A correct covered change must end with empty required_fixes.
