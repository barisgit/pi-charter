# NEXT — morning handoff

## Current repo state

- Clean repo scaffold at `~/Programming_local/Projects/pi-extensions/pi-charter`.
- v1 `pi-goals` moved into `docs/reference/v1-pi-goals/pi-goals/`.
- Research archive copied into `docs/research/2026-05-14-pi-charter-design/`.
- Domain language captured in `CONTEXT.md` using grill-with-docs format.
- ADRs created for the major locked decisions.
- Implementation docs drafted under `docs/implementation/`.
- M1 kernel/store skeleton implemented and tested.
- First tool wiring implemented: `charter_manage(create|pause|resume; complete/force/amend reserved errors)`, `charter_status`, `charter_plan(view + lock_plan; add_feature/update_feature reserved errors)`, `/charter` command, and `--charter-objective` / `--charter-resume` flags.

## Implemented code

- `src/domain/types.ts` — initial `CharterState`, `CharterStatus`, budget, criteria, and event types.
- `src/domain/charter-md.ts` — small heading-based parser and initial `charter.md` renderer.
- `src/infrastructure/store.ts` — project-local layout helpers, atomic writes, `createCharterWorkspace`, state load/write, index load/update, events append.
- `src/application/service.ts` — service functions for create/status/pause/resume, status phase, legal `nextActions[]`, exactly-one active fallback.
- `src/application/plan-service.ts` — parses `plan/*.md`, computes coverage drift, writes computed `plan.json`.
- `src/application/registration.ts` — Pi tool/command/flag registration around the service layer.
- `src/index.ts` — thin entrypoint wiring.
- `tests/store.test.ts` and `tests/service.test.ts` — temp-project smoke tests.

## Recommended next move

M2 planner-critic shipped: `lockPlan` checks empty criteria/features, uncovered criteria, orphan features, unknown criterion refs, and precondition cycles (Tarjan-style DFS). On clean lock it computes a canonical `planDigest` (sha256), transitions `planning -> active`, appends a `plan_locked` event, and writes `state.json.planDigest`.

Next M2 -> M3 ladder:

1. Decide whether agents should edit `plan/*.md` directly (and we drop `add_feature`/`update_feature` tool actions) or expose them as thin writers. Current bet: agents author markdown directly; reserve tool actions only if dogfood shows otherwise.
2. Wire `charter:before_lock_plan` hook with bundled TUI approver subscriber; until then `lock_plan` transitions synchronously.
3. Begin `charter_record` (evidence/verify/handoff_apply) and `criterion-state.json` updates.
4. Begin `charter-evaluator` post-turn fold from `intent-sentinel`.

## Open decisions to review

### D1 — Runtime type names

Recommendation: public API uses `Charter*`; internal runtime container can be `MissionState` only if it clarifies execution. Simpler implementation path: use `CharterState` everywhere and avoid `Mission` entirely until the distinction earns its keep.

### D2 — Parser for `charter.md`

Recommendation: first cut uses a small line/heading parser for `## Objective`, `## Criteria`, `## Scope and constraints`; avoid adding a markdown AST dependency until needed.

### D3 — Criteria metadata format

Recommendation: use lightweight YAML-ish fields under each criterion heading (`Verifier:`, `Fresh evidence required:`) and normalize them in parser. Do not invent full frontmatter blocks inside sections yet.

### D4 — Evaluator model call

Recommendation: default deterministic drift summarizer first; add model-backed evaluator behind config after core lifecycle works.

### D5 — AgentContract YAML projection

Recommendation: not in first implementation. Add `docs/implementation/agentcontract-projection.md` only after M3 evidence works.

### D6 — TUI approver

Recommendation: not in first implementation. Emit hooks first; add TUI subscriber later.

## Known external gaps

- Manual USPTO/EUIPO search for `pi-charter` before public npm publish.
- Direct npm metadata check for `pi-missions`/`pi-quests` was blocked by 403 in research pass.
- Anthropic official Ralph plugin claim is single-source reported; verify before citing publicly.

## Dogfood scenario

Use pi-charter to implement pi-charter itself once M1/M2 exists:

```text
/charter Implement M1 kernel and filesystem store for pi-charter. Use CONTEXT.md, docs/adr, docs/implementation, and v1 pi-goals reference.
```

Expected first charter criteria:

- VAL-KERNEL-001 creates project-local charter directory with `state.json`, `charter.md`, `events.jsonl`, and `index.json`.
- VAL-TOOLS-001 registers `charter_manage` and `charter_status`.
- VAL-BIND-001 resolves active charter through explicit id, session binding, or exactly-one active fallback.
- VAL-SMOKE-001 temp-project smoke test passes.
