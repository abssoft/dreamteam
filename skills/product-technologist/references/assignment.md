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
  workspace_ref: "workspace-41d8"
  revision_ref: "revision-5be2"
  base_ref: "revision-2ac1"
  navigation:
    - path: "README.md"
      purpose: "public usage"
      evidence: "The approved scope names this relative path."
permissions:
  repository_read: true
  source_changes: false
  mutable_git: false
verification:
  required: []
return_contract: result-v1
```

The wrapper prepares the process cwd out-of-band. Opaque repository refs correlate the assignment with wrapper state; they are not paths, branch names, or raw revisions.

The role may return `needs_human` when an unresolved material decision cannot be safely inferred.
