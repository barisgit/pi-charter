# src/application/

## Responsibility

Coordinates charter lifecycle operations and Pi host orchestration. It turns tool, command, session, and event-bus activity into domain decisions, persistence calls, UI refreshes, Objective-led Ralph continuation, and the bounded Ralph guard.

## Design patterns

- **Application service:** `service.ts` implements create/list/status/pause/resume/complete/abandon and returns legal `NextAction` guidance.
- **Adapter registration:** `registration.ts` binds those use cases to the one Pi tool, slash commands, hooks, widget, dashboard, and Ralph message renderer.
- **Observer:** `hooks.ts` hosts `charter:before_complete` and `charter:before_abandon`; a blocking decision aborts the transition.
- **Whole-file snapshot:** `snapshots.ts` hashes charter.md and journals meaningful changes without source invalidation or freshness.
- **Serialized guard transition:** `ralph.ts` evaluates and persists the rolling activation history under the same project mutation lock as lifecycle writes.

## Data and control flow

1. Tool or slash-command input reaches `runCharterAction()` and the matching use case in `service.ts`.
2. Creation enforces one active charter per session and asks the store for a phases workspace. Lifecycle methods resolve an id, reject legacy writes, validate the transition, persist state, and append events.
3. `getCharterStatus()` returns Objective, References, Scope, Phases, phase counts, warnings, report presence, Markdown, legacy marker, optional guard state, and legal next actions.
4. `registerCharterFileHooks()` handles tool-result and turn-end boundaries through `refreshSessionSnapshots()` in `snapshots.ts`, journaling whole-file changes for mutable phases charters.
5. Ralph waits for the root agent and async subagents to become idle. `nextRalphActivation()` computes the guard transition; `attemptRalphActivation()` serializes eligibility, the actual send or pause, persistence, and journaling. Sends append `ralph_activated`; a guard pause appends `charter_paused` with reason `ralph-guard`.
6. Completion audits through worker judgment, generates or preserves REPORT.md, dispatches the before-complete hook, and transitions without phase or freshness gates.
7. Widget and dashboard registration project the same status data. Explicit slash resume is the only path that resets a guard pause. Lifecycle pause, complete, and abandon cancel pending local Ralph timers without touching unrelated jobs.

## Integration points

- Uses `src/domain/charter-file.ts`, `ids.ts`, and `types.ts` for parsing and state contracts.
- Uses `src/infrastructure/store.ts` for locking, workspace creation, state, journal, report, and snapshot I/O.
- Uses `src/infrastructure/logger.ts` and `subagent-bridge.ts` for diagnostics and idle coordination.
- Supplies status to `src/ui/widget.ts`, `widget-service.ts`, `picker-snapshot.ts`, and `charter-picker.ts`.
