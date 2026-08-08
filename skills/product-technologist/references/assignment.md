# Product-Technologist Assignment Reference

The Dispatcher must provide one bounded request. The role needs enough context to make decisions without guessing:

```yaml
contract_version: 1
assignment_id: "TASK-13:prd:1"
role: product-technologist
objective: "Define the approved product and technical behavior"
scope:
  included: ["one bounded feature"]
  excluded: ["unrelated cleanup"]
repository:
  head_sha: "..."
  rules: []
  navigation_seeds: []
permissions:
  source_changes: false
  tracker_writes: false
  mutable_git: false
verification:
  required: []
return_contract: result-v1
```

The role may return `needs_human` when an unresolved material decision cannot be safely inferred.
