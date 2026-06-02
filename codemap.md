# Repository Atlas: pi-charter

## Project Responsibility

Pi extension for durable charter-bound agent work in the partial v3 migration. Current runtime centers on Objective → Milestone → VAL criteria, evidence recording, completion/status projection, deterministic Ralph continuation, session binding, subagent event attribution, and terminal UI surfaces. Code is source of truth; ADRs and older v1/v2 references may describe removed planning primitives.

## System Entry Points

| File | Role |
|---|---|
| `src/index.ts` | Extension entrypoint. Registers flags, the three tools, commands, subagent bridges, widget, Ralph loop, and Ralph message renderer. Imports but currently does not call `registerCharterRemindersBridge()`. Exports `CharterToolError`, `getPackageVersion`, and evidence schemas. |
| `src/application/registration.ts` | Main host composition surface for tools, commands, flags, widget, Ralph, and subagent bridges. Registered tools are exactly `charter`, `charter_record`, and `charter_status`. |
| `package.json` | Package `pi-charter` version `0.0.0`; Pi manifest is the `pi` field with extension `./src/index.ts` and skills `./skills`. Scripts: `test` = `bun test`, `check-types` = `tsc --noEmit`, `ci` = both. |

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
|---|---|---|
| `src/` | Source-root orientation map. Currently contains stale historical details in places; reconcile against the folder maps below and live code. It is a separate source-root map, not a duplicate folder-level map issue. | [View Map](src/codemap.md) |
| `src/application/` | Application layer for the partial v3 runtime: wires the Pi host to lifecycle services, session binding, evidence recording, status/drift projections, Ralph continuation, widgets, reminders, and subagent event bridges. Live surface: `charter` actions `create`/`pause`/`resume`/`complete`/`abandon`, `charter_record` evidence-only, and `charter_status`; no `charter_manage`, `charter_plan`, or verify action. | [View Map](src/application/codemap.md) |
| `src/domain/` | Pure-ish domain model and markdown/schema parsing layer. Defines shared types, parses `charter.md`/`criteria.md` into Objective → Milestone → VAL structures, validates descriptive verifier/evidence JSON shapes, renders/parses `REPORT.md`, extracts validation checks, and computes source freshness. No verifier execution, state mutation, feature DAG planner, or trust-rank model. | [View Map](src/domain/codemap.md) |
| `src/infrastructure/` | Filesystem and integration support: charter workspace persistence under `.pi/charters/`, atomic JSON/text writes, event append/index maintenance, file logging, and local pi-subagents event/metadata type declarations. No registered tools, verification execution, evidence scoring, or planning logic. | [View Map](src/infrastructure/codemap.md) |
| `src/ui/` | Terminal UI projection for v3 charters: compact above-editor widget, interactive `/charters` picker, and session-local charter selection. UI derives from `state.json`, parsed charter/criteria markdown, `criterion-state.json`, running-subagent metadata, and evidence files; no live feature DAG or `feature-state.json` reader. | [View Map](src/ui/codemap.md) |
| `src/persistence/` | Persistence-adjacent global user config loader. `charter-config.ts` reads `<agentDir>/charter-config.json`, validates/normalizes persona override, QA dir, and policy settings; currently unwired from runtime source and covered by config-loader tests. | [View Map](src/persistence/codemap.md) |

## Root Files and Runtime Surface

- `package.json`: private package `pi-charter@0.0.0`; no separate plugin manifest file is present in the repo root, so the package `pi` field is the manifest source.
- Tool surface: exactly three registered tools.
  - `charter`: lifecycle actions `create`, `pause`, `resume`, `complete`, `abandon`.
  - `charter_record`: `action: "evidence"` only, from `entries` or `evidenceFile`.
  - `charter_status`: reads/projections only.
- Runtime status model: `active | paused | completed | abandoned`. Legacy persisted statuses are normalized for compatibility, but no live planning/review/budget-limited FSM exists.
- Completion blockers are VAL pass/freshness/report checks plus manual evidence requiring `because`. `blockingReason` blocks only `source: manual` evidence without `because`; provenance/trust rank is not a gate.
- `requireReviewSubagent` is parsed/displayed only, not a completion gate.
- Test suite ground truth: 275 pass / 0 fail. Standard checks are `bun test` and `bun run check-types`.

## Known tech-debt / vestigial remnants

- `forceCompleteCharter()` and `amendCharter()` are still exported from `src/application/service.ts` but unwired to tool actions; force-complete delegates to abandon, and amend throws `amend.removed`.
- `charter:before_lock_plan` plus `planDigest` fields remain in `src/application/hooks.ts`, but there is no live emitter or `plan-service.ts`.
- `feature-state.json` appears only in comments/protected-file lists, not as a live reader/writer sidecar.
- `milestone_ready_for_review` is residual event-read compatibility only.
- Deleted/absent concepts that should not be reintroduced in this atlas: `plan-service.ts`, `evaluator-service.ts`, `feature-md.ts`, `trust-rank.ts`, `multi-charter-widget.ts`, bundled charter personas, feature DAG planning, `charter_manage`, `charter_plan`, and `action=verify`.
