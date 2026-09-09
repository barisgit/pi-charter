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
2. Picker details render Objective, References, Scope, phase narrative, authored Markdown, report, warnings, and legacy read-only state.
3. Widget loading combines status with persisted dates and sends Objective, phases, report presence, legacy state, and Ralph guard state to `buildViewModel()`.
4. `buildViewModel()` derives current phase, done/total presentation, terminal state, elapsed time, and guard warning/pause state.
5. `renderCharterWidget()` emits a compact short-name, lifecycle, and current-phase display plus Ralph warning countdown. The full Objective and phase body stay in the dashboard.

## Integration points

- Reads `CharterStatusResult` from `src/application/service.ts` and state/events/report paths from `src/infrastructure/store.ts`.
- Uses `src/domain/types.ts` and `src/domain/charter-file.ts` for lifecycle and Phase types.
- `src/application/registration.ts` opens the picker and publishes the widget.
- Integrates with Pi TUI/coding-agent contracts and `pi-extension-utils` overlays/widgets.
