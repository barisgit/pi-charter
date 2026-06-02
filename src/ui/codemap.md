# src/ui/

## Responsibility

`src/ui/` owns the terminal UI projection for v3 charters:

- the compact above-editor progress widget (`widget-state.ts`, `widget-service.ts`, `widget.ts`),
- the interactive `/charters` picker (`charter-picker.ts`, `picker-snapshot.ts`, `charter-picker-constants.ts`), and
- session-local charter selection shared by commands and widget refresh (`charter-selection.ts`).

The live model is Objective → Milestone → VAL. Current UI state is derived from `state.json`, parsed `charter.md` / optional `criteria.md`, `criterion-state.json`, in-memory running-subagent metadata, and evidence files under `work/*/evidence/`. There is no live feature DAG reader and no live `feature-state.json` sidecar in this folder.

## Design

- `widget-state.ts` is a pure reducer. `buildViewModel(input)` consumes `ReducerInput` and returns `CharterWidgetVM`; it explicitly has no I/O, timers, UI imports, feature DAG, or feature-state sidecar. Pass count comes from criterion outcomes; running count comes only from running subagents with `criterionId`; `isPlanning` is always `false`.
- `widget-service.ts` is the widget I/O bridge. `loadCharterSnapshot()` reads `state.json` via `loadCharterState`, parsed charter criteria via `loadParsedCharter`, and `criterion-state.json` directly, then calls `buildViewModel()`. `RunningSubagentRegistry` is an exported in-memory `Map` keyed by runId and seeded by async-bridge-style start/complete calls.
- `widget.ts` hosts the above-editor widget under `BOX_KEY = "pi-charter"`. Rendering is pure string composition from a `CharterWidgetVM`; active and terminal views show a header, VAL progress bar, and footer/empty spacer. The host owns `setWidget(..., { placement: "aboveEditor" })`, spinner timer while `bar.running > 0`, elapsed timer, and disposal.
- `picker-snapshot.ts` is the picker data layer. It enumerates `.pi/charters/`, loads per-charter state, parsed charter/criteria markdown, criterion state, completion blockers from application service helpers, and recent typed evidence JSON. It builds `PlanMilestoneNode[]` from parsed milestones; each milestone is represented as one synthetic `PlanFeatureNode` for display only.
- `charter-picker.ts` is a `pi-tui` `Component` master-detail overlay. It renders a left charter list plus info/legend panes and a right detail pane with objective, completion blockers or readiness, milestone/VAL tree, and recent evidence. It owns cursor, focus, scroll, split width, sidebar collapse, objective expansion, and short-lived flash messages.
- `charter-picker-constants.ts` centralizes picker terminal status, key legend, footer text, layout bounds, split/page sizes, banned keys, flash TTL, and left-row column widths.
- `charter-selection.ts` is a module-level tri-value selection store: `{ kind: "unset" }`, `{ kind: "explicit-clear" }`, or `{ kind: "explicit", charterId }`, plus a registered refresh callback used by command code to force widget refresh after selection changes.

## Flow

1. Widget refresh code calls `loadCharterSnapshot({ projectDir, charterId, runningSubagents, now? })`.
2. `widget-service.ts` resolves `charterDir(projectDir, charterId)` and reads state, parsed criteria, and `criterion-state.json`; missing charter parse or criterion-state data degrades to empty criteria/outcomes.
3. `buildViewModel()` computes `displayName`, terminal status (`completed` / `abandoned`), elapsed time from `createdAt`, and bar counts: `pass` from `outcome === "pass"`, `running` from live subagents attached to VAL ids, `total` from parsed criteria length.
4. `CharterWidget.update(vm)` stores the VM, registers the above-editor widget factory on first update, starts/stops the spinner timer based on `bar.running`, keeps an elapsed timer alive, and requests re-render on later updates/timer ticks.
5. Picker data starts with `listAllCharters(projectDir)`, which includes active/paused and up to 10 terminal charters. Non-terminal rows sort by `createdAt` desc; terminal rows sort by `completedAt ?? terminatedAt ?? createdAt` desc.
6. For each selected/listed charter, `buildPickerSnapshot()` reads `state.json`, parsed `charter.md`, raw `charter.md` / `criteria.md` title sources, `criterion-state.json`, completion blockers, and evidence JSON under `work/<segment>/evidence/` (including nested run evidence dirs).
7. The picker derives milestone display rows from parsed milestones and criterion outcomes. A milestone display node is marked `completed` when all its VALs pass, `pending` when all outcomes are null, otherwise `in_progress`.
8. `CharterPickerComponent.handleInput()` handles navigation (`j/k`, arrows, page up/down, `g/G`), focus (`tab`), right-pane expansion (`space`, `o`), sidebar/split controls (`s`, `[`/`]`), close (`esc`, `ctrl+c`), open charter dir (`O`), and copy charter id (`y`). `enter`, delete, and printable `b/r/p/a/c` are intentionally banned/no-op.

## Integration

- `@earendil-works/pi-tui`: `CharterPickerComponent` implements `Component`; `widget.ts` uses `truncateToWidth`; picker uses `matchesKey`, `truncateToWidth`, and `visibleWidth`.
- Pi UI widget API: `CharterWidget` calls `ui.setWidget("pi-charter", factory, { placement: "aboveEditor" })`, then clears it with `setWidget("pi-charter", undefined)` on dispose.
- `../infrastructure/store`: `charterDir`, `chartersRoot`, `loadCharterState`, and `loadParsedCharter` provide disk paths and parsed charter records.
- `../application/record-service`: `loadCriterionState()` provides criterion outcomes for picker snapshots.
- `../application/service`: picker snapshots call `loadBlockingContext()` and `computeBlockingForComplete()` to display reasons a non-terminal charter cannot complete. The UI only displays this data; it does not run verification.
- `../domain/types`: `CharterStatus`, `CharterCriterion`, `CharterMilestone`, and `ParsedCharterMarkdown` define the status/VAL/milestone inputs.
- OS integration in `charter-picker.ts`: `defaultOpenPath()` legitimately spawns `open` / `explorer` / `xdg-open` detached to open the selected charter directory; `defaultCopyText()` spawns `pbcopy` / `clip` / `xclip` to copy the selected charter id. These are UI conveniences, not verification execution.
- Command/widget coupling: command code and picker selection use `charter-selection.ts`; widget registration installs a refresher with `registerSelectionRefresher()`, and commands call `requestSelectionRefresh(ctx)` after mutation.

## Vestigial / tech-debt

- `picker-snapshot.ts:6-8` has a stale header comment claiming `feature-state.json` and `plan/*.md` are gathered. The implementation reads `state.json`, parsed charter/criteria markdown, `criterion-state.json`, blockers, and evidence; no `feature-state.json` or `plan/*.md` reader exists here.
- `widget.ts:1-3` still describes a fixed-height feature list with per-feature VAL beads, but current `renderCharterWidget()` active output is only header + VAL bar + empty line + footer.
- `widget-state.ts:23-34` and `widget.ts:74-123` keep planning VM/render compatibility, but `buildViewModel()` always sets `isPlanning: false`, so normal live widget flow never enters the planning renderer.
- `widget-state.ts:56-57` and `widget-service.ts:77-83` still carry optional `featureId` metadata on running subagents, but current widget counting uses only `criterionId`.
- `widget.ts:36-38,210-245` define bead glyphs and `renderBeads()` helpers, but the current renderer does not call `renderBeads()`.
- `widget.ts:262-263`, `charter-picker.ts:735-737`, `charter-picker.ts:804-809`, and `charter-picker.ts:893-899` contain unused helper functions (`formatDuration`, `footerText`, `titledRule`, `verdictColor`).
- `picker-snapshot.ts:49-60` and `charter-picker.ts:540-549` use `PlanFeatureNode` as a display adapter for milestones, not as a live feature-DAG planning primitive.
