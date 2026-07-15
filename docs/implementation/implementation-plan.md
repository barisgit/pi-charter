# Implementation map

The ADR-0015 redesign is implemented as one vertical model rather than separate activity and evidence systems.

## Components

1. `src/domain/charter-file.ts` — tolerant rich-section and unified Status parser with legacy Evidence input adapter.
2. `src/domain/template.ts` — Status-only scaffold, richer Objective/References/Scope/criterion guidance, and evidence doctrine.
3. `src/domain/types.ts`, `src/infrastructure/store.ts` — normalized criterion snapshots and sidecar compatibility.
4. `src/application/staleness.ts` — Status diff journal and global pass staleness.
5. `src/application/service.ts` — rich status projection, five-way counts, completion blockers, failure history, and report scaffold.
6. `src/application/registration.ts` — Status-only prompts, Ralph steering, and terse status text.
7. `src/ui/widget*.ts` — compact progress/current-work projection.
8. `src/ui/picker-snapshot.ts`, `src/ui/charter-picker.ts` — full dashboard projection.
9. `skills/pi-charter/SKILL.md`, `CONTEXT.md`, ADR-0015 — agent and domain doctrine.

## Verification

Minimum release checks:

```bash
bun run check-types
bun test
```

Coverage must include all five statuses, pass-note completion requirements, pass-only staleness, report prepopulation, old Evidence-line parsing, old snapshot normalization, old journal failure counts, widget current-work priority, and dashboard rendering of rich content.
