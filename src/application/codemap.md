# Application Layer — `src/application/`

Top-level orchestration. Each service is a pure-functional, side-effect-scoped unit testable without the extension host.

---

## `registration.ts`

**Responsibility** — Extension entry point. Wires all tools, commands, flags, and event handlers into the Pi extension API. Zero business logic; purely declarative composition.

**Public API** — Registers the following into `pi`:

| Symbol | Type | Purpose |
|---|---|---|
| `registerCharterTools(pi, options?)` | `function` | Registers `charter_manage`, `charter_plan`, `charter_record`, `charter_status` tools |
| `registerCharterCommands(pi)` | `function` | Registers `/charter` and `/charters` slash commands |
| `registerCharterFlags(pi, options?)` | `function` | Registers `--charter-objective` and `--charter-resume` flags; handles `session_start` |
| `registerCharterRalphLoop(pi, options?)` | `function` | Wires the deterministic idle reprompt loop |

**Design patterns**
- **Command pattern** per tool: `pi.registerTool({ name, parameters, execute })`.
- **TypeBox schemas** (`Type.Object(...)`) for all tool parameter validation; schemas ride alongside the tool definition.
- **Strategy dispatch** inside each `execute` callback: a `switch (params.action)` routes to the appropriate service function.
- **Dependency injection seam**: `options.homeDir` is a test seam that bypasses the real home-directory layout.
- **Closure-scoped re-entry guard**: the `/charters` picker sets `isPickerOpen = true` in the closure to prevent double-overlays.

**Data/control flow**

```
host session_start
  └─ registerCharterFlags: reconcileSessionBinding → rebind → upsertCharterReminder

user /charter "..."
  └─ registerCharterCommands: /charter handler → pi.sendUserMessage(...)
         → agent calls charter_manage:create → bindCharterToSession → upsertCharterReminder

user /charters
  └─ registerCharterCommands: /charters handler → openPicker() or verb dispatch
         verb "select" → setCharterSelection → requestSelectionRefresh
         verb "pause/resume/status" → resolveCharterForVerb → service call

Ralph idle events
  └─ registerCharterRalphLoop: subagent:all-idle handler
         → readSessionBinding → buildRalphPromptForCharter → pi.sendMessage(..., triggerTurn:true)
```

**Integration points**
- Imports: `plan-service`, `record-service`, `service` (lifecycle), `binding-service`, `reminders-bridge`, `store`, `subagent-bridge`, `async-bridge-service`, `widget`, `widget-state`, `widget-service`, `charter-selection`.
- Emits: `reminder:upsert`, `reminder:remove` (via `reminders-bridge`); `pi.sendUserMessage`, `pi.sendMessage`; `pi.on("turn_end")`; `pi.on("session_start")`.
- Consumes: `ctx.sessionManager.getSessionId`, `ctx.cwd`, `pi.getFlag(...)`.

---

## `service.ts`

**Responsibility** — Charter lifecycle state machine and completion gate. Contains the authoritative status transitions, the next-action catalog, and the blocking/evidence trust logic.

**Public API**

| Export | Signature | Status |
|---|---|---|
| `createCharter` | `(projectDir, {objective, name?, budget?, idempotencyKey?, charterId?, now?, sessionId?}) => CharterServiceResult<CharterState>` | planning |
| `getCharterStatus` | `(projectDir, {charterId?}) => CharterStatusResult` | any |
| `pauseCharter` | `(projectDir, {charterId?, reason?, now?}) => CharterServiceResult` | non-terminal |
| `resumeCharter` | `(projectDir, {charterId?, now?}) => CharterServiceResult` | paused |
| `completeCharter` | `(projectDir, {charterId?, completionNote?, now?}) => CharterServiceResult` | active/review |
| `forceCompleteCharter` | `(projectDir, {charterId?, reason, target?, now?}) => CharterServiceResult` | any |
| `amendCharter` | `(projectDir, {charterId?, reason, target?, now?}) => CharterServiceResult` | terminal |
| `nextActionsForStatus` | `(status: CharterStatus) => NextAction[]` | pure |
| `listActiveCharters` | `(projectDir) => CharterListEntry[]` | — |
| `listUnreviewedMilestones` | `(dir) => UnreviewedMilestone[]` | — |
| `computeBlockingForComplete` | `(criteria, criterionState, context?) => BlockingForCompleteEntry[]` | pure |
| `effectiveRequireReviewSubagent` | `(criterion, milestoneIds) => boolean` | pure (VAL-12 rule) |
| `loadBlockingContext` | `(dir, charterId) => BlockingContext` | pure helper |

**Status state machine**

```
planning ──[lock_plan]──> active ──[complete]──> completed
                         │                        ↑
                         │                        │
                    [pause]                      [amend_charter]
                         │                        │
                         ▼                        │
                        paused ──[resume]─────────┘
                         │
                         ├──[complete]──> review ──[complete]──> completed
                         │
                         └──[force_complete]──> abandoned | budget_limited
```

**Completion gate (`checkCompletionGate`)**
Enforced by `completeCharter` before transition. Criteria must have:
1. `outcome === "pass"` evidence.
2. If `requireFreshEvidence: true`: evidence timestamp must be within 24 h of now AND not pre-date the plan lock.
3. If `effectiveRequireReviewSubagent === true`: source must be `"verifier"` or `"subagent"` (never `"manual"`).

**Trust / blocking logic (`computeBlockingForComplete`)**
A criterion is "blocking for complete" (surfaced by `getCharterStatus.details.blockingForComplete`) when:
- It has pass evidence AND that evidence is low-trust (`trustRank <= 1` — manual without because, or manual+because from a non-charter-reviewer writer); OR
- `effectiveRequireReviewSubagent === true` AND no pass evidence has `recordedBy` starting with `subagent:charter-reviewer:`; OR
- `effectiveRequireReviewSubagent === true` AND every charter-reviewer reviewer shares the implementer's session id (`implementer-only-reviewer`).

**VAL-12 auto-default**: `effectiveRequireReviewSubagent` returns `true` when the criterion id appears in any `milestone_ready_for_review` event's `criterionIds` and the criterion does not explicitly declare the field.

**VAL-13 identity-disjoint predicate**: Implemented by `loadBlockingContext` — walks `work/<featureId>/evidence/` files, extracts `lastWorkerSessionId` from `feature-state.json`, and matches against `recordedBy` session segments.

**Design patterns**
- **State transition function**: each `*Charter` export is a pure-ish function that loads state, validates preconditions, mutates the state object, writes atomically, and returns a result.
- **Railway-oriented**: transitions throw on invalid preconditions; callers use try/catch or let the tool layer surface the error.
- **Lazy optional dependency**: `loadBlockingContext` returns empty maps on error, allowing callers to degrade gracefully to trust-gate-only behavior.
- **Idempotent writes**: state transitions check current status before writing to avoid no-op writes.

**Data/control flow**

```
charter_manage tool
  └─ resolveCharterId (explicit arg → session binding → error)
      └─ createCharter → createCharterWorkspace (store) → appendEvent
      └─ pauseCharter → writeCharterState → appendEvent
      └─ resumeCharter → writeCharterState → appendEvent
      └─ completeCharter
             ├─ checkCompletionGate (throw on failures)
             ├─ computeBlockingForComplete (throw on blocking)
             ├─ dispatchHook("charter:before_complete")
             └─ writeCharterState → appendEvent
      └─ forceCompleteCharter → dispatchHook("charter:before_force_complete")
      └─ amendCharter → dispatchHook("charter:before_amend_charter")
```

**Integration points**
- Reads: `charter.md` (domain/charter-md), `criterion-state.json` (record-service), `feature-state.json` (record-service), `events.jsonl` (store), plan `*.md` files.
- Writes: `state.json` (store), `events.jsonl` (store).
- Calls: `dispatchHook` (hooks), `computeDrift` (drift-service), `appendEvent` (store), `loadCharterIndex` (store), `loadCharterState` (store), `writeCharterState` (store), `parseCharterMarkdown` (domain).

---

## `plan-service.ts`

**Responsibility** — Feature plan CRUD and plan-lock transition. Manages the `plan/<featureId>.md` file layer and the `plan.json` drift snapshot.

**Public API**

| Export | Signature |
|---|---|
| `viewPlan` | `(projectDir, {charterId}) => PlanView` |
| `lockPlan` | `(projectDir, {charterId, now?, legacy?}) => LockPlanResult` |
| `addFeature` | `(projectDir, AddFeatureInput) => FeatureWriteResult` |
| `addFeatureBatch` | `(projectDir, AddFeatureBatchInput) => AddFeatureBatchResult` |
| `updateFeature` | `(projectDir, UpdateFeatureInput) => FeatureWriteResult` |

**`PlanView.drift` categories**
- `uncovered`: charter criteria with no feature claiming `fulfills: [criterionId]`.
- `orphanFeatures`: features with `fulfills: []`.
- `unknownFulfilledCriteria`: features claiming a criterion id not in the charter.
- `nextActions`: contextual next actions based on drift state.

**`lockPlan` preconditions (BLOCKs)**
- At least one VAL-* criterion in `charter.md`.
- At least one feature in `plan/`.
- No uncovered criteria.
- No orphan features.
- No unknown fulfilled criteria references.
- No precondition cycles (DFS color algorithm).
- (non-legacy only) No missing `Verifier:` lines.
- (non-legacy only) No weak verifiers (`verifier=manual` without `Because:`).

**Atomic batch write (`addFeatureBatch`)**
1. Validate every entry; detect duplicate ids within batch.
2. Scan `plan/` for id collisions with existing files.
3. Stage every write to `<finalPath>.<pid>.<timestamp>.<random>.tmp`.
4. `rename` in request order; on any failure roll back committed renames + unlink leftover temps.
5. Append `feature_added` events only after all renames succeed.
6. Write `plan.json` snapshot atomically (via `writeJsonAtomic`).

**Design patterns**
- **Atomic rename** for all file writes (no partial state on crash).
- **Two-phase commit**: validate → stage → commit.
- **Rollback**: best-effort unlink of committed files and staged temps on failure.
- **Content-addressable digest**: `digestFeatures` produces `sha256:<hex>` of canonicalized feature metadata for `planDigest`.

**Data/control flow**

```
charter_plan tool
  └─ viewPlan → parse charter.md + readFeatures(plan/) → PlanView
               └─ writeJsonAtomic(plan.json)
  └─ lockPlan → viewPlan → precondition checks → dispatchHook → writeCharterState → appendEvent("plan_locked")
  └─ addFeature/addFeatureBatch → validate → writeFile/rename → appendEvent("feature_added")
  └─ updateFeature → readFile → merge → writeFile → appendEvent("feature_updated")
```

**Integration points**
- Reads: `charter.md` (domain/charter-md), `plan/*.md` (domain/feature-md).
- Writes: `plan/<id>.md`, `plan.json` (via `writeJsonAtomic`).
- Calls: `appendEvent` (store), `charterDir` (store), `loadCharterState` (store), `writeCharterState` (store), `writeJsonAtomic` (store), `dispatchHook` (hooks).

---

## `record-service.ts`

**Responsibility** — Evidence recording, verifier execution, handoff application, and milestone projection. Governs all writes to the evidence layer (`work/<featureId>/evidence/`, `criterion-state.json`, `feature-state.json`).

**Public API**

| Export | Signature |
|---|---|
| `recordEvidence` | `(projectDir, RecordEvidenceInput) => RecordEvidenceResult` |
| `recordEvidenceBatch` | `(projectDir, RecordEvidenceBatchInput) => RecordEvidenceBatchResult` |
| `loadCriterionState` | `(dir, charterId) => CriterionStateFile` |
| `verifyCriterion` | `(projectDir, VerifyCriterionInput) => VerifyCriterionResult` |
| `applyHandoff` | `(projectDir, ApplyHandoffInput) => ApplyHandoffResult` |
| `loadFeatureState` | `(dir, charterId) => FeatureStateFile` |

**Evidence record shape**
Each write creates:
- `work/<featureId>/evidence/<criterionId>__<stamp>.json` — the evidence document.
- Updates `criterion-state.json` with the latest record for that criterion.
- Appends `evidence_recorded` to `events.jsonl`.

**`recordEvidenceBatch` phases**
1. Validate all entries (no I/O).
2. Stage every evidence file (`writeTextAtomic` is per-file atomic).
3. On failure: unlink all written files; re-throw before `criterion-state.json` write.
4. Single `writeJsonAtomic(criterion-state.json)` covering all entries.
5. Append one `evidence_recorded` per entry.
6. Project feature completion + milestone readiness.

**Verifier execution (`verifyCriterion`)**
- Spawns `/bin/sh -c <command>` via Node `child_process.spawn`.
- Captures stdout/stderr up to 64 KB each; truncates and sets `truncated: true`.
- SIGKILL after `timeoutMs` (default 120 s).
- Maps exit code 0 → `outcome: "pass"`, else `"fail"`.
- Writes evidence with `source: "verifier"` and captures exit code, duration, stdout, stderr, truncated, timedOut in `details`.

**Handoff application (`applyHandoff`)**
- Validates all `completedCriteria` criterion ids against the charter.
- Writes a handoff envelope (`handoffs/<stamp>__<featureId>__<sessionId>.json`).
- Calls `recordEvidence` for each completed criterion with `source: "subagent"` and `recordedBy: subagent:<persona>:<sessionId>`.
- Updates `feature-state.json`: flips to `completed` if all fulfilled criteria are pass, otherwise preserves `in_progress`.
- Detects review handoffs (session id contains `charter-reviewer`) and preserves the implementer's `lastWorkerSessionId` (VAL-13 disjunction).
- Projects `milestone_ready_for_review`.

**Milestone projection (`projectMilestoneReadyForReview`)**
- Triggered after any evidence write or handoff that affects a feature.
- Reads all features in the same milestone.
- If ALL features are `status: "completed"` (none `failed`) → appends a single idempotent `milestone_ready_for_review` event per `(milestoneId, planDigest)`.
- Event contains `milestoneId`, `planDigest`, and sorted `criterionIds` for VAL-11 review tracking.

**Design patterns**
- **Append-only evidence**: evidence files are never modified, only appended. `criterion-state.json` is the mutable latest-pointer.
- **Single atomic state write**: batch evidence uses one `writeJsonAtomic` call regardless of entry count.
- **Staged writes with rollback**: evidence files written before `criterion-state.json`; failures unlink the former before re-throw.
- **Idempotent projections**: `milestone_ready_for_review` deduplicates by `(milestoneId, planDigest)`.
- **Subagent identity encoding**: `recordedBy: "subagent:<persona>:<sessionId>"` enables VAL-11 and VAL-13 checks.

**Data/control flow**

```
charter_record tool
  ├─ evidence → recordEvidence → parse charter.md → writeTextAtomic(evidence.json)
  │            → writeJsonAtomic(criterion-state.json) → appendEvent("evidence_recorded")
  │            → projectFeatureCompletion → projectMilestoneReadyForReview
  │
  ├─ verify → verifyCriterion → spawn /bin/sh → recordEvidence(source=verifier)
  │
  └─ handoff_apply → applyHandoff
          → validate criterion ids
          → writeTextAtomic(handoff envelope)
          → recordEvidence per completed criterion (source=subagent)
          → writeJsonAtomic(feature-state.json)
          → appendEvent("handoff_applied")
          → projectMilestoneReadyForReview
```

**Integration points**
- Reads: `charter.md` (domain/charter-md), `criterion-state.json`, `feature-state.json`, `state.json` (for planDigest), `plan/*.md` (domain/feature-md), `events.jsonl`.
- Writes: `work/<featureId>/evidence/*.json`, `criterion-state.json`, `feature-state.json`, `handoffs/*.json`, `events.jsonl`.
- Calls: `appendEvent` (store), `charterDir` (store), `loadCharterState` (store), `writeJsonAtomic` (store), `writeTextAtomic` (store), `parseCharterMarkdown` (domain), `parseFeatureMarkdown` (domain), `projectFeatureCompletionFromEvidence`, `projectMilestoneReadyForReview`.

---

## `drift-service.ts`

**Responsibility** — Computes the four-category drift view over the live charter state. A pure, stateless computation given `projectDir`, `charterId`, and optional `now`.

**Public API**

```typescript
computeDrift(projectDir, { charterId, now?, freshnessWindowMs? }) => DriftViews
```

**`DriftViews` categories**

| Category | Condition |
|---|---|
| `uncovered` | Criterion has no entry in `criterion-state.json`, OR entry `outcome !== "pass"` |
| `stale` | `requireFreshEvidence: true` AND last evidence age > `freshnessWindowMs` (default 24 h) |
| `stuck` | Feature with `status === "in_progress"` in `feature-state.json` |
| `readyNext` | Feature where: not completed, all preconditions completed, and at least one fulfilled criterion is uncovered |

**Design patterns**
- **Pure projection**: reads state files, computes sets, returns a plain object. No side effects.
- **Set algebra**: uses `Set<string>` for O(1) membership tests across criteria and features.
- **Graceful degradation**: all file reads are try/catch; missing files return empty results.

**Integration points**
- Reads: `charter.md` (domain/charter-md), `plan/*.md` (domain/feature-md), `criterion-state.json`, `feature-state.json`, `state.json`.

---

## `binding-service.ts`

**Responsibility** — Dual-pointer session-to-charter binding with crash-safe reconciliation.

**Pointers**
- **Forward**: `state.json.sessionId` — lives at `<projectDir>/.pi/charters/<charterId>/state.json`.
- **Reverse**: `<homeDir>/.pi/agent/sessions/<sessionId>/charter.json` → `{ sessionId, charterId, projectDir, boundAt }`.

**Public API**

| Export | Signature |
|---|---|
| `bindCharterToSession` | `(projectDir, {charterId, sessionId, homeDir?, now?}) => SessionBindingRecord` |
| `rebindCharter` | `(projectDir, {charterId, sessionId, homeDir?, now?}) => SessionBindingRecord` |
| `clearSessionBinding` | `(sessionId, homeDir?) => void` |
| `readSessionBinding` | `({sessionId, homeDir?}) => SessionBindingRecord \| null` |
| `resolveCharterId` | `({charterId?}, {sessionId?, homeDir?}) => {charterId, source}` |
| `reconcileSessionBinding` | `({sessionId, homeDir?, now?}) => SessionBindingRecord \| null` |

**`resolveCharterId` resolution order**
1. Return explicit `charterId` argument → `source: "argument"`.
2. Read reverse binding → `source: "binding"`.
3. Throw `NoCharterBoundError`.

**Reconciliation (`reconcileSessionBinding`)**
- Reads reverse binding.
- If forward `state.json.sessionId` is missing or stale, restores it from the reverse record.
- Returns `null` if no reverse binding exists.

**Design patterns**
- **Atomic dual-write**: forward (`writeCharterState`) and reverse (`writeReverse`) are both written; reverse uses temp-file rename.
- **Crash-safe**: reverse pointer is only written after forward succeeds; reconciliation restores forward from reverse.
- **Custom error type**: `NoCharterBoundError` extends `Error` with `code: "NO_CHARTER_BOUND"` and `hint` for programmatic handling.

**Integration points**
- Reads: `state.json` (store), reverse `charter.json`.
- Writes: `state.json` (store), reverse `charter.json`.
- Called by: `registration.ts` tool handlers, `session_start` handler, `registerCharterFlags`.

---

## `hooks.ts`

**Responsibility** — In-process event bus for charter state-transition veto. Subscribers return `{decision: "block", reason}` or `{decision: "allow"}`; a single block throws.

**Public API**

| Export | Signature |
|---|---|
| `subscribeHook` | `(<event>, handler: HookSubscriber) => () => void` (returns unsubscribe) |
| `dispatchHook` | `(<event>, payload) => Promise<void>` |
| `clearHookSubscribers` | `(event?) => void` |

**Hook events**

| Event | Payload | Fires in |
|---|---|---|
| `charter:before_lock_plan` | `BeforeLockPlanPayload` | `lockPlan` |
| `charter:before_complete` | `BeforeCompletePayload` | `completeCharter` |
| `charter:before_amend_charter` | `BeforeAmendCharterPayload` | `amendCharter` |
| `charter:before_force_complete` | `BeforeForceCompletePayload` | `forceCompleteCharter` |

**Design patterns**
- **Veto pattern**: short-circuits on first `block` decision.
- **Module-level registry**: `Map<CharterHookEvent, Set<HookSubscriber>>` is a singleton. `subscribeHook` returns an unsubscribe function for teardown.
- **Async**: `dispatchHook` awaits each subscriber; subscribers may be sync or async.

**Integration points**
- Called by: `plan-service.ts` (`lockPlan`), `service.ts` (`completeCharter`, `amendCharter`, `forceCompleteCharter`).
- No infrastructure dependencies — pure application layer.

---

## `async-bridge-service.ts`

**Responsibility** — Subscribes to subagent-bridge `subagent:async-started` and `subagent:async-complete` events; writes `feature_started` / `feature_completed` / `feature_failed` events into the charter's `events.jsonl`.

**Public API**

| Export | Signature |
|---|---|
| `attributionFromMetadata` | `(metadata) => AsyncBridgeAttribution \| null` |
| `handleAsyncStarted` | `(input) => Promise<boolean>` |
| `handleAsyncComplete` | `(input) => Promise<boolean>` |

**Attribution extraction**
Requires `pi-charter.projectDir` and `pi-charter.charterId` in metadata (both must be non-empty strings). Optional: `pi-charter.featureId`, `pi-charter.criterionId`. Returns `null` if required keys are absent — silently ignored (no attribution).

**Design patterns**
- **Narrow bridge**: intentionally ignores events without both required metadata keys.
- **Event sourcing**: writes immutable `MissionEvent` records into `events.jsonl`.
- **Pure functions + async wrapper**: `handleAsyncStarted` / `handleAsyncComplete` are async but internally pure aside from the `appendEvent` call.

**Integration points**
- Reads: subagent event payload (from `subagent-bridge`).
- Writes: `events.jsonl` (via `appendEvent`).
- Called by: `registration.ts` (wires the two handlers to the subagent-bridge event bus).

---

## `reminders-bridge.ts`

**Responsibility** — Bridges pi-charter state to the pi-reminder subsystem. Emits `reminder:upsert` and `reminder:remove` events on the shared event bus.

**Public API**

| Export | Signature |
|---|---|
| `registerCharterRemindersBridge` | `(pi) => void` (registers no handlers; event-bus-only) |
| `upsertCharterReminder` | `(pi, projectDir, charterId) => Promise<void>` |
| `removeCharterReminder` | `(pi, charterId) => void` |

**Reminder content**
Emits a persistent reminder with `ttl: "persistent"` and `repeatEveryTurns: 8` containing:
- Charter name, status, `passCount/totalCount`.
- `next` guidance (computed differently for planning vs. active vs. paused).
- Status-specific guidance text.

**Defense in depth**
`upsertCharterReminder` checks for terminal status and calls `removeCharterReminder` instead of upserting.

**Design patterns**
- **Event emitter pattern**: does not hold state; delegates to `pi.events.emit`.
- **Graceful degradation**: `pi-reminders` may be absent; emitting to a bus with no subscribers is a no-op.
- **Seam for testing**: `upsertCharterReminder` is async-pure; `removeCharterReminder` is sync.

**Integration points**
- Called by: `registration.ts` tool handlers (create, pause, resume, lockPlan, evidence, handoff) and `session_start` handler.
- Emits: `reminder:upsert`, `reminder:remove` on `pi.events`.

---

## Cross-cutting concerns

### Trust model (VAL hierarchy)

```
trustRank(source, recordedBy, hasBecause) → number
  subagent:charter-reviewer:*  → 3 (always clears)
  verifier | hook | subagent:*  → 2 (clears if has because)
  manual + because              → 1 (clears only on charter-reviewer override)
  manual (no because)           → 0 (blocked unless charter-reviewer records)
```

### Evidence identity encoding

```
recordedBy ::= "agent:root"           # default root agent
            |  "subagent:<persona>:<sessionId>"
            |  "subagent:charter-reviewer:<sessionId>"  # VAL-11/13 trusted reviewer
```

### File layout per charter

```
<projectDir>/.pi/charters/<charterId>/
  state.json              # CharterState (mutable)
  charter.md              # Charter document (authored)
  events.jsonl            # Append-only event log
  criterion-state.json    # Latest evidence pointer per VAL
  feature-state.json      # Feature status (completed/in_progress/failed)
  plan.json               # Snapshot of plan coverage (generated)
  plan/
    <featureId>.md        # Feature definitions
  work/
    <featureId>/
      evidence/
        <criterionId>__<stamp>.json   # Evidence documents (append-only)
  handoffs/
    <stamp>__<featureId>__<sessionId>.json  # Handoff envelopes

<homeDir>/.pi/agent/sessions/<sessionId>/
  charter.json            # Reverse session binding
```

### Tool → Service → Store/Data domain path

```
charter_manage → service.ts → store.ts → filesystem
charter_plan   → plan-service.ts → domain/charter-md, domain/feature-md → filesystem
charter_record → record-service.ts → domain/charter-md → filesystem
charter_status → service.ts → drift-service.ts → filesystem
session_start   → binding-service.ts + reminders-bridge.ts
subagent events → async-bridge-service.ts → events.jsonl
```
