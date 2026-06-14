# src/ Codemap

Source-root orientation and cross-cutting map for the current pi-charter runtime. Code is source of truth; use the per-folder codemaps for module-level detail.

## Directory Overview

```
src/
├── index.ts                    — Extension entrypoint; calls live register* functions in order
├── application/                — Tool surface, lifecycle orchestration, session binding, hooks,
│   │                             Ralph, subagent bridges, status/drift projections
│   ├── registration.ts          — Registers tools, commands, flags, widget, Ralph loop/renderer,
│   │                             and subagent event bridges
│   ├── service.ts               — Lifecycle actions create/pause/resume/complete/abandon,
│   │                             completion gate, status projection, active-charter listing
│   ├── record-service.ts        — Evidence-only writer/importer; owns criterion-state.json
│   ├── binding-service.ts       — Bidirectional session↔charter binding and reconciliation
│   ├── async-bridge-service.ts  — Maps attributed subagent async events to events.jsonl
│   ├── drift-service.ts         — Uncovered/stale/ready-next/artifact/sidecar drift views
│   ├── sidecar-drift.ts         — Detects out-of-band edits to state.json and criterion-state.json
│   ├── ralph-service.ts         — Deterministic continuation prompt/status-summary builder
│   ├── subagent-api.ts          — Captures pi-subagents exposed API handle
│   ├── subagent-bootstrap.ts    — Renders child prompts and charter command snippets
│   ├── subagent-write-audit.ts  — Detects forbidden child writes to managed charter files
│   ├── architecture-writer.ts   — Exported helpers for optional architecture.md writes
│   ├── hooks.ts                 — Veto bus for before_lock_plan/before_complete/before_abandon
│   ├── reminders-bridge.ts      — Best-effort reminder upsert/remove emitters; registration no-op
│   ├── errors.ts                — CharterToolError with code and legal nextActions
│   └── version.ts               — package.json version reader
├── domain/                     — Shared types plus pure-ish markdown/schema parsing
│   ├── types.ts                — 4-state CharterStatus, criteria/milestone/evidence/event types
│   ├── charter-md.ts           — charter.md + criteria.md renderer/parser and command warnings
│   ├── evidence-schemas.ts     — Flat evidence-file schema; rejects legacy typed evidence kinds
│   ├── feature-validation.ts   — Legacy feature validation-block parser; no feature DAG runtime
│   ├── report-md.ts            — REPORT.md scaffold/parser/completeness check
│   ├── src-freshness.ts        — src/ mtime freshness helpers for evidence staleness
│   └── verifier.ts             — Descriptive verifier schemas; no verifier execution
├── infrastructure/             — Filesystem persistence, logging, shared event contracts
│   ├── store.ts                — Workspace creation/loading, atomic writes, events.jsonl, index.json
│   ├── logger.ts               — File logger that never writes stdout/stderr
│   └── subagent-bridge.ts      — Local pi-subagents event/metadata payload declarations
├── persistence/                — Global user config loader, currently unwired from runtime
│   └── charter-config.ts       — <agentDir>/charter-config.json schema/defaults
└── ui/                         — Terminal widget, picker, and selection state
    ├── widget.ts               — Above-editor single-charter widget host/rendering
    ├── widget-state.ts         — Pure ReducerInput → CharterWidgetVM projection
    ├── widget-service.ts       — Snapshot loader + RunningSubagentRegistry
    ├── charter-picker.ts       — pi-tui /charters master-detail overlay
    ├── charter-picker-constants.ts — Picker layout/key/legend constants
    ├── picker-snapshot.ts      — Picker data loader from charter sidecars/evidence
    └── charter-selection.ts    — Tri-value selection singleton + refresh callback
```

Folder detail lives in:
- [`src/application/codemap.md`](application/codemap.md)
- [`src/domain/codemap.md`](domain/codemap.md)
- [`src/infrastructure/codemap.md`](infrastructure/codemap.md)
- [`src/persistence/codemap.md`](persistence/codemap.md)
- [`src/ui/codemap.md`](ui/codemap.md)

---

## Responsibility

`src/` implements a Pi extension for durable charter-bound work in the current partial v3 runtime. The live model is Objective → Milestone → VAL criteria, with evidence recorded separately from authored markdown and completion gated by current disk state.

- `application/` is the orchestration layer: registered tool/command/flag handlers, lifecycle services, evidence recording, status/drift projections, session binding, subagent event attribution, Ralph continuation, and UI wiring.
- `domain/` owns shared contracts and pure-ish parsing/validation: `CharterStatus`, parsed charter/criteria markdown, flat evidence files, verifier specs, report markdown, and source freshness checks.
- `infrastructure/` owns mutable filesystem boundaries, event-log append/index maintenance, file logging, and shared pi-subagents bus declarations.
- `ui/` derives terminal projections from state/criteria/evidence and exposes the above-editor widget plus `/charters` picker.
- `persistence/` currently contains only a global config loader; runtime code does not import it.

### Current runtime surface

- Registered tools: exactly `charter`, `charter_record`, and `charter_status`.
- `charter` actions: `create`, `pause`, `resume`, `complete`, `abandon`.
- `charter_record` action: `evidence` only, from `entries` or `evidenceFile`.
- Runtime status model: `active | paused | completed | abandoned`. Legacy persisted statuses (`planning`, `review`, `awaiting-clarification`, `budget_limited`) are normalized on read for compatibility; there is no live planning/review/budget-limited FSM.
- Charters are created directly in `active` state.

---

## Design Patterns

### 1. Extension Entrypoint Orchestration (`index.ts`)

`charterExtension()` calls the live registration functions in this order:

```
1. registerCharterFlags              — session_start binding/resume/objective flag handling
2. registerCharterTools              — charter, charter_record, charter_status
3. registerCharterCommands           — /charter and /charters
4. registerCharterSubagentBridge     — captures subagent:expose-api and lineage bindings
5. registerCharterAsyncBridge        — async-started/complete → events + running registry
6. registerCharterWidget             — after async bridge so widget sees updated async state
7. registerCharterRalphLoop          — deterministic all-idle continuation steer
8. registerCharterRalphMessageRenderer — renders Ralph steer messages
```

`index.ts` imports `registerCharterRemindersBridge()` but intentionally does not call it; the call is commented out while Ralph is the sole active reprompt path. There is no `registerCharterPersonas()` and this repo ships zero bundled personas.

### 2. Atomic Filesystem Boundary (`infrastructure/store.ts`)

All text/JSON writes go through a temp-file + rename pattern, with random temp suffixes to avoid parallel-writer collisions:

```
write <path>.<pid>.<now>.<random6hex>.tmp
rename temp → <path>
```

`withPathLock(path, fn)` serializes read-modify-write operations per absolute path; `appendEvent()` and `updateIndex()` both do their reads inside that lock. `withCharterLock(charterDir, fn)` serializes broader per-charter mutations.

### 3. Authored Markdown + Mutable Sidecars

Authored contract text lives in `charter.md` and `criteria.md`. Mutable runtime state stays in JSON sidecars and append-only evidence/event files:

- `state.json`: lifecycle/session metadata and `lastToolWriteAt`.
- `criterion-state.json`: latest evidence pointer/outcome per VAL.
- `events.jsonl`: lifecycle, evidence, and subagent async history.
- `work/<feature-or-_charter>/evidence/<stamp>/evidence.json`: append-only evidence rows.
- `REPORT.md`: completion report scaffold/readiness gate.

Domain parsers treat `criteria.md` as the current criteria source when present, while still accepting older inline criteria for compatibility.

### 4. Session↔Charter Binding (`application/binding-service.ts`)

Binding is bidirectional:

- Forward pointer: `<project>/.pi/charters/<id>/state.json.sessionId`.
- Reverse pointer: `<homeDir>/.pi/agent/sessions/<sid>/charter.json`.

`resolveCharterId()` prefers an explicit tool argument, then the bound session. `reconcileSessionBinding()` repairs stale/missing forward pointers from the reverse pointer. Child sessions are auto-bound from `subagent:lineage` when the root session is bound to a non-terminal charter.

### 5. Append-Only Event Log (`events.jsonl`)

Live emitted event types are:

- `charter_created`
- `charter_paused`
- `charter_resumed`
- `charter_completed`
- `charter_abandoned`
- `evidence_recorded`
- `feature_started`
- `feature_completed`
- `feature_failed`

`feature_started`, `feature_completed`, and `feature_failed` are still emitted by `async-bridge-service.ts` for attributed subagent runs, even though feature-DAG planning files are gone.

Not live-emitted in the current runtime: `plan_locked`, `feature_added`, `handoff_applied`, `charter_force_completed`, and `charter_amended`. `milestone_ready_for_review` is residual read compatibility in `service.ts`, not a current emitter.

### 6. Evidence Sidecar Pattern (`application/record-service.ts`)

Evidence is a flat record, not a typed `kind` envelope. The user-facing source enum is `manual | verifier | subagent`; `recordedBy` is auto-populated by call sites and used for display/audit only.

```
work/<featureId-or-_charter>/evidence/<stamp>/evidence.json
criterion-state.json
```

`recordEvidenceBatch()` validates all entries before writing, writes per-entry evidence files, updates `criterion-state.json` once, and appends one `evidence_recorded` event per entry. `recordEvidenceFromFile()` imports the same flat row shape and rejects legacy typed evidence kinds `command`, `review`, `qa`, and `readiness`.

### 7. Completion Gate (`application/service.ts`)

Completion is evidence-gated but does not execute verifiers. A charter can complete only from `active` and must pass:

- at least one parsed VAL exists;
- every in-scope VAL's latest evidence outcome is `pass`;
- `RequireFreshEvidence` VALs have pass evidence newer than the latest `src/` change;
- `REPORT.md` is complete under its required headings;
- `computeBlockingForComplete()` finds no `val-not-pass` blockers and no `source: "manual"` pass evidence missing non-empty `because`.

`source`, `recordedBy`, and `RequireReviewSubagent` are display/provenance annotations only. There is no identity-disjoint review gate and no trust-rank model.

### 8. Hook Bus (`application/hooks.ts`)

The live hook types are:

- `charter:before_lock_plan`
- `charter:before_complete`
- `charter:before_abandon`

Subscribers return `{ decision: "allow" }` or `{ decision: "block", reason }`; the first block throws. `before_complete` and `before_abandon` are dispatched by lifecycle code. `before_lock_plan` remains defined with `planDigest`/`featureCount` payload fields but has no live emitter because the lock-plan flow is gone. There is no `before_amend_charter` or `before_force_complete` hook.

### 9. pi-subagents Bridge

Current pi-subagents integration uses the shared `pi.events` bus:

| Direction | Event | Effect |
|---|---|---|
| receive | `subagent:expose-api` | `subagent-api.ts` caches the exposed API handle for future programmatic use. |
| receive | `subagent:lineage` | Child session gets a reverse binding when root session is charter-bound. |
| receive | `subagent:async-started` | Attributed run starts widget tracking and appends `feature_started`. |
| receive | `subagent:async-complete` | Attributed run stops widget tracking and appends `feature_completed` or `feature_failed`. |
| receive | `subagent:all-idle` | Ralph loop may send a continuation steer for the bound charter. |

Metadata keys include `pi-charter.projectDir`, `pi-charter.charterId`, `pi-charter.featureId`, and `pi-charter.criterionId`. The exposed API capture and async attribution are live. Persona-dir registration constants still exist in `infrastructure/subagent-bridge.ts`, but there is no bundled persona directory registration in current runtime.

### 10. Pure Projection to UI

`ui/widget-state.ts` is the pure reducer from loaded state/criteria/outcomes/running-subagents to `CharterWidgetVM`. I/O lives in `widget-service.ts` and host/timer/render integration lives in `widget.ts`. The picker has a separate snapshot path in `picker-snapshot.ts`, loading charter rows, parsed criteria, blockers, and recent evidence for `charter-picker.ts`.

---

## Data/Control Flow

### Charter Creation Flow

```
/charter <objective>
  → command sends an instruction message to the agent
  → agent calls charter(action="create", objective)
    → registration.ts execute handler
      → service.createCharter(projectDir, { objective, name?, budget?, idempotencyKey?, sessionId? })
        → store.createCharterWorkspace()
            mkdir .pi/charters/<id>/work/
            write charter.md
            write criteria.md
            write state.json { status: "active", ... }
            write criterion-state.json { criteria: {}, ... }
            appendEvent("charter_created")
            update .pi/charters/index.json
      → bindCharterToSession() when a sessionId is available
      → tool result includes legal nextActions
```

### Active Authoring / Execution Flow

```
charter created active
  → agent edits charter.md and criteria.md directly
  → charter_status
      → service.getCharterStatus()
      → load state + parsed charter + criterion-state + REPORT/drift/blockers
      → return objective, VAL totals, drift, parse warnings, blockers, nextActions
  → agent/subagents do work and run checks outside pi-charter
  → charter_record(action="evidence")
      → record-service writes flat evidence JSON
      → update criterion-state.json
      → append evidence_recorded
```

`charter_record` does not run commands, execute verifiers, apply handoffs, or update feature lifecycle sidecars.

### Async Subagent Attribution Flow

```
subagent spawn/run includes pi-charter metadata
  → subagent:async-started
      → handleAsyncStarted()
      → RunningSubagentRegistry.start(...)
      → append feature_started
  → subagent:async-complete
      → handleAsyncComplete()
      → RunningSubagentRegistry.complete(...)
      → append feature_completed or feature_failed
```

The event names are legacy-compatible (`feature_*`) but the current UI/status model is VAL/milestone based rather than a feature DAG.

### Completion Flow

```
charter(action="complete")
  → resolve explicit/bound charter id
  → require state.status === "active"
  → parse charter/criteria and criterion-state
  → run completion gate + blocking checks + REPORT.md completeness
  → dispatchHook("charter:before_complete")
  → write state.status = "completed"
  → append charter_completed
```

### Widget / Picker / Ralph Flow

```
session_start / turn_end / selection refresh / async updates
  → reconcile binding
  → loadCharterSnapshot()
      reads state.json, parsed charter/criteria, criterion-state.json, running subagents
  → buildViewModel()
  → ui.setWidget("pi-charter", factory, { placement: "aboveEditor" })

/charters
  → buildPickerSnapshot()
      reads state, parsed markdown, criterion-state, blockers, recent evidence
  → CharterPickerComponent custom TUI overlay

subagent:all-idle
  → registerCharterRalphLoop debounce/min-interval
  → buildRalphPromptForCharter()
  → pi.sendMessage({ customType: "charter-ralph-continue", deliverAs: "steer", triggerTurn: true })
```

Ralph prompt case selection currently maps every non-skipped status to `active`; `src/prompts/ralph/planning.md` is therefore orphaned while `RalphCase` only has `active`.

### Reminder Flow

`reminders-bridge.ts` can emit `REMINDER_UPSERT_EVENT` and `REMINDER_REMOVE_EVENT`, but `index.ts` does not call `registerCharterRemindersBridge()`, and its registration function currently registers no handlers. Treat reminders as helper/event-bus remnants, not part of the active entrypoint registration sequence.

---

## Integration Points

### With `@earendil-works/pi-coding-agent`

- `pi.registerTool()` registers `charter`, `charter_record`, `charter_status`.
- `pi.registerCommand()` registers `/charter` and `/charters`.
- `pi.registerFlag()` registers `--charter-objective` and `--charter-resume`.
- `pi.on("session_start", fn)` reconciles bindings, clears stale terminal bindings, handles resume/objective startup flows, and refreshes UI.
- `pi.on("turn_end", fn)` refreshes the widget.
- `pi.on("session_shutdown", fn)` clears selection/widget-local state.
- `pi.sendUserMessage()` is used by `/charter` and `--charter-objective` bootstrapping.
- `pi.sendMessage({ customType, deliverAs: "steer" })` injects Ralph continuation messages.
- `pi.events.on/emit()` handles pi-subagents and reminder-bus communication.

### With `pi-subagents`

- Incoming live events: `subagent:expose-api`, `subagent:lineage`, `subagent:async-started`, `subagent:async-complete`, `subagent:all-idle`.
- Outgoing persona-dir registration events are not emitted by current runtime. There are zero bundled charter personas.
- Async attribution depends on metadata keys in `infrastructure/subagent-bridge.ts`.

### With `pi-tui`

- `ctx.ui.setWidget("pi-charter", factory, { placement: "aboveEditor" })` hosts the compact widget.
- `ctx.ui.custom(factory, options)` opens the `/charters` picker overlay.
- `CharterPickerComponent` implements `Component` with `render(width)` and `handleInput(data)`.
- `truncateToWidth()`, `visibleWidth()`, and `matchesKey()` support terminal layout/input handling.

### On-Disk State Layout

```
<project>/.pi/charters/
├── index.json
└── <charterId>/
    ├── charter.md
    ├── criteria.md
    ├── state.json
    ├── criterion-state.json
    ├── REPORT.md
    ├── events.jsonl
    ├── architecture.md                    # optional
    ├── prompts/
    │   └── ralph/
    │       └── <case>.md                  # optional override; active is the live case
    ├── qa-briefs/
    │   └── *.md                           # optional status display inputs
    └── work/
        └── <feature-or-_charter>/
            └── evidence/
                └── <stamp>/
                    └── evidence.json

<homeDir>/.pi/agent/sessions/<sessionId>/charter.json
```

`store.createCharterWorkspace()` creates `charter.md`, `criteria.md`, `state.json`, `criterion-state.json`, `events.jsonl`, and `work/`. It does not create `plan.json`, `plan/`, `handoffs/`, or `feature-state.json`.

### With the `pi-charter` Skill

The extension's `/charter` command and startup flag flows instruct the agent to use the `pi-charter` skill for workflow guidance. The skill drives agent behavior; the runtime itself stays small and deterministic.

---

## Vestigial / Tech Debt to Preserve Honestly

- `forceCompleteCharter()` and `amendCharter()` remain exported from `application/service.ts` but are not wired to registered tool actions. `forceCompleteCharter()` delegates to abandon for an abandoned target; `amendCharter()` throws `amend.removed`.
- `charter:before_lock_plan` remains in `application/hooks.ts` with `planDigest`/`featureCount`, but there is no live emitter and no `plan-service.ts`.
- `feature-state.json` appears in comments and in `subagent-write-audit.ts`'s protected-file list, but no current reader/writer sidecar creates or consumes it.
- `milestone_ready_for_review` is residual-read compatibility in `service.ts`; it is not currently emitted.
- `src/prompts/ralph/planning.md` is orphaned because `RalphCase` only has `active`.
- `infrastructure/subagent-bridge.ts` still declares persona-dir registration payloads, but current runtime does not register bundled persona dirs and the repo ships zero bundled charter personas.
- Comments in a few modules still mention old planning/feature concepts; treat the live code paths and folder codemaps as authoritative.
