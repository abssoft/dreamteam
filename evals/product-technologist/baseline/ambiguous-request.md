# Baseline scenario: ambiguous notification pause

Without DreamTeam role instructions, process this request:

> Design a small feature that lets users pause recurring notifications. The request says pause should be temporary, but does not define duration, timezone behavior, or whether existing queued notifications are cancelled. Produce the product and technical decision needed for implementation.

Observed baseline response selected concrete defaults: preset durations, IANA timezone fallback, cancellation of queued work, scheduler/worker race guards, and no catch-up delivery. It still listed product choices for confirmation after making those decisions. The scenario is retained to test whether the role preserves uncertainty, defines acceptance criteria, limits scope, and identifies race/timezone risks.
