# AGENTS.md — pi-charter

Reference for coding agents working in this repository.

## Project stance

`pi-charter` is a new successor concept, not a cosmetic rename of `pi-goals` v1. Treat v1 as reference material only. The current (v3) domain model is documented in `CONTEXT.md` and the ADRs (notably ADR-0012 and ADR-0013).

## Read order

1. `CONTEXT.md` — canonical language and boundaries.
2. `docs/adr/` — decisions that should not be re-litigated casually.
3. `docs/implementation/` — implementation specs and tool contracts.
4. `docs/research/2026-05-14-pi-charter-design/v2-brainstorm.md` — full design archive when details are missing.
5. `docs/reference/v1-pi-goals/pi-goals/index.ts` — old implementation patterns to lift surgically.

## Invariants

- Authored source of truth is split across `charter.md` (Objective, Scope and constraints, optional `## Commands`) and `criteria.md` (the VAL register: Objective → Milestone → VAL).
- Runtime status lives in JSON sidecars, not markdown frontmatter. The live sidecars are `state.json` (lifecycle/session) and `criterion-state.json` (latest VAL outcomes + evidence pointers); `feature-state.json` is a vestigial name only (no live reader/writer).
- The agent is the smart-Ralph loop driver. Do not add an auto-spawn scheduler.
- Tactical turn-to-turn todos stay in `pi-dag-tasks`; pi-charter only subscribes to hook events if needed.
- Creation is intentionally minimal: `charter({action: "create", objective, budget?, idempotencyKey?})` (the lifecycle tool is `charter`, not `charter_manage`).
- No `contractPath`, no `--charter-spec`, no spec auto-detect, no spec copy heuristic.
- Every mutating tool should return legal `nextActions[]` so agents do not memorize the FSM.
- The charter records evidence; it does not run checks (ADR-0013). The agent runs commands/tests itself and records the output as `source: verifier` evidence; `Verifier:`/`Command:` annotations on a VAL are descriptive, not executable. Prefer real command output over `source: manual`, and `manual` evidence requires a `because`.

## Implementation guidance

- Lift from v1 only proven extension plumbing: TypeBox schemas, atomic temp-file writes, lazy state loading, reminder event shape, status widget basics, and command parsing.
- Replace v1 static reminders with deterministic Ralph steering.
- Replace v1 string evidence with structured, append-only evidence records (flat `source`/`outcome`/`summary`/`because?`/`details?`); the older typed `kind`/`verdict`/`observation` envelope is rejected.
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
