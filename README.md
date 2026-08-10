# DreamTeam

DreamTeam is a public, cross-runtime skills-only plugin for Codex and Claude Code.

It provides four professional roles extracted from the current Plane workflow:

- `product-technologist`
- `software-developer`
- `code-reviewer`
- `technical-writer`

The project wrapper owns the Dispatcher, tracker MCP, stages, statuses, Git/worktree lifecycle, and user-facing reports. DreamTeam roles receive a bounded assignment and return a neutral Result v1. They do not write tracker artifacts or perform mutable Git lifecycle operations.

The wrapper also owns launch profiles. Every role runs on the wrapper/Dispatcher's current model; DreamTeam never pins a model family. The wrapper varies only reasoning: Product Technologist uses `high`, initial Software Developer uses `xhigh`, review-retry Software Developer and Code Reviewer use `max`, and Technical Writer uses the level selected by wrapper policy.

See [docs/architecture.md](docs/architecture.md) for the wrapper/plugin boundary and installation behavior.

## Development

Requirements: Node.js 20.10+.

```bash
npm test
claude plugin validate .
```

Each role is created and verified independently. Role instructions are derived from the Plane source prompts; project-specific tracker and Dispatcher rules stay in the wrappers.

## Installation

Add this repository as a marketplace, then install `dream-team`. Use a stable release tag when a public GitHub repository is configured. A wrapper must stop after installing a missing dependency and require a new session before retrying.

## License

Apache-2.0. See `LICENSE`.
