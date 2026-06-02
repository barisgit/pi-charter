# src/domain/

## Responsibility
Pure-ish domain model and markdown/schema parsing layer for pi-charter's current v3 runtime shape. This folder defines shared TypeScript types, parses authored `charter.md`/`criteria.md` content into Objective → Milestone → VAL criterion structures, validates descriptive verifier/evidence JSON shapes, renders/parses completion reports, extracts feature validation checks, and computes source-freshness timestamps. It does not register tools, run verifiers, mutate charter state, or implement a feature DAG planner.

| File | Current responsibility |
|---|---|
| `types.ts` | Shared interfaces/unions: `CharterState`, 4-state `CharterStatus`, legacy-status compatibility type, criteria, milestones, evidence records, next actions, events. |
| `charter-md.ts` | Renders initial `charter.md` and `criteria.md`; parses Objective/Scope/Commands plus milestone/VAL criteria markdown; emits parser warnings and phrase-coupled test-command warnings. |
| `verifier.ts` | TypeBox schemas and validation for descriptive verifier specs: `manual`, `command`, `hook`, `prompt`, `subagent`, `evidence-exists`. No verifier execution. |
| `evidence-schemas.ts` | TypeBox validation for v3 flat evidence rows; rejects legacy typed evidence `kind` values; ensures `narrativePath` is relative. |
| `feature-validation.ts` | Parses a feature markdown `## Validation` block into happy/edge check IDs and command strings. |
| `report-md.ts` | Renders, parses, and completeness-checks `REPORT.md` sections: Title, Objective, Outcome, Notes. |
| `src-freshness.ts` | Walks `<project>/src` for latest file mtime and compares evidence timestamps against that source-change baseline. |

## Design
- `types.ts` is the central contract module. `CharterStatus` is exactly `"active" | "paused" | "completed" | "abandoned"`; `LegacyCharterStatus` only names old persisted states (`planning`, `review`, `awaiting-clarification`, `budget_limited`) for back-compat normalization outside this folder. `TERMINAL_STATUSES` contains only `completed` and `abandoned`.
- The domain model is Objective → Milestone → VAL criterion: `ParsedCharterMarkdown` carries `objective`, `criteria`, `milestones`, `constraints`, `commands`, optional `qaSection`/`readinessSection`, and parser `warnings`. There is no live `FeatureDefinition`, feature DAG, `planDigest`, or `parseFeatureMarkdown` in this folder.
- `charter-md.ts` uses line-oriented markdown parsing rather than a markdown AST. H2 sections are normalized into maps; criteria are discovered from `##` milestone headings containing `### VAL-*` leaves, with flat legacy VAL headings still accepted.
- Verifiers are schemas/specifications only. `charter-md.ts` parses `Verifier:` lines into a `verifierSpec`; `verifier.ts` validates shape. The domain layer never executes commands, hooks, prompts, subagents, or `evidence-exists` checks.
- Parser warnings are data, not gates. Current warning reasons are `missing-verifier`, `invalid-verifier`, `missing-because`, `duplicate-command`, `malformed-command`, and `weak-verifier-phrase-coupled`; application code decides what blocks.
- `requireReviewSubagent` is a tri-state authoring/display annotation (`true`, `false`, or omitted/`undefined`) on `CharterCriterion`; this folder does not enforce it as a completion gate.
- Evidence validation is split from runtime evidence state: `evidence-schemas.ts` validates a flat evidence file shape, while `types.ts` defines the richer in-memory/persisted `EvidenceRecord` shape used by application services.

## Flow
1. Creation/scaffolding callers render files with `renderInitialCharterMarkdown(objective, name)` and `renderInitialCriteriaMarkdown(name)`.
2. Loading callers pass `charter.md` and optionally sibling criteria markdown to `parseCharterMarkdown(markdown, { criteriaMarkdown })`.
3. `parseCharterMarkdown` extracts:
   - `objective` from `## Objective`, stripping comments/blank lines;
   - `constraints` from bullets under `## Scope and constraints`;
   - `commands` from `key: value` lines under `## Commands`, warning on malformed/duplicate keys;
   - `criteria`/`milestones` from criteria markdown when provided, otherwise legacy `## Criteria` content in `charter.md`.
4. Each `VAL-*` criterion body is parsed into fields: description, verifier kind/spec, command, `RequireFreshEvidence`, `RequireReviewSubagent`, and author-time `Because`.
5. `parseVerifier` validates the descriptive verifier object. Unknown or malformed verifier specs degrade to `manual` and add `invalid-verifier` warnings instead of throwing away the whole criteria register.
6. `isPhraseCoupledTestCommand` conservatively flags test commands that use title filters (`-t`, `--grep`, etc.) without a positional file/glob, producing `weak-verifier-phrase-coupled` warnings.
7. Evidence-file import callers use `validateEvidenceFile`/`parseEvidence` for flat evidence JSON. Legacy typed evidence kinds (`command`, `review`, `qa`, `readiness`) are rejected by this schema module.
8. Report callers use `renderReportScaffold`/`renderReportMarkdown`, `parseReportMarkdown`, and `checkReportCompletion` to keep `REPORT.md` title/objective/outcome/notes present.
9. Freshness callers use `lastSrcChangeMs(projectDir)` plus `isEvidenceStaleForSrcChange(lastTs, srcChangeMs)` to mark evidence stale when source files changed after the evidence timestamp.

## Integration
- Consumed by `src/application/` services and registration handlers for the currently registered tool surface: `charter`, `charter_record`, and `charter_status`.
- `types.ts` exports response/action contracts (`NextAction`, `CharterState`, `CharterCriterion`, `EvidenceRecord`, `CharterEvent`) and re-exports verifier types from `verifier.ts`.
- `charter-md.ts` depends on `verifier.ts` for verifier shape validation and on `types.ts` for parsed charter/milestone/criterion types.
- `evidence-schemas.ts` and `verifier.ts` depend on `typebox`/`typebox/value`; most other domain files only use built-in TypeScript/Node APIs.
- `src-freshness.ts` is the only file here with filesystem reads (`node:fs/promises`, `node:path`), and it only computes timestamps; it does not write sidecars.
- Current sidecar concepts represented by these types/parsers include `charter.md`, sibling criteria markdown, `criterion-state.json`/evidence records, flat evidence JSON rows, and `REPORT.md`. `feature-state.json` is not a live sidecar in this folder.

## Vestigial / tech-debt
- `charter-md.ts:269-270` and `types.ts:78-81` comments still mention `lock_plan`; the lock-plan/plan flow is gone, but the manual-without-`Because` warning data still exists.
- `charter-md.ts:539-541` comments mention auto-defaulting omitted `RequireReviewSubagent` from a `milestone_ready_for_review` event; this is residual commentary only in this folder, not an emitted/enforced domain behavior.
- `charter-md.ts` still accepts older un-nested criteria shapes and superseded verifier aliases (`review`, `qa`, `readiness` → `evidence-exists`) for parsing/display compatibility.
- `feature-validation.ts` parses validation commands from feature markdown, but there is no `feature-md.ts` parser or feature DAG planning primitive in `src/domain/`.
- Deleted/stale concepts removed from this map: `trust-rank.ts`, `feature-md.ts`, trust ranking/completion-gate trust model, `parseFeatureMarkdown`, `planDigest`, and an 8-state charter FSM.
