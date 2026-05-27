# Split charter.md and criteria.md as authored sources of truth

Status: accepted; supersedes ADR-0002

The authored layout for a charter is two files: `charter.md` (Objective, Scope and constraints, Mission Boundaries, Commands) and `criteria.md` (the `VAL-*` register, with per-criterion pass criteria, failure modes, and trust-gate flags). Sidecar JSON files (`state.json`, `feature-state.json`, `criterion-state.json`) hold mutable runtime state.

## Why

- Runtime sidecars index criteria by stable `VAL-*` id; a dedicated file makes the register mechanical to parse and reorder without touching narrative.
- Planner-critic gates target the criteria register independently of charter prose.
- Editing criteria is editing the contract; a separate file forces a deliberate, reviewable edit.

## Status

Landed in v2.3 (commit 96f0248) with `loadParsedCharter()` reading `criteria.md` when present and falling back to legacy `charter.md ## Criteria` only when absent. The fallback was kept to migrate existing charters and was hard-cut in charter 2bab1a1b (single user, no migration burden).
