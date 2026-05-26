# AGENTS.md — pi-charter

Reference for coding agents working in this repository.

## Project stance

`pi-charter` is a new successor concept, not a cosmetic rename of `pi-goals` v1. Treat v1 as reference material only. The v2 domain model is documented in `CONTEXT.md` and the ADRs.

## Read order

1. `CONTEXT.md` — canonical language and boundaries.
2. `docs/adr/` — decisions that should not be re-litigated casually.
3. `docs/implementation/` — implementation specs and tool contracts.
4. `docs/research/2026-05-14-pi-charter-design/v2-brainstorm.md` — full design archive when details are missing.
5. `docs/reference/v1-pi-goals/pi-goals/index.ts` — old implementation patterns to lift surgically.

## Invariants

- Authored source of truth is `charter.md`, with sections: Objective, Criteria, Scope and constraints.
- Runtime bitmaps are sidecars (`feature-state.json`, `criterion-state.json`); do not put mutable status in markdown frontmatter.
- The agent is the smart-Ralph loop driver. Do not add an auto-spawn scheduler.
- Tactical turn-to-turn todos stay in `pi-dag-tasks`; pi-charter only subscribes to hook events if needed.
- Creation is intentionally minimal: `charter_manage({action: "create", objective, budget?, idempotencyKey?})`.
- No `contractPath`, no `--charter-spec`, no spec auto-detect, no spec copy heuristic.
- Every mutating tool should return legal `nextActions[]` so agents do not memorize the FSM.
- Prefer deterministic verifiers (`command`, `hook`) before LLM prompt judges; use `manual` only as a weak fallback.

## Implementation guidance

- Lift from v1 only proven extension plumbing: TypeBox schemas, atomic temp-file writes, lazy state loading, reminder event shape, status widget basics, and command parsing.
- Replace v1 static reminders with deterministic Ralph steering.
- Replace v1 string evidence with typed append-only evidence records.
- Use `crypto.randomUUID()` for charter ids; do not reuse v1 hash ids.
- Use Pi extension APIs from `docs/reference/pi-docs/extensions.md` and live installed docs if in doubt.
- Before editing runtime code, inspect the relevant docs and v1 reference. Keep changes surgical.

## Verification

At minimum before handoff:

```bash
bun run check-types
bun test
```

If tests are not yet present, state that clearly and run `bun run check-types` once dependencies are installed.
