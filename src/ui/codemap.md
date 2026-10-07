# src/ui/

## Responsibility

Implements read-only terminal presentation for charter status: the `/charters` dashboard, picker snapshots, compact widget view models, and above-editor rendering. Legacy charters remain visible but clearly read-only.

## Design patterns

- **MVVM/projection:** `picker-snapshot.ts` and `widget-service.ts` load status/storage data; `widget-state.ts` is a pure reducer; renderers consume those view models.
- **Adapter:** `charter-picker.ts` adapts rows to `pi-extension-utils.paneOverlay`, Pi Markdown/theme APIs, clipboard commands, and platform directory-open commands.
- **Module-scoped selection:** `charter-selection.ts` holds selection and its refresh callback.
- **Centralized layout constants:** `charter-picker-constants.ts` owns pane constraints, row widths, key filtering, and flash duration.

## Data and control flow

1. `/charters` lists active and recent terminal charters, including `file-interface` history, and builds a snapshot for each.
2. Picker details render Objective, References, Scope, remaining authored notes as Markdown (historical phase text included verbatim), guard state, warnings, any existing REPORT.md, and legacy charters as whole read-only files.
3. Widget loading combines status with persisted dates and sends lifecycle, legacy state, and Ralph guard state to `buildViewModel()`.
4. `buildViewModel()` derives display name, terminal state, elapsed time, and guard warning/pause state.
5. `renderCharterWidget()` emits a compact short-name and lifecycle header plus legacy, guard, and Ralph countdown lines. The Objective and notes stay in the dashboard.
6. `charterWidgetDisplayKey()` reduces a view model to what the widget shows (elapsed and countdown at displayed granularity); registration republishes or removes the widget only when that key changes, and resets it per session.

## Integration points

- Reads `CharterStatusResult` from `src/application/service.ts` and state/events/report paths from `src/infrastructure/store.ts`.
- Uses `src/domain/types.ts` for lifecycle and guard types.
- `src/application/registration.ts` opens the picker and publishes the widget.
- Integrates with Pi TUI/coding-agent contracts and `pi-extension-utils` overlays/widgets.
