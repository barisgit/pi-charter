# src/ui/

## Responsibility

Implements read-only terminal presentation for charter status: a two-pane `/charters` dashboard, session selection refresh plumbing, picker snapshots, compact widget view models, and above-editor rendering.

## Design Patterns

- **MVVM/projection:** `picker-snapshot.ts` and `widget-service.ts` load application/storage data; `widget-state.ts` is a pure reducer; `charter-picker.ts` and `widget.ts` render the resulting models.
- **Adapter:** `charter-picker.ts` adapts charter rows to `pi-extension-utils.paneOverlay`, Pi markdown/theme APIs, clipboard commands, and platform directory-open commands.
- **Module-scoped session store:** `charter-selection.ts` holds tri-state selection (`unset`, explicit clear, explicit charter) plus a registered refresh callback.
- **Stateful widget host:** `CharterWidget` retains the current view model, renderer registration, and animation/elapsed timers; registration code may alternatively render the same pure functions through utility widgets.
- **Centralized layout constants:** `charter-picker-constants.ts` owns pane constraints, row widths, key filtering, and flash duration.

## Data and Control Flow

1. `/charters` asks `listAllCharters()` for non-terminal charters followed by at most ten recent terminal charters, then builds a `PickerSnapshot` for each from application status, state, events, and optional `REPORT.md`.
2. `createCharterPickerOverlay()` transforms rows into pane-overlay primary/detail callbacks. Keyboard actions fold detail sections, open the selected charter directory, or copy its ID; the dashboard does not mutate charter lifecycle state.
3. Picker details render objective, references, scope, completion blockers, criteria, and report markdown. Criterion heads align with the detail column while bodies and notes use only a subordinate two-space inset; recent Status transitions pair value/note journal events by criterion and sequence so history never borrows the current note.
4. Widget refresh calls `loadCharterWidgetStatus()` or `loadCharterSnapshot()`, joins service status with persisted dates, and passes criteria to `buildViewModel()`.
5. `buildViewModel()` counts passed versus active/blocked/failed criteria, prioritizes the next non-pass criterion, and derives terminal/elapsed state. `renderCharterWidget()` emits width-bounded header, progress bar, next criterion, Ralph countdown, and footer lines.
6. Selection mutations call `requestSelectionRefresh()` so a registered host can repaint immediately; session shutdown resets shared selection/refresh state.

## Integration Points

- Reads `CharterStatusResult` from `src/application/service.ts` and charter rows/state/events/report paths from `src/infrastructure/store.ts`.
- Uses `src/domain/types.ts` and `src/domain/charter-file.ts` for lifecycle and criterion status types.
- Consumed by `src/application/registration.ts`, which opens the picker and publishes the above-editor widget.
- Integrates with `@earendil-works/pi-tui` for styled width-aware rendering, `@earendil-works/pi-coding-agent` for themes/context, and `pi-extension-utils` for pane overlays and widgets.
- Directory opening uses the platform command (`open`, `start`, or `xdg-open`); clipboard copying uses the corresponding platform command when no host hook is supplied.
