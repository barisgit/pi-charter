# Implementation map

ADR-0018 reduces pi-charter to a quiet Objective backstop. This map lists where that contract lives.

## Components

1. `src/domain/types.ts` — lifecycle and status result types, with no phase types.
2. `src/domain/charter-file.ts` — tolerant `# Objective` and optional References/Scope parser; other Markdown is inert.
3. `src/domain/template.ts` — creation template with the Objective and no phase section.
4. `src/infrastructure/store.ts` — writable `schemaVersion: "phases"` persistence (historical label, unchanged shape) and read-only `file-interface` loading.
5. `src/application/service.ts` — lifecycle, status projection, whole-file journaling, and completion through `charter:before_complete` without report generation.
6. `src/application/registration.ts` and the Ralph guard module — commands, idle-only Ralph, the exact rolling 15/5/5 guard, and the explicit user-resume reset path. No periodic reminder registration or options.
7. `src/ui/**` — widget and dashboard without phase projections; legacy charters read-only.
8. `CONTEXT.md`, ADR-0018, `skills/pi-charter/SKILL.md`, and this directory — domain and worker guidance.

## Behavior slices

Use a failing behavior test before each slice:

1. parse Objective, References, and Scope, treating an existing `## Phases` section as inert notes;
2. create without a phase scaffold and resume an existing charter without rewriting it;
3. project the status contract without phase fields and read legacy state without writes;
4. complete with a required note and hook approval, leaving any `REPORT.md` untouched and generating none;
5. send no Objective prompt while work is underway; send Ralph only when idle;
6. apply fifth-send recovery and next-eligible guard pause, including explicit slash-resume reset;
7. render widget and dashboard without phases, and legacy charters read-only.

Before release, run:

```bash
bun run check-types
bun test
```

Known baseline failures must not be reported as fixed unless the corresponding checks pass.
