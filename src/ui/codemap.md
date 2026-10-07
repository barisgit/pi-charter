# src/ui/

## Responsibility

Implements read-only terminal presentation for charter status: the `/charters` dashboard, picker snapshots, compact widget view models, and above-editor rendering. Legacy charters remain visible but clearly read-only.

## Design patterns

- **MVVM/projection:** `picker-snapshot.ts` loads dashboard data; `widget.ts` projects the bound `CharterStatusResult` into a small widget view; renderers consume those view models.
- **Adapter:** `charter-picker.ts` adapts rows to `pi-extension-utils.paneOverlay`, Pi Markdown/theme APIs, clipboard commands, and platform directory-open commands.
- **Module-scoped selection:** `charter-selection.ts` holds selection and its refresh callback.
- **Centralized layout constants:** `charter-picker-constants.ts` owns pane constraints, row widths, key filtering, and flash duration.

## Data and control flow

1. `/charters` lists active and recent terminal charters, including `file-interface` history, and builds a snapshot for each.
2. Picker details render Objective, References, Scope, remaining authored notes as Markdown (historical phase text included verbatim), guard state, warnings, any existing REPORT.md, and legacy charters as whole read-only files.
3. `buildCharterWidgetView()` reduces the session-bound status (always active or paused; terminal and legacy charters are never bound) to name, lifecycle, guard warning/pause, and whole countdown seconds.
4. `renderCharterWidget()` emits one line, such as `charter ship-runtime · active · Ralph continues in 7s`. Narrow widths shorten, then drop, the name before the status. The Objective and notes stay in the dashboard.
5. Registration republishes only when the serialized view changes, removes the widget when the binding ends, and resets per session.

## Integration points

- Reads `CharterStatusResult` from `src/application/service.ts` and state/events/report paths from `src/infrastructure/store.ts`.
- Uses `src/domain/types.ts` for lifecycle and guard types.
- `src/application/registration.ts` opens the picker and publishes the widget.
- Integrates with Pi TUI/coding-agent contracts and `pi-extension-utils` overlays/widgets.
