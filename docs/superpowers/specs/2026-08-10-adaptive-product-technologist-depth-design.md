# Adaptive Product-Technologist Depth Design

## Problem

`product-technologist` currently requires the same product and technical topics for every assignment. A narrowly bounded change can therefore produce an artifact whose explanation is much larger than the decision, implementation impact, or risk it represents.

The role must first assess the real impact of the assignment and then scale the density of its existing deliverable. The assessment is working state, not another user-facing section.

## Goals

- Perform an internal impact pre-analysis before drafting the specification.
- Scale specification depth to the assignment's behavioral reach and risk.
- Keep small assignments compact without weakening scope or verification.
- Preserve detailed treatment for cross-cutting, risky, or ambiguous work.
- Keep the role tracker-neutral and preserve Assignment v1 and Result v1.

## Non-goals

- Do not add a new DreamTeam role or workflow stage.
- Do not change Dispatcher, tracker, Git, delivery, or publication behavior.
- Do not add an impact field or assessment section to Result v1.
- Do not make any currently required deliverable section optional.
- Do not add Plane-specific commands, flags, headings, or report formats.

## Impact Pre-analysis

Before writing any deliverable section, `product-technologist` evaluates verified assignment and repository evidence across three dimensions:

- **Code impact:** locality, affected modules or layers, shared runtime paths, and changed contracts.
- **Interface impact:** user-visible states, internal interfaces, public APIs, integrations, compatibility, and affected roles.
- **Business-process and data impact:** process steps, permissions, persistence, schema or migration work, destructive behavior, auditability, and operational risk.

The role classifies the assignment internally as `small`, `medium`, or `large`. Wording length and raw file count are weak signals; behavioral reach and risk decide the level.

- **Small:** expected behavior is explicit and bounded, with no material data, security, permission, integration, public-contract, or multi-step process change.
- **Medium:** one meaningful flow or coherent deliverable crosses related components or contracts and has material edge cases or compatibility boundaries.
- **Large:** behavior is cross-cutting or affects multiple roles or process stages, integrations or public contracts, schema or migration, security or permissions, destructive data effects, operational recovery, substantial compatibility risk, or likely independent children.

Any large-impact signal raises the level even if the expected diff is short. Mixed evidence selects the higher justified level. Material ambiguity returns `needs_human`; the role must not compensate with speculative prose.

The classification remains internal working state. It is not emitted as a heading, field, summary label, finding, or explanation in the deliverable.

## Adaptive Deliverable

The existing `product_technical_spec` keeps its ordered sections: `Продуктовое решение`, `Техническое задание`, `Scope`, `QA check-list`, and optional `План реализации`. Depth changes content density, not the output contract.

- **Small output:** state only material behavior, boundaries, exact changed and deliberately unchanged behavior, minimal verified scope, and the smallest observable regression-proof QA set. Do not separately enumerate audience, value, scenarios, components, or analogues when they add no decision or implementation constraint.
- **Medium output:** cover the main actor or caller flow, states, boundaries, affected contracts, compatibility behavior, and meaningful edge cases.
- **Large output:** cover affected roles and flows, interfaces and integrations, data and migration behavior, permissions, failure and recovery, operational risk, compatibility, boundaries, and useful decomposition.

Every point must change a decision or boundary or impose an implementation or verification obligation. The same fact is not repeated across sections.

The assignment's requested output density may change phrasing and may request additional useful detail. It cannot remove material obligations discovered by pre-analysis or force boilerplate that adds no decision, constraint, or verification requirement.

Split behavior remains unchanged: recommend 2–7 direct children only when independently deliverable children are justified. A `large` classification is evidence for considering a split, not an automatic split.

## Compatibility

- Assignment v1 and Result v1 schemas remain unchanged.
- `role: product-technologist`, terminal statuses, and `changed_paths: []` remain unchanged.
- Required input validation, accepted-decision preservation, visual-reference handling, and fail-closed ambiguity handling remain unchanged.
- Wrapper-owned workflow and delivery responsibilities remain unchanged.

## Verification Design

Add contract tests that fail before the skill edit and prove that the skill:

- performs pre-analysis before drafting;
- covers code, interface, and business-process/data impact;
- defines `small`, `medium`, and `large` using reach and risk rather than wording or file count;
- treats schema, migration, security, permissions, integrations, public contracts, and multi-role processes as escalation signals;
- keeps the classification internal and absent from the output contract;
- retains all four required specification sections at every level;
- gives small assignments a positive compact output recipe;
- returns `needs_human` for material ambiguity instead of expanding speculation;
- preserves the tracker-neutral vocabulary boundary.

Add an evaluation fixture showing that an explicitly bounded, low-impact request produces only material decisions, scope, and verification obligations rather than audience/value/scenario boilerplate.

Run the role validator, `npm test`, `claude plugin validate .`, and `git diff --check`.
