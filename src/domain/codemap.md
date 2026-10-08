# src/domain/

## Responsibility

Defines framework-independent charter language and pure rules: Objective parsing, timestamped ids, the creation template, lifecycle state, Ralph guard state, events, and legal-action descriptors.

## Design patterns

- **Tolerant file parser:** `charter-file.ts` recognizes `# Objective` and optional `## References`/`## Scope`. Everything else, including `## Notes` and historical `## Phases` sections, is returned verbatim as notes and never interpreted.
- **Small value model:** `ParsedCharterFile` is the complete authored projection. There is no phase, criterion, or evidence state.
- **Pure domain functions:** parsing, slugging, timestamp formatting, and template rendering are deterministic apart from supplied time/filesystem inputs.
- **Collision-safe identifier factory:** `ids.ts` creates `<YYYYMMDD-HHMMSS>-<slug>` ids and adds numeric suffixes when needed.

## Data and control flow

1. `renderCharterTemplate()` writes the full Objective plus optional References and Scope sections.
2. `parseCharterFile()` strips HTML comments, extracts the three sections, returns the rest as notes, and reports warnings without blocking work. The Objective runs until a level-1 heading or a `## References`, `## Scope`, `## Notes`, or historical `## Phases` heading, so other Objective subheadings stay intact.
3. `types.ts` supplies the four lifecycle states, `schemaVersion: "phases" | "file-interface"` (the first is a historical label for writable charters), optional Ralph guard state, events, and next actions.

## Integration points

- `src/application/service.ts` and `ralph.ts` consume the parser and state types.
- `src/infrastructure/store.ts` creates the template and normalizes persisted state.
- `src/ui/` consumes lifecycle and guard types for read-only projections.
