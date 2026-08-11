# DreamTeam

DreamTeam is a public, cross-runtime skills-only plugin for Codex and Claude Code.

It provides four authoritative professional roles:

- `product-technologist`
- `software-developer`
- `code-reviewer`
- `technical-writer`

The project wrapper owns the Dispatcher, tracker MCP, stages, statuses, Git/worktree lifecycle, and user-facing reports. DreamTeam roles receive a bounded assignment and return a neutral Result v1. They do not write tracker artifacts or perform mutable Git lifecycle operations.

Before dispatch, the project wrapper sanitizes repository provenance into opaque `workspace_ref`, `revision_ref`, and `base_ref` values plus safe relative navigation evidence. The wrapper launches repository-using roles in the prepared process cwd out-of-band. Assignment v1 keeps repository metadata structurally broad for compatibility, so semantic opacity and path safety are wrapper-owned guarantees rather than JSON Schema guarantees.

The wrapper also owns launch profiles. Every role runs on the wrapper/Dispatcher's current model; DreamTeam never pins a model family. The wrapper varies only reasoning: Product Technologist uses `high`, initial Software Developer uses `xhigh`, review-retry Software Developer and Code Reviewer use `max`, and Technical Writer uses the level selected by wrapper policy.

See [docs/architecture.md](docs/architecture.md) for the wrapper/plugin boundary and installation behavior.

## Development

Requirements: Node.js 20.10+.

```bash
npm test
claude plugin validate .
```

Each role is created and verified independently. DreamTeam role skills and the public Assignment v1 / Result v1 contracts define professional behavior; project-specific tracker and Dispatcher rules stay in wrappers.

## Installation

Add `git@github.com:abssoft/dreamteam.git` from floating `main` as a marketplace, then install or update `dream-team`. Stop immediately after installation or update and start a new session before invoking a role; the current session cannot discover newly installed or refreshed skill instructions safely.

## License

Apache-2.0. See `LICENSE`.
