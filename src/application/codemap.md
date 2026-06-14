# src/application/

## Responsibility

Application layer for the partial v3 pi-charter runtime. It wires the Pi extension host to charter lifecycle services, session binding, evidence recording, status/drift projections, Ralph continuation, widgets, reminders, and subagent event bridges.

Code source of truth in this folder is the v3-active surface:
- Registered tools are exactly `charter`, `charter_record`, and `charter_status`.
- `charter` actions are exactly `create`, `pause`, `resume`, `complete`, `abandon`.
- `charter_record` supports `action: "evidence"` only, from either `entries` or `evidenceFile`.
- Runtime state is active/paused/completed/abandoned; there is no live planning/lock-plan tool, no `charter_plan`, and no tool action that runs verification.

## Design

### Host registration and UI composition

- `registration.ts` is the extension composition root for this layer.
  - `registerCharterTools()` registers three tools: `charter`, `charter_record`, `charter_status`.
  - `registerCharterCommands()` registers `/charter` and `/charters`; `/charter` sends instructions to the agent instead of creating a charter directly.
  - `registerCharterFlags()` registers `--charter-objective` and `--charter-resume`, reconciles session bindings on `session_start`, clears stale terminal bindings, and sends startup instructions for new objectives.
  - `registerCharterSubagentBridge()` captures the pi-subagents exposed API and auto-binds child sessions from `subagent:lineage`.
  - `registerCharterAsyncBridge()` maps subagent async events into charter mission events.
  - `registerCharterRalphLoop()` sends deterministic `deliverAs: "steer"` continuation messages on `subagent:all-idle` when a bound charter is not skipped.
  - `registerCharterRalphMessageRenderer()` renders those steer messages.
  - `registerCharterWidget()` maintains the bound-charter widget above the editor.

### Lifecycle service

- `service.ts` owns lifecycle transitions and status projection.
  - Live exports used by registered tools: `createCharter`, `pauseCharter`, `resumeCharter`, `completeCharter`, `abandonCharter`, `getCharterStatus`, `listActiveCharters`.
  - `createCharter()` creates a workspace immediately in `active` state.
  - `pauseCharter()` moves any non-terminal charter to `paused` and records `previousStatus`.
  - `resumeCharter()` only accepts `paused` and returns to `active`.
  - `completeCharter()` only accepts `active`; it checks VAL pass evidence, freshness, manual-evidence rationale, and `REPORT.md` completion before dispatching `charter:before_complete` and writing `completed`.
  - `abandonCharter()` requires a non-empty reason, dispatches `charter:before_abandon`, and writes `abandoned`.
  - `getCharterStatus()` returns phase, objective, migration hint, VAL totals, parsed milestone summaries, drift, qa briefs, parsed commands, parse warnings, `blockingForComplete`, and legal `nextActions`.
  - `nextActionsForStatus()` is the live legal-action catalog. `buildActiveNextActions()` currently returns only the base status actions for active charters.
  - `computeBlockingForComplete()` surfaces latest non-pass evidence as `val-not-pass` and manual pass evidence without `because` as `manual`; `source`/`recordedBy` are otherwise display/provenance only.

### Evidence recording

- `record-service.ts` is the evidence writer and `criterion-state.json` owner.
  - `recordEvidence()` writes one evidence record under `work/<featureId-or-_charter>/evidence/<stamp>/evidence.json`, updates `criterion-state.json`, and appends `evidence_recorded`.
  - `recordEvidenceBatch()` validates all entries first, writes all per-entry evidence files, rolls back written files on failure before state mutation, writes `criterion-state.json` once, then appends one event per entry.
  - `recordEvidenceFromFile()` imports a flat typed evidence JSON file, optionally detects/copies markdown narrative companions, and funnels through the batch writer.
  - Manual evidence requires a non-empty `because`; no command verifier is executed here.
  - `loadCriterionState()` is the tolerant reader for `criterion-state.json`, returning an empty state when absent/unreadable.

### Drift and sidecars

- `drift-service.ts` computes status views from parsed charter + criterion state.
  - `uncovered`: missing criterion state or latest outcome not pass.
  - `stale`: `requireFreshEvidence` pass evidence older than the latest `src/` change.
  - `readyNext`: the first uncovered VAL in milestone order, or flat criterion order when no milestones are parsed.
  - `sidecarDrift`: delegated to `sidecar-drift.ts`.
  - `milestoneArtifacts`: passed milestones whose `work/<milestoneId>/evidence` directory is absent.
- `sidecar-drift.ts` compares `state.json` and `criterion-state.json` mtimes against their `lastToolWriteAt` fields and reports out-of-band edits.

### Session binding and child propagation

- `binding-service.ts` maintains two pointers:
  - Forward pointer: `.pi/charters/<charterId>/state.json.sessionId`.
  - Reverse pointer: `<homeDir>/.pi/agent/sessions/<sessionId>/charter.json`.
- `bindCharterToSession()` and `rebindCharter()` update the forward state and reverse file atomically enough for normal recovery.
- `reconcileSessionBinding()` repairs missing/stale forward pointers from the reverse pointer.
- `resolveCharterId()` resolves explicit `charterId` first, then bound session, else throws `NoCharterBoundError`.
- `writeChildBinding()` writes participant child-session bindings; `registration.ts` calls it via `autoBindChildFromLineage()` when pi-subagents emits lineage.

### Hooks, errors, and architecture helpers

- `hooks.ts` is a minimal in-process veto bus. Live event types are `charter:before_lock_plan`, `charter:before_complete`, and `charter:before_abandon`; subscribers return allow/block decisions and the first block throws.
- `errors.ts` defines `CharterToolError`, an `Error` with stable `code` and `nextActions` for tool handlers/status guidance.
- `architecture-writer.ts` writes `.pi/charters/<id>/architecture.md` while the charter is `active`:
  - `writeAtPlanning()` only writes if the file is empty/missing.
  - `appendDiscovered()` appends under an H2 `## Discovered` section and rejects `### Discovered`.
  - `overwriteAtAmend()` overwrites during `active` despite the amend naming.
  - These helpers are exported application services; they are not wired to a registered tool in this folder.

### Ralph, reminders, subagents, and version

- `ralph-service.ts` builds deterministic continuation prompts for non-skipped charters.
  - Skips `completed`, `abandoned`, and `paused`.
  - Currently every non-skipped status maps to prompt case `active`.
  - Prompt template lookup order is repo override, charter override, bundled prompt.
  - `renderStatusSummary()` compacts status, VAL totals, drift, parse warnings, next actions, commands, and blockers.
- `reminders-bridge.ts` is event-bus-only; `registerCharterRemindersBridge()` registers no handlers. `upsertCharterReminder()` emits `REMINDER_UPSERT_EVENT`; terminal state converts to `REMINDER_REMOVE_EVENT`.
- `async-bridge-service.ts` appends `feature_started`, `feature_completed`, or `feature_failed` events when subagent async payload metadata includes `pi-charter.projectDir` and `pi-charter.charterId`.
- `subagent-api.ts` caches the pi-subagents exposed API handle after `subagent:expose-api`.
- `subagent-bootstrap.ts` formats parsed charter `## Commands` into inline/block text and renders a child prompt containing charter/feature/criterion IDs plus commands.
- `subagent-write-audit.ts` snapshots managed charter files and plan markdown files to detect forbidden subagent writes.
- `version.ts` returns `package.json` version.

## Flow

### Tool flow

```text
charter action=create
  registration.ts
    → createCharter(ctx.cwd, objective/name/budget/idempotencyKey/sessionId)
    → bindCharterToSession(sessionId) when available
    → toolResult

charter action=pause|resume|complete|abandon
  registration.ts
    → binding-service.resolveCharterId(explicit or session binding)
    → pauseCharter | resumeCharter | completeCharter | abandonCharter
    → resume also rebinds current session
    → toolResult

charter_record action=evidence
  registration.ts
    → binding-service.resolveCharterId
    → getCharterStatus
    → if evidenceFile: recordEvidenceFromFile
    → else entries: recordEvidenceBatch
    → toolResult

charter_status
  registration.ts
    → binding-service.resolveCharterId
    → getCharterStatus
    → formatCharterStatusText + structured details
```

### Completion flow

```text
completeCharter
  → resolve charter id and load state
  → require state.status === "active"
  → load parsed charter + criterion-state.json + REPORT.md scaffold
  → checkCompletionGate:
       - at least one parsed VAL
       - each VAL latest outcome is pass
       - requireFreshEvidence VALs do not predate latest src/ change
  → computeBlockingForComplete:
       - non-pass latest evidence => val-not-pass
       - manual pass without because => manual
  → checkReportCompletion
  → if failures: throw CharterToolError(code="complete.gate_blocked")
  → dispatchHook("charter:before_complete")
  → write state.status="completed"
  → append charter_completed event
```

There is no identity-disjoint/session-disjoint completion gate and no trust-rank model. `requireReviewSubagent` is parsed/displayed by the domain layer but is not a completion gate here.

### Status/drift flow

```text
getCharterStatus
  → load state
  → computeDrift
       → parsed charter + criterion-state
       → src freshness check
       → sidecar mtime drift for state.json and criterion-state.json
       → milestone artifact reminders
  → computeBlockingForCompleteSafely
  → computeMilestoneStatusSummariesSafely
  → load qa-brief names, commands, parse warnings
  → buildActiveNextActions / nextActionsForStatus
```

### Session, UI, and continuation flow

```text
session_start
  → reconcileSessionBinding
  → clear reverse binding if it points at completed/abandoned charter
  → optional --charter-resume: resume + rebind
  → optional --charter-objective: send user message instructing agent to create

subagent:lineage
  → autoBindChildFromLineage
  → read root reverse binding
  → write participant reverse binding for child if root charter is non-terminal

subagent:all-idle
  → registerCharterRalphLoop debounce/min-interval
  → read bound session charter
  → buildRalphPromptForCharter
  → pi.sendMessage(customType="charter-ralph-continue", deliverAs="steer", triggerTurn=true)

turn_end/session_start/widget refresh
  → reconcile binding
  → loadCharterSnapshot
  → renderCharterWidget above editor
```

## Integration

### Files read/written under a charter directory

Live current sidecars and documents:

```text
.pi/charters/<charterId>/
  state.json                 # mutable CharterState, includes status/sessionId/lastToolWriteAt
  charter.md                 # authored objective/scope/commands source parsed by domain
  criteria.md                # authored VAL register parsed by domain via loadParsedCharter
  criterion-state.json       # mutable latest evidence pointer per VAL
  REPORT.md                  # completion report scaffold/readiness gate
  events.jsonl               # append-only lifecycle/evidence/subagent events
  architecture.md            # optional architecture helper target
  qa-briefs/*.md             # status display only
  prompts/ralph/<case>.md    # optional Ralph prompt override
  work/<feature-or-_charter>/evidence/<stamp>/evidence.json
```

Session binding file:

```text
<homeDir>/.pi/agent/sessions/<sessionId>/charter.json
```

`feature-state.json` is not a live sidecar in this folder; it appears only in comments and the subagent write-audit protected-file list.

### External/event integrations

- Pi extension API: tool/command/flag registration, `session_start`, `turn_end`, `session_shutdown`, message rendering, widgets, and UI custom picker.
- pi-subagents event bus: `subagent:expose-api`, `subagent:lineage`, `subagent:async-started`, `subagent:async-complete`, `subagent:all-idle`.
- pi-reminders event bus: `REMINDER_UPSERT_EVENT`, `REMINDER_REMOVE_EVENT` emitted by helper functions; no direct dependency on pi-reminders being installed.
- Infrastructure store: `charterDir`, `createCharterWorkspace`, `loadCharterState`, `writeCharterState`, `loadParsedCharter`, `appendEvent`, `withCharterLock`, `writeTextAtomic`, `writeJsonAtomic`.
- Domain parsers/types: parsed charter/milestones/criteria/commands, evidence schema validation, source freshness, report markdown checks.

### Module inventory

| File | Current role |
|---|---|
| `architecture-writer.ts` | Active-state writer/appender for `architecture.md`; exported helpers but not tool-wired. |
| `async-bridge-service.ts` | Converts attributed subagent async lifecycle events to charter `events.jsonl` entries. |
| `binding-service.ts` | Forward/reverse session-charter binding, child binding, reconciliation, explicit-or-bound id resolution. |
| `drift-service.ts` | Computes uncovered/stale/ready-next/sidecar/artifact drift views. |
| `errors.ts` | `CharterToolError` with `code` and legal `nextActions`. |
| `hooks.ts` | In-process veto bus for defined charter hook events. |
| `ralph-service.ts` | Loads/renders deterministic Ralph continuation prompts and compact status summaries. |
| `record-service.ts` | Writes typed evidence files and `criterion-state.json`; imports evidence files/narratives. |
| `registration.ts` | Registers tools, commands, flags, widget, Ralph loop/renderer, subagent bridges. |
| `reminders-bridge.ts` | Emits reminder upsert/remove payloads; registration is a no-op. |
| `service.ts` | Lifecycle FSM, completion gate, status projection, legal next actions, active-charter listing. |
| `sidecar-drift.ts` | Detects out-of-band edits to `state.json` and `criterion-state.json`. |
| `subagent-api.ts` | Cached pi-subagents exposed API handle. |
| `subagent-bootstrap.ts` | Formats charter commands and child bootstrap prompt text. |
| `subagent-write-audit.ts` | Snapshots/diffs managed files to detect forbidden child writes. |
| `version.ts` | Reads extension version from `package.json`. |

## Vestigial / tech-debt

- `service.ts:663` exports deprecated `forceCompleteCharter()`, but `registration.ts` has no `force_complete` action; it delegates to `abandonCharter()` and rejects non-`abandoned` targets.
- `service.ts:680` exports deprecated `amendCharter()`, but `registration.ts` has no amend action; it always throws an `amend.removed` `CharterToolError`.
- `hooks.ts:11-25` still defines `charter:before_lock_plan` and a payload containing `planDigest`/`featureCount`, but `plan-service.ts` and the lock-plan flow are absent, so there is no live emitter in this folder.
- `service.ts:699-703` keeps `BlockingContext` fields for `milestone_ready_for_review` and implementer sessions; current completion logic does not use them as a gate.
- `service.ts:803-819` still reads residual `milestone_ready_for_review` events from `events.jsonl`, while `service.ts:859-871` explicitly no longer emits legacy review-prompt next actions.
- `service.ts:791-795` comments mention `feature-state.json`, `plan/*.md`, and work evidence for blocking context, but the implementation only reads `events.jsonl` for `milestone_ready_for_review` ids.
- `subagent-write-audit.ts:6-14` protects `feature-state.json` from subagent writes even though no live reader/writer in this folder creates or consumes it.
