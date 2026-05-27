# src/ Codemap

## Directory Overview

```
src/
├── index.ts                   — Extension entrypoint; orchestrates registration order
├── application/               — Tool surface, service orchestration, event hooks
│   ├── registration.ts         — All register*() wiring (tools, commands, Ralph,
│   │                            subagent bridges, widget, personas, reminders)
│   ├── service.ts             — Charter lifecycle FSM (create/pause/resume/complete/
│   │                            force_complete/amend_charter) + status computation
│   ├── binding-service.ts     — Bidirectional session↔charter binding + reconciliation
│   ├── async-bridge-service.ts — Translates subagent:async-* events into MissionEvents
│   ├── plan-service.ts        — Feature DAG management (add/update/lock/view plan)
│   ├── record-service.ts      — Evidence recording, command verification, handoff apply
│   ├── hooks.ts               — In-process veto bus (before_lock_plan, before_complete, etc.)
│   └── reminders-bridge.ts   — pi-reminders event emitter for persistent charter reminders
├── domain/                     — Pure domain models; no I/O, no dependencies on application
│   ├── types.ts               — Shared TypeScript interfaces: CharterState, CharterCriterion,
│   │                            CharterEvent, RecordedBy, EvidenceSource, etc.
│   ├── charter-md.ts          — charter.md parser (H3 VAL-* headings + field lines) + template
│   ├── feature-md.ts          — plan/<id>.md parser (YAML frontmatter)
│   └── trust-rank.ts          — Integer trust ranking for evidence completion gate
├── infrastructure/             — Disk I/O, external event bus integration
│   ├── store.ts               — Atomic writes (tmp-rename), write queue (path mutex),
│   │                            charter workspace creation, event append, index management
│   └── subagent-bridge.ts     — Event constants + payload shapes shared with pi-subagents
│                                (local redeclarations; no direct import)
└── ui/                         — TUI widget rendering; pure string composition
    ├── widget.ts               — Single-charter widget: VAL progress bar + feature rows
    ├── multi-charter-widget.ts  — Multi-charter summary widget (one row per active charter)
    ├── widget-state.ts         — Pure reducer: ReducerInput → CharterWidgetVM (no I/O)
    ├── widget-service.ts       — loadCharterSnapshot() + RunningSubagentRegistry
    ├── charter-picker.ts       — pi-tui Component: master-detail picker overlay (TUI)
    └── charter-selection.ts    — Tri-value selection singleton + refresh callback
```

---

## Responsibility

### `application/` — Tool Surface and Service Layer

The application layer owns the **tool surface**, the **charter lifecycle FSM**, and **cross-cutting bridges**. It translates every inbound tool call or Pi event into a sequence of domain operations and infrastructure writes. It contains zero domain logic — only orchestration, validation, and wiring.

### `domain/` — Pure Domain Models

Domain files own all **business rules** with zero side effects. They define:
- The **charter lifecycle state machine** (`planning → active → review → completed/abandoned/budget_limited`, plus `paused` and `amend_charter` transitions).
- The **completion gate**: what counts as sufficient evidence for each VAL criterion, including the trust-rank and review-subagent rules.
- The **drift views**: uncovered criteria, stale evidence, stuck features, and ready-to-start features.
- **Parsing** of the two on-disk markdown formats (`charter.md`, `plan/<id>.md`) that define a charter's criteria and feature DAG.

### `infrastructure/` — Disk I/O and External Integrations

Infrastructure owns all **mutable side effects**: reading and writing files, emitting or subscribing to events on the shared `pi.events` bus, and managing the path-based mutex queue that prevents concurrent writes to the same file.

### `ui/` — TUI Widget Rendering

UI owns **what the user sees**. All rendering functions are pure string-in / string-array-out. No I/O, no global state, no timers inside the render functions (timers live in the `CharterWidget` host class in `widget.ts`).

---

## Design Patterns

### 1. Extension Entrypoint Orchestration (`index.ts`)

`charterExtension()` calls each `register*` function in a specific order, documented with comments explaining each dependency:

```
1. registerCharterFlags          — session_start listener must register first
2. registerCharterTools          — tool definitions (no event dependencies)
3. registerCharterCommands      — slash command handlers
4. registerCharterSubagentBridge — surface 2: capture exposed API (must precede persona-dir registration)
5. registerCharterAsyncBridge   — surface 3: async-started/async-complete → MissionEvent
6. registerCharterWidget        — AFTER async bridge so event handlers fire after bridge writes
7. registerCharterRemindersBridge — pi-reminders emitter
8. registerCharterRalphLoop      — deterministic idle reprompt listener
9. registerCharterRalphMessageRenderer — renders Ralph steer messages
10. registerCharterPersonas      — surface 1: register bundled persona dirs
```

### 2. Atomic Write Pattern (`infrastructure/store.ts`)

Every mutating write uses a **tmp-rename sequence**:

```
writeFile(<path>.<pid>.<now>.<rand>.tmp, data)
rename(<path>.tmp, <path>)
```

A **path-based promise queue** (`withPathLock`) prevents concurrent writers on the same file from racing — all writes for a given absolute path are serialized through one promise chain. This allows parallel tool calls within a single turn without losing writes.

### 3. Session↔Charter Binding (`application/binding-service.ts`)

Bidirectional pointer between a Pi session and a charter:

- **Forward**: `state.json.sessionId` lives in `<project>/.pi/charters/<id>/state.json`
- **Reverse**: `<homeDir>/.pi/agent/sessions/<sid>/charter.json` → `{ sessionId, charterId, projectDir, boundAt }`

`reconcileSessionBinding(sessionId)` restores the forward pointer from the reverse pointer after a process restart. Both pointers are written atomically.

`NoCharterBoundError` extends `Error` with a stable `code = "NO_CHARTER_BOUND"` and a `hint` field so callers can read it programmatically without string-parsing.

### 4. MissionEvent Append-Only Log (`infrastructure/store.ts` → `events.jsonl`)

All charter lifecycle events are appended (never mutated) to `events.jsonl`:
`charter_created`, `plan_locked`, `feature_added`, `feature_started`, `feature_completed`, `feature_failed`, `evidence_recorded`, `handoff_applied`, `milestone_ready_for_review`, `charter_paused`, `charter_resumed`, `charter_completed`, `charter_force_completed`, `charter_amended`.

The event log is the **authoritative history** for the widget's running-subagent attribution and milestone review detection.

### 5. Pure Reducer → ViewModel (`ui/widget-state.ts`)

`buildViewModel(ReducerInput): CharterWidgetVM` is the single pure function that projects raw charter state into the render-friendly view model. It is:
- Fully deterministic (injectable `now` for tests)
- Has zero I/O or UI dependencies
- Produces both the capped feature-row list (`rows[]`) for rendering and the full audit list (`featureRows[]`) for callers that need it

### 6. Evidence Sidecar Pattern (`application/record-service.ts`)

Evidence records are **append-only sidecars**:

```
work/<featureId>/evidence/<stamp>/evidence.json      ← one per run
criterion-state.json                                  ← latest per criterion
```

`criterion-state.json` is the running summary (latest outcome per VAL). Individual evidence files are preserved for audit, handoff reconstruction, and the identity-disjoint review predicate.

### 7. Hook Bus (`application/hooks.ts`)

An in-process pub/sub registry for **vetoable pre-transition hooks**:
- `charter:before_lock_plan`
- `charter:before_complete`
- `charter:before_amend_charter`
- `charter:before_force_complete`

Subscribers return `{decision: "block", reason}` or `{decision: "allow"}`. A single veto throws, stopping the transition.

### 8. Three-Layer pi-subagents Bridge (`infrastructure/subagent-bridge.ts` + `registration.ts`)

pi-charter and pi-subagents communicate over the shared `pi.events` bus. pi-charter defines three surfaces:

| Surface | Direction | Event | Effect |
|---|---|---|---|
| 1 | emit | `subagent:register-persona-dir` | pi-subagents loads bundled charter personas |
| 2 | receive | `subagent:expose-api` | Captures `spawnRaw` API for programmatic subagent spawns |
| 3 | receive | `subagent:async-started/complete` | `async-bridge-service.ts` attributes runs → `events.jsonl` |

Metadata keys (`pi-charter.projectDir`, `pi-charter.charterId`, `pi-charter.featureId`, `pi-charter.criterionId`) stamp every charter-tagged subagent spawn; the async bridge reads these keys back to route events.

### 9. Milestone Ready-for-Review Projection (`application/record-service.ts`)

After every evidence record or handoff:
1. `projectFeatureCompletionFromEvidence` — flips `feature-state.<id>.status → "completed"` when all fulfilled VALs have pass evidence
2. `projectMilestoneReadyForReview` — if all features in a milestone are completed (none failed), emits one `milestone_ready_for_review` event per `(milestoneId, planDigest)` tuple (idempotent)

The `milestone_ready_for_review` event is the trigger for VAL-11's review subagent gate: a criterion counts as reviewed only when there is charter-reviewer evidence with `ts >= milestone_ready_for_review.ts`.

### 10. Completion Gate Trust Model (`domain/trust-rank.ts` + `service.ts`)

Evidence trust rank: `subagent (3) > command|hook (2) > manual+because (1) > manual (0)`.

A criterion is **blocking for complete** when:
- It has pass evidence but the writer is `agent:root` with no `because` (rank 0), or
- `requireReviewSubagent` is effective `true` (explicit or auto-defaulted from milestone coverage) and no pass evidence has a `subagent:charter-reviewer:*` writer, or
- The implementer and reviewer share the same session id (VAL-13 identity-disjoint rule)

---

## Data/Control Flow

### Charter Creation Flow

```
/charter <objective>
  → pi.sendUserMessage (objective text)
  → agent calls charter_manage(action=create)
    → service.createCharter(projectDir, {objective, ...})
      → store.createCharterWorkspace()
          mkdir .pi/charters/<id>/plan/
          write charter.md (initial template)
          write state.json {status: "planning"}
          write plan.json, feature-state.json, criterion-state.json (empty)
          appendEvent("charter_created")
          updateIndex(index.json)
      → binding.bindCharterToSession(sessionId, charterId)
      → reminders.upsertCharterReminder()
    → tool returns CharterServiceResult {nextActions}
```

### Planning Flow

```
charter_manage(action=create) → status=planning
  → charter_plan(action=add_feature) × N
      → plan-service.addFeatureBatch() (atomic, temp-rename commit)
        appendEvent("feature_added") × N
  → charter_plan(action=view) → drift view (uncovered criteria, orphan features)
  → charter_plan(action=lock_plan)
      → viewPlan() reads charter.md + plan/*.md
      → validation: no uncovered, no orphans, no precondition cycles, weak verifier BLOCK
      → dispatchHook("charter:before_lock_plan") ← veto point
      → state.status → "active" + planDigest
      → appendEvent("plan_locked")
      → reminders.upsertCharterReminder()
```

### Active Execution Flow

```
charter_manage(action=lock_plan) → status=active
  → agent delegates to subagent({async:true, metadata:{pi-charter.*}})
      → subagent:async-started event fires
        → async-bridge.handleAsyncStarted()
          → RunningSubagentRegistry.start(runId, ...)
          → appendEvent("feature_started")
      → async work proceeds
      → subagent:async-complete event fires
        → async-bridge.handleAsyncComplete()
          → RunningSubagentRegistry.complete(runId)
          → appendEvent("feature_completed" | "feature_failed")
      → agent calls charter_record(action=evidence) OR charter_record(action=verify)
        → record-service.recordEvidence() OR record-service.verifyCriterion()
          write work/<featureId>/evidence/<stamp>/evidence.json
          update criterion-state.json
          appendEvent("evidence_recorded")
          projectFeatureCompletionFromEvidence() → feature-state update
          projectMilestoneReadyForReview() → milestone_ready_for_review event (when applicable)
          reminders.upsertCharterReminder()
      → agent calls charter_record(action=handoff_apply) [from charter-reviewer subagent]
        → record-service.applyHandoff()
          write handoffs/<stamp>__<featureId>__<sessionId>.json
          recordEvidence() for each completed criterion (source="subagent", recordedBy="subagent:charter-reviewer:<sessionId>")
          update feature-state.json (lastWorkerSessionId, status=completed)
          appendEvent("handoff_applied")
```

### Widget Refresh Flow

```
Events that trigger widget refresh:
  session_start      → registerCharterWidget's session_start handler
  turn_end           → registerCharterWidget's turn_end handler
  charter_* tool calls → implicit (next turn_end covers them)
  subagent:async-started/complete → RunningSubagentRegistry updated

refresh():
  → ctx.sessionManager.getSessionId()
  → reconcileSessionBinding({sessionId, homeDir})
  → loadCharterSnapshot() for the bound charter (reads state, charter.md, plan/*.md, criterion-state.json, feature-state.json)
  → buildViewModel(ReducerInput) → CharterWidgetVM
  → ui.setWidget("charter-detail", factory) ← when session binding resolves to a snapshot
```

### Reminders Flow

```
tryUpsertCharterReminder / trySyncCharterReminder (called after every lifecycle tool)
  → reminders-bridge.upsertCharterReminder(pi, projectDir, charterId)
      → pi.events.emit("reminder:upsert", {id, label, priority:10, ttl:"persistent", repeatEveryTurns:8, text, metadata})

tryRemoveCharterReminder (called on complete/force_complete)
  → pi.events.emit("reminder:remove", {id, source:"pi-charter"})
```

---

## Integration Points

### With `@earendil-works/pi-coding-agent` (ExtensionAPI)

- `pi.registerTool()` — registers `charter_manage`, `charter_plan`, `charter_record`, `charter_status`
- `pi.registerCommand()` — registers `/charter` and `/charters` slash commands
- `pi.registerFlag()` — registers `--charter-objective` and `--charter-resume` session-start flags
- `pi.on("session_start", fn)` — reconcile session binding, resume/create charter, register personas
- `pi.on("turn_end", fn)` — widget refresh
- `pi.on("session_shutdown", fn)` — unregister personas, reset selection state
- `pi.sendUserMessage()` — bootstrap new charters from `/charter` and `--charter-objective`
- `pi.sendMessage({customType, deliverAs:"steer"})` — Ralph steer injection
- `pi.events.on/emit()` — all pi-subagents and pi-reminders bridge communication

### With `pi-subagents` (via `pi.events` bus)

- **Incoming events consumed**: `subagent:expose-api`, `subagent:register-persona-dir-error`, `subagent:async-started`, `subagent:async-complete`
- **Outgoing events emitted**: `subagent:register-persona-dir`, `subagent:unregister-persona-dir`
- **Bundled personas**: `src/../agents/` directory registered as `scope: "internal"` persona directory

### With `pi-reminders` (via `pi.events` bus)

- **Outgoing events emitted**: `reminder:upsert`, `reminder:remove`
- Both are best-effort (no subscribers → no-op); lifecycle tools do not depend on reminder success

### With `pi-tui` (widget rendering)

- `ctx.ui.setWidget(key, factory, {placement})` — registers widget factories
- `tui.requestRender()` — triggers re-render (spinner animation, elapsed timer)
- `ctx.ui.custom(factory, options)` — opens picker overlay (`/charters` bare invocation)
- `CharterPickerComponent` implements `Component` from `@earendil-works/pi-tui` with `render(width)` and `handleInput(data)`
- `truncateToWidth()`, `visibleWidth()`, `matchesKey()` from `@earendil-works/pi-tui`

### On-Disk State Layout

```
<project>/
├── .pi/
│   └── charters/
│       └── <charterId>/
│           ├── state.json               ← CharterState (mutable)
│           ├── charter.md               ← parsed: VAL criteria, scope/constraints
│           ├── plan.json                ← cached plan drift snapshot
│           ├── plan/
│           │   └── <featureId>.md      ← FeatureDefinition YAML frontmatter
│           ├── work/
│           │   └── <featureId>/
│           │       └── evidence/
│           │           └── <stamp>/
│           │               └── evidence.json  ← EvidenceRecord (append-only)
│           ├── handoffs/
│           │   └── <stamp>__<featureId>__<sessionId>.json  ← HandoffEnvelope
│           ├── criterion-state.json     ← latest EvidenceRecord per VAL
│           ├── feature-state.json      ← feature lifecycle state
│           └── events.jsonl            ← append-only charter event log

<homeDir>/
└── .pi/
    └── agent/
        └── sessions/
            └── <sessionId>/
                └── charter.json         ← reverse binding (session → charter)
```

### With `pi-charter` Skill System

- `/charter <objective>` injects a prompt referencing the `pi-charter` skill
- Agents are expected to read the skill for workflow guidance before acting on a charter
- The skill file at `~/.pi/agent/skills/pi-charter/SKILL.md` defines the canonical end-to-end procedure

### With `charter-planner-critic` and `charter-reviewer` Personas

- **charter-planner-critic**: spawned during planning phase before `lock_plan`; stress-tests VAL coverage
- **charter-reviewer**: spawned with `pi-charter.charterId`, `pi-charter.featureId`, `pi-charter.criterionId` metadata; records `subagent`-sourced evidence with `recordedBy = "subagent:charter-reviewer:<sessionId>"`; applies handoffs

### Test Seams (`options.homeDir`)

Every `register*` function that reads `~/.pi` accepts an `options` object with test-only overrides:
- `homeDir?: string` — overrides `$HOME` for all path resolution
