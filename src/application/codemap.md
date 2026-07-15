# src/application/

## Responsibility

Acts as the application/service layer for charter lifecycle operations and Pi host orchestration. It translates tool, command, session, and event-bus activity into domain decisions, persistence calls, UI refreshes, and deterministic Ralph continuation.

## Design Patterns

- **Application service:** `service.ts` implements create/list/status/pause/resume/complete/abandon use cases and returns results with legal `NextAction` guidance.
- **Adapter registration:** `registration.ts` binds those use cases to one TypeBox-backed Pi tool, compact self-shell call/result rendering, `/charter` and `/charters` commands, host hooks, widgets, and a custom Ralph message renderer.
- **Observer:** `hooks.ts` maintains in-memory subscribers for `charter:before_complete` and `charter:before_abandon`; a blocking decision aborts the transition.
- **Monotonic snapshot clock:** `staleness.ts` assigns sequence numbers to charter edits and source modifications so a `pass` predating later source work is stale.
- **Typed application error:** `errors.ts` carries recovery-oriented `nextActions`; `version.ts` exposes the package version.

## Data and Control Flow

1. `registerCharterTools()` or `registerCharterCommands()` receives host input and dispatches it through `runCharterAction()` to `service.ts`; model-visible tool text compacts legal transitions to `next:` action names while structured `details.nextActions` retains full hints.
2. `createCharter()` enforces one active charter per session, generates an ID, and asks the store to scaffold the workspace. Other lifecycle methods resolve an ID, lock the charter directory, validate the transition, dispatch pre-terminal hooks, update state, and append events.
3. `getCharterStatus()` refreshes the parsed file snapshot, computes failure counts and stale passes, derives blockers/ready criteria, checks `REPORT.md`, and returns legal next actions.
4. `tool_result` hooks call `tickToolResult()` to consume one sequence, diff direct `charter.md` edits, and mark non-`.charters` modified files as source changes. `turn_end` refreshes external edits.
5. The Ralph loop observes Pi activity and pi-subagents events, waits for idle/debounce and interruption windows, reloads the session-bound active charter, then emits an action-specific continuation: author criteria, work/verify/update the next criterion, repair stale/missing pass notes, or enter report/completion. Warning events drive the widget countdown.
6. Widget registration periodically loads the bound status, builds a UI view model, and publishes it above the editor; `/charters` builds dashboard snapshots and opens the pane overlay.

## Integration Points

- Depends on `src/domain/charter-file.ts`, `src/domain/ids.ts`, and `src/domain/types.ts` for parsing, readiness, IDs, and state contracts.
- Depends on `src/infrastructure/store.ts` for locking, workspace creation, state, journal, report, and snapshot I/O.
- Uses `src/infrastructure/logger.ts` and `src/infrastructure/subagent-bridge.ts` for diagnostics and pi-subagents event names.
- Supplies status data to `src/ui/widget.ts`, `src/ui/widget-service.ts`, `src/ui/picker-snapshot.ts`, and `src/ui/charter-picker.ts`.
- Integrates with Pi `registerTool` custom `renderCall`/`renderResult` self-shell rendering, `registerCommand`, `registerMessageRenderer`, lifecycle hooks, `pi.events`, and `pi-extension-utils` widgets/pane overlay.
