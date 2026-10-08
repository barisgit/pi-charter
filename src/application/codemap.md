# src/application/

## Responsibility

Coordinates charter lifecycle operations and Pi host orchestration. It turns tool, command, session, and event-bus activity into domain decisions, persistence calls, UI refreshes, Objective-led Ralph continuation, and the bounded Ralph guard.

## Design patterns

- **Application service:** `service.ts` implements create/list/status/pause/resume/complete/abandon and returns legal `NextAction` guidance.
- **Adapter registration:** `registration.ts` binds those use cases to the one Pi tool, slash commands, hooks, widget, dashboard, and Ralph message renderer.
- **Observer:** `hooks.ts` hosts `charter:before_complete` and `charter:before_abandon`; a blocking decision aborts the transition.
- **Read on demand:** status parses the current `charter.md` on each call, with no lock, cache or write.
- **Serialized guard transition:** `ralph.ts` evaluates and persists the rolling activation history under the same project mutation lock as lifecycle writes.

## Data and control flow

1. Tool or slash-command input reaches `runCharterAction()` and the matching use case in `service.ts`.
2. Creation enforces one active charter per session and asks the store for a writable workspace. Lifecycle methods resolve an id, reject legacy writes, validate the transition, persist state, and append events.
3. `getCharterStatus()` reads state.json and the current charter.md without the mutation lock and returns Objective, References, Scope, remaining notes, warnings, optional-report presence, raw Markdown, legacy marker, optional guard state, and legal next actions.
4. Ordinary tool results and turn ends do no Charter I/O. `findBoundCharterState()` is the state-only binding lookup the widget uses; `getBoundCharterStatus()` adds the current file for Ralph.
5. Ralph waits for the root agent and async subagents to become idle, then restates the Objective, References, and Scope with a short continue-or-finish instruction. Charter adds no prompt while work is underway. `nextRalphActivation()` computes the guard transition; `attemptRalphActivation()` serializes eligibility, the actual send or pause, persistence, and journaling; its hooks only schedule, and file reads wait for idle. Sends append `ralph_activated`; a guard pause appends `charter_paused` with reason `ralph-guard`.
6. Completion requires a nonblank note, dispatches the before-complete hook, and transitions. It never creates or rewrites REPORT.md or `work/`.
7. The widget caches the binding as a tiny view, reloaded only on session start, lifecycle changes (including Ralph guard pause and recovery sends) and Ralph warnings; countdown ticks and warning clears render from the cache. The dashboard projects the same status data. Explicit slash resume is the only path that resets a guard pause. Lifecycle pause, complete, and abandon cancel pending local Ralph timers without touching unrelated jobs.

## Integration points

- Uses `src/domain/charter-file.ts`, `ids.ts`, and `types.ts` for parsing and state contracts.
- Uses `src/infrastructure/store.ts` for locking, workspace creation, state, journal, and report-path I/O.
- Uses `src/infrastructure/logger.ts` and `subagent-bridge.ts` for diagnostics and idle coordination.
- Supplies status to `src/ui/widget.ts`, `picker-snapshot.ts`, and `charter-picker.ts`.
