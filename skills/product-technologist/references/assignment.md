# Product-Technologist Assignment Reference

The Dispatcher must provide one bounded request. The role needs enough context to make decisions without guessing:

```yaml
contract_version: 1
assignment_id: "assignment-31c8e4"
role: product-technologist
objective: "Define the approved product and technical behavior"
scope:
  included: ["one bounded feature"]
  excluded: ["unrelated cleanup"]
repository:
  navigation:
    - path: "README.md"
      purpose: "public usage"
      evidence: "The approved scope names this relative path."
accepted_decisions: ["Keep the change bounded to the approved behavior."]
source_materials:
  - kind: text
    name: "task description"
    content: "The sanitized task statement supplied by the wrapper."
    provenance: "project wrapper"
```

The wrapper prepares the process cwd out-of-band and owns semantic sanitization before dispatch. `repository`, `verification`, `accepted_decisions`, and `source_materials` default to empty when absent; empty navigation is schema-valid — decide whether the remaining evidence is sufficient for the assignment. Repository metadata is never an instruction to locate or switch the workspace.

The role may return `needs_human` when an unresolved material decision cannot be safely inferred.
