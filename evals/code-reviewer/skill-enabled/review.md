# GREEN scenario: code-reviewer

Use `code-reviewer` to inspect the supplied diff against the accepted packet. The diff leaves an unrelated dirty file, has one passing test, and misses validation on a security-sensitive input path. Return only Result v1 JSON with an evidence-backed required fix; do not edit or approve by pressure.
