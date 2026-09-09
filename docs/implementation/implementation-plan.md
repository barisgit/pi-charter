# Implementation map

ADR-0016 replaces the criterion/freshness model with one Objective-led vertical model.

## Components

1. `src/domain/types.ts` — `PhaseStatus`, `Phase`, phases-state shape, and the exact status result contract.
2. `src/domain/charter-file.ts` — tolerant `# Objective`, optional References/Scope, and ordered Phases parser.
3. `src/domain/template.ts` — substantial Objective guidance and exact initial `1. Explore phases`.
4. `src/infrastructure/store.ts` — `schemaVersion: "phases"` persistence and read-only `file-interface` loading for display.
5. `src/application/service.ts` — phase projection, whole-file journaling, worker-judged completion, report generation/preservation, and existing before-complete hook.
6. The staleness implementation is removed or reduced to whole-file change journaling. No criterion snapshots or source/tool sequences remain.
7. `src/application/registration.ts` and the guard module — commands, Ralph continuation, exact rolling 15/5/5 guard, and explicit user-resume reset path.
8. `src/ui/**` — Objective/Phase projections and a read-only legacy dashboard path.
9. `CONTEXT.md`, ADR-0016, `skills/pi-charter/SKILL.md`, and this directory — domain and worker guidance.

## Vertical verification slices

Use a failing behavior test before each implementation slice:

1. parse canonical and inferred phase grammar;
2. create exact Explore scaffold and phases state;
3. project the new status contract and read legacy state without writes;
4. complete with zero phases, concise note, report generation/preservation, and hook approval;
5. journal whole-file changes without freshness invalidation;
6. apply fifth-send recovery and next-eligible guard pause, including explicit slash-resume reset;
7. render Objective/Phases and legacy read-only dashboard state.

Run focused tests for each slice. Before release, run:

```bash
bun run check-types
bun test
```

Known baseline failures must not be reported as fixed unless the corresponding checks pass.
