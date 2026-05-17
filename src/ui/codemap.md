# `src/ui/` — Codemap

## File Inventory

| File | Role |
|---|---|
| `widget-state.ts` | Pure view-model reducer: disk inputs → `CharterWidgetVM` |
| `widget-service.ts` | I/O bridge: disk reads → reducer input → `loadCharterSnapshot()` |
| `widget.ts` | Stateful host (`CharterWidget`) + pure render functions |
| `multi-charter-widget.ts` | Pure renderer for the multi-charter list widget |
| `charter-picker.ts` | Master-detail overlay (`CharterPickerComponent` implements `pi-tui Component`) |
| `charter-selection.ts` | Module-level session singleton for active-charter selection |

---

## Responsibility Map

### `widget-state.ts`

**Responsibility:** Stateless reducer. Transforms a fully-resolved `ReducerInput` into a `CharterWidgetVM`. No I/O, no UI imports, no timers, no globals.

**Public API:**
- `buildViewModel(input: ReducerInput): CharterWidgetVM` — single-charter VM.
- `buildMultiCharterViewModel(input: MultiReducerInput): MultiCharterWidgetVM` — multi-charter VM projection.
- `RunningSubagentRegistry` class — in-memory tracker for in-flight subagents, keyed by `runId`. Persists for process lifetime; seeded by async-bridge events.
- Type exports: `CharterWidgetVM`, `FeatureRowVM`, `FeatureSummaryVM`, `MultiCharterWidgetVM`, `PerCharterRowVM`, `PlanningVM`, `PlanningStep`, `ValState`, `ReducerInput`, `RunningSubagent`, `MultiReducerInput`, `CharterSnapshotLike`.

**Key logic:**
- VAL bar counters: `pass` = `outcome === "pass"` in `criterion-state.json`; `running` = any criterion with a live verifier subagent **or** belonging to a feature with `feature-state.status === in_progress` or a live subagent.
- Feature bucket order: `running_` → `idle_ready` → `idle_blocked`, within each bucket ordered by plan declaration order.
- `running_` rows sorted by `elapsedMs` descending (oldest-started first).
- Feature completion: `feature-state.status` is authoritative OR derives from all fulfilled VALs having `outcome === "pass"` (lag-tolerant fallback).
- Precondition resolution: empty `preconditions[]` means always ready.
- Planning VM: derived entirely from already-loaded `criteria` + `features` arrays; no extra I/O.

**Constants:** `MAX_ROWS = 6` (visible slots; last slot reserved for overflow line), `MAX_MULTI_ROWS = 5` (visible charters before overflow).

---

### `widget-service.ts`

**Responsibility:** I/O orchestrator. Reads all per-charter sources from disk, assembles a `ReducerInput`, and calls `buildViewModel`. Also owns `RunningSubagentRegistry` singleton for in-process subagent tracking.

**Public API:**
- `loadCharterSnapshot(input: SnapshotInput): Promise<CharterWidgetVM>` — async; reads `charter.md`, all `.md` files under `plan/`, `criterion-state.json`, `feature-state.json` in parallel via `Promise.all`.
- `RunningSubagentRegistry` class — same class re-exported; instance is the process-global registry.

**Disk read paths (all under `charterDir(projectDir, charterId)`):**
| File | Parser | Field in ReducerInput |
|---|---|---|
| `charter.md` | `parseCharterMarkdown` | `criteria` |
| `plan/*.md` | `parseFeatureMarkdown` | `features` (sorted by `order`, then `id`) |
| `criterion-state.json` | `JSON.parse` | `criterionOutcomes: Record<string, { outcome?: string }>` |
| `feature-state.json` | `JSON.parse` | `featureStates: Record<string, { status?: string }>` |
| `state.json` | `loadCharterState` (infrastructure) | `name`, `status`, `createdAt` |

**`RunningSubagentRegistry`:** Keyed by `runId`. `start()` / `complete()` called by async-bridge events. `forCharter(charterId)` returns all running agents for a given charter. `charterId` sourced from `PI_CHARTER.metadata.charterId` stamped by subagent-bridge.

---

### `widget.ts`

**Responsibility:** Stateful host (`CharterWidget`) + all pure render functions. The host owns the `setWidget` registration, animation timers, and the latest `CharterWidgetVM`. Render functions are pure string composition.

**Public API:**
- `CharterWidget` class: `setUi(ui)`, `update(vm)`, `dispose()`.
- `renderCharterWidget(opts: RenderOptions): string[]` — top-level pure renderer. Delegates to `renderTerminalView`, `renderPlanningView`, or active-view sub-renderers.
- `formatElapsed(ms): string` — duration formatter.
- Constants: `BOX_KEY = "pi-charter"`, `MIN_TERMINAL_WIDTH = 60`, `SPINNER_TICK_MS = 120`, `ELAPSED_TICK_MS = 5_000`, `BAR_GLYPHS / BEAD_GLYPHS`.

**`CharterWidget` state machine:**

```
constructor: ui = undefined
  setUi(ui):
    → ui is stored; caller wires setWidget factory
  update(vm):
    → vm stored
    → if vm has running rows: ensureSpinnerTimer() (120ms interval → requestRender)
    → else: stopSpinnerTimer()
    → ensureElapsedTimer() (5s interval → requestRender)
    → if not registered: ui.setWidget(BOX_KEY, factory, { placement: "aboveEditor" })
    → else: tui.requestRender()
  dispose():
    → stopSpinnerTimer(), stopElapsedTimer()
    → ui.setWidget(BOX_KEY, undefined)  ← clears the slot
    → registered = false, vm = undefined
```

**Render paths (pure):**

1. **Terminal** (`isTerminal === true`): `renderHeader` + `renderBarLine` + `renderFooter`. No feature rows.
2. **Planning** (`isPlanning === true`): `renderPlanningView` → header + 5-step pipeline (`renderPlanningStep`) + next-hint line (`renderPlanningNext`) + footer.
3. **Active** (neither terminal nor planning): header + bar + feature rows + overflow line + footer.

**Glypyh/color vocabulary:**

| Element | pass | running | pending / dim |
|---|---|---|---|
| VAL bar | `█` success | `▓` accent | `░` dim |
| VAL bead | `▰` success | `▰` accent | `▱` dim |
| Feature row glyph | — | spinner (11-frame `✳→✽`) or `●` accent | `○` dim |
| Planning step glyph | `✔` success | `◐` accent | `○` dim |

**Bead budget logic:**
- If `budget >= n`: one glyph per VAL (full resolution).
- If `budget < BEAD_MIN_BUDGET (4)`: compressed to `passCount/n` text fallback.
- Else: bucket `ceil(n/budget)` VALs per bead; worst-state-wins per bucket.

---

### `multi-charter-widget.ts`

**Responsibility:** Pure renderer for the multi-charter list widget (`charter-multi` in the pi-tui widget slot). One row per `PerCharterRowVM`. No I/O, no globals.

**Public API:**
- `renderMultiCharterWidget(vm: MultiCharterWidgetVM, theme, width): string[]` — empty VM returns `[]` (host clears the slot).

**Row composition per `PerCharterRowVM`:**
```
<sel-mark><dot> <displayName>  <status>  <pass>/<total>  <bar>
```
- `sel-mark`: `*` accent if selected, ` ` otherwise.
- `dot`: `●` accent if `hasLiveSubagent`, `○` dim otherwise.
- Status color: `completed → success`, `abandoned → error`, `paused|budget_limited|planning → warning`, else `accent`.

**Bar segments:** proportional allocation (same `barSegments` algorithm as `widget.ts`). Overflow row: `+N more` when `vm.hiddenCount > 0`. `MIN_WIDTH = 20`.

---

### `charter-picker.ts`

**Responsibility:** Master-detail overlay picker for switching the active charter. Implements `pi-tui Component` (`render(width): string[]`, `handleInput(data)`). Cursor navigation with `j/k/g/G/enter/esc/q`. Left pane is charter list; right pane is the `renderCharterWidget` detail view at the current charter.

**Public API:**
- `CharterPickerComponent` class: `render(width)`, `handleInput(data)`, `invalidate()`, `getCursorIndex()`.
- `CharterPickerOptions` interface.

**Layout:** `│<left cell>│<right cell>│`, box borders use `╭╮╰╯─┬┴`. Left pane: ~35% of width, capped `[20, 50]` cols. Right pane: remainder minus 3 border cols. Each `bodyRow` calls `padRight` on both cells.

**Pane contents:**
- Left: `<cursor 2><selected 1><space 1><name…><frac>`. Cursor = `> ` accent. Selected = `*` accent.
- Right: `renderCharterWidget({ width, theme, vm })` — the full single-charter widget rendered into the right cell. Enforces `MIN_TERMINAL_WIDTH = 60` internally; clips on overflow.

**Input handling:**
| Key(s) | Action |
|---|---|
| `j`, `down` | `cursor++` (clamped) |
| `k`, `up` | `cursor--` (clamped) |
| `g` | cursor = 0 |
| `shift+g` | cursor = last |
| `enter`, `return` | `fire(entry?.charterId ?? null)` |
| `escape`, `ctrl+c`, `q` | `fire(null)` |

**Empty state:** renders a single-line `No active charters.` box and treats both `enter` and `esc` as `fire(null)`.

---

### `charter-selection.ts`

**Responsibility:** Session-scoped tri-value selection state shared between the widget host (which draws the charter detail) and the `/charters` slash command verbs (which mutate selection). Module-level singleton with explicit reset for test isolation.

**Public API:**
- `getCharterSelection(): CharterSelection`
- `setCharterSelection(next: CharterSelection): void`
- `resetCharterSelection(): void` — resets to `{ kind: "unset" }`. Called on `session_shutdown` and by tests.
- `registerSelectionRefresher(fn: RefreshFn): void` — widget host calls this at registration time.
- `requestSelectionRefresh(ctx: SelectionRefreshCtx): Promise<void>` — command verbs call this after mutating selection; triggers immediate widget rebuild.

**`CharterSelection` union:**
```typescript
| { kind: "unset" }           // no charter selected yet
| { kind: "explicit-clear" } // user explicitly cleared selection
| { kind: "explicit"; charterId: string }
```

**Refresher lifecycle:** Registered once by `registerCharterWidget` at session start; cleared via `clearSelectionRefresher()` (called by widget dispose or session shutdown). Commands call `requestSelectionRefresh(ctx)` synchronously after `setCharterSelection(...)`, so the widget rebuilds before the next turn renders.

---

## Data Flow

```
┌─ disk ─────────────────────────────────────────────────────────┐
│  .pi/charters/<id>/
│    state.json         loadCharterState()
│    charter.md         parseCharterMarkdown() → criteria[]
│    plan/*.md          parseFeatureMarkdown() → features[]
│    criterion-state.json  → criterionOutcomes{}
│    feature-state.json    → featureStates{}
└────────────────────────────────────────────────────────────────┘
                          │
                    loadCharterSnapshot()
                          │
                          ▼
              ┌───────────────────────────┐
              │   ReducerInput            │  widget-state.ts
              │   (all sources resolved)  │
              └────────────┬──────────────┘
                           │ buildViewModel()
                           ▼
              ┌───────────────────────────┐
              │   CharterWidgetVM         │
              │   CharterSnapshotLike     │
              └────────────┬──────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
   renderCharterWidget  buildMultiCharter  (used by
   (widget.ts)          ViewModel         charter-picker
                        (widget-state.ts)  right pane)
           │               │               │
           ▼               ▼               ▼
   CharterWidget host   renderMultiCharter  renderCharterWidget
   (setWidget aboveEditor) Widget()        (same pure fn)
           │               │               │
           └───────────────┼───────────────┘
                           │
                           ▼
              ┌───────────────────────────┐
              │  pi-tui setWidget slot    │
              │  "pi-charter" / "charter-multi"
              └───────────────────────────┘

┌─ async-bridge events ──────────────────────────────────────────┐
│  subagent:async-started    → RunningSubagentRegistry.start()
│  subagent:async-complete  → RunningSubagentRegistry.complete()
└─────────────────────────────────────────────────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   loadCharterSnapshot() ←──── (called on events that change charter state,
   input.runningSubagents              evidence, plan, or subagent lifecycle)
```

---

## Control Flow

1. **Session start:** `registerCharterWidget` calls `setUi(ui)`, registers the widget factory via `ui.setWidget(BOX_KEY, ...)`, and calls `registerSelectionRefresher(fn)`.
2. **Relevant event fires** (charter state change, evidence, plan lock, subagent start/complete): `loadCharterSnapshot()` is called, producing a fresh `CharterWidgetVM`. `CharterWidget.update(vm)` is called → stored → if `hasRunning`, spinner timer started → `tui.requestRender()`.
3. **Timer tick:** `requestRender()` re-enters `renderCharterWidget` with incremented frame counter (spinner advance) or new elapsed time.
4. **User opens picker:** `CharterPickerComponent` is instantiated and passed to pi-tui as the active component. On `enter`, `fire(charterId)` is called → `setCharterSelection({ kind: "explicit", charterId })` → `requestSelectionRefresh(ctx)` → widget host rebuilds and renders the newly selected charter. On `esc`, `fire(null)` → `setCharterSelection({ kind: "explicit-clear" })`.
5. **Session end:** `dispose()` clears the widget slot and timers; `resetCharterSelection()` resets the module singleton.

---

## Integration Points

| Integration | Counterpart | Protocol |
|---|---|---|
| pi-tui `Component` contract | `charter-picker.ts` | `render(width: number): string[]`, `handleInput(data: string): void`, `invalidate(): void` |
| pi-tui `setWidget` | `widget.ts` `CharterWidget` | `setWidget(key, factory, { placement: "aboveEditor" })`, `setWidget(key, undefined)` |
| pi-tui `requestRender` | `CharterWidget` | Called on every timer tick and on `update(vm)` |
| pi-tui theme | All render files | `ThemeLike` interface: `fg(color, text): string` |
| `CharterListEntry` | `application/service` | `{ charterId, name, passCount, totalCount }` |
| `RunningSubagentRegistry` | Async-bridge | Events: `subagent:async-started`, `subagent:async-complete` |
| `registerCharterCommands` | `charter-selection.ts` | `setCharterSelection()`, `requestSelectionRefresh(ctx)` |
| `registerCharterWidget` | `charter-selection.ts` | `registerSelectionRefresher(fn)`, `clearSelectionRefresher()` |
| `loadCharterState` | `infrastructure/store` | Reads `state.json` from charter dir |
| `charterDir` | `infrastructure/store` | Resolves `projectDir + charterId` → disk path |
| `parseCharterMarkdown` | `domain/charter-md` | Returns `{ criteria: CharterCriterion[] }` |
| `parseFeatureMarkdown` | `domain/feature-md` | Returns `FeatureDefinition` |
| `CharterStatus`, `CharterCriterion` types | `domain/types` | Status union, criterion shape |

---

## Design Patterns

- **Reducer (widget-state.ts):** Pure function `buildViewModel(ReducerInput) → CharterWidgetVM`. All branching logic (terminal / planning / active) lives here; renderer is purely compositional.
- **Registry / singleton (widget-service.ts `RunningSubagentRegistry`):** Process-lifetime Map. Not persisted; seeded by async-bridge events. Enables in-flight attribution without disk lag.
- **Stateful host (widget.ts `CharterWidget`):** Owns timers, UI registration, and latest VM. Separates host concerns from render concerns.
- **Module-level store (charter-selection.ts):** Simple `let current: CharterSelection` singleton at module scope. Explicitly reset for test isolation. Enables cross-cutting read/write between command surface and widget without a shared service instance.
- **Pi-tui `Component` (charter-picker.ts):** Lifts the picker into the pi-tui event loop. Cursor is internal state; `fire()` calls the injected `onDone` callback to return control to the caller.
- **Bead compression:** `renderBeads()` dynamically chooses full-resolution vs. bucketed vs. text-fallback based on available cell budget — adapts to narrow terminal widths.
- **Lag-tolerant completion:** Feature and VAL completion is derived from `criterionOutcomes` in addition to explicit `feature-state.json` status, so the widget remains accurate when the sidecar projection lags behind a multi-criterion handoff.
