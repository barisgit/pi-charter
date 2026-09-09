# src/domain/

## Responsibility

Defines framework-independent charter language and pure rules: Objective/Phase parsing, timestamped ids, the creation scaffold, lifecycle state, Ralph guard state, events, and legal-action descriptors.

## Design patterns

- **Tolerant file parser:** `charter-file.ts` recognizes `# Objective`, optional References/Scope, and ordered items under `## Phases`. Unknown Markdown stays inert; known grammar problems become warnings.
- **Small value model:** `PhaseStatus`, `Phase`, and `ParsedCharterFile` are the complete authored projection. There is no criterion or per-phase evidence state.
- **Pure domain functions:** parsing, slugging, timestamp formatting, and template rendering are deterministic apart from supplied time/filesystem inputs.
- **Collision-safe identifier factory:** `ids.ts` creates `<YYYYMMDD-HHMMSS>-<slug>` ids and adds numeric suffixes when needed.

## Data and control flow

1. `renderCharterTemplate()` writes the substantial Objective guidance and exact initial `1. Explore phases`.
2. `parseCharterFile()` strips HTML comments, extracts sections, parses phase suffix/body Markdown, infers a current phase when needed, and returns warnings without blocking work.
3. `types.ts` supplies the four lifecycle states, `schemaVersion: "phases" | "file-interface"`, optional whole-file snapshot hash, optional Ralph guard state, events, and next actions.
4. Application and UI consume the parsed Objective/Phase projection directly.

## Integration points

- `src/application/service.ts`, `snapshots.ts`, and `ralph.ts` consume the parser and state types.
- `src/infrastructure/store.ts` creates the scaffold and normalizes persisted state.
- `src/ui/` consumes Phase and lifecycle types for read-only projections.
