# paneOverlay gap analysis — pi-charter as case study

Status: feedback note for [barisgit/pi-extension-utils](https://github.com/barisgit/pi-extension-utils) (analyzed against installed `0.3.2`).

pi-charter's `CharterPickerComponent` (`src/ui/charter-picker.ts`, ~830 lines) is a master/detail
fullscreen overlay. The utils `paneOverlay()` helper already covers most of its mechanics, but a
full migration is currently blocked by the gaps below. This catalogs what `paneOverlay` **cannot
yet express**, what it **already covers** (so we don't re-request it), and concrete API proposals.

The picker already consumes the utils low-level pane primitives (`computeSplitPaneLayout`,
`resizeSplitPane`, `computeFixedSidebarLayout`, `dispatchNavKeys`, cursor/scroll state helpers,
`boxRow`/`titledTopSegment`/`flatRule`/`renderKeyRow`). The gaps are all in the **opinionated
`paneOverlay` wrapper**, not the primitives.

## Confirmed gaps (ranked by migration-blocking weight)

### G1 — Primary pane has no middle "info" zone (only list + optional legend)
The picker's left pane stacks **three** sections separated by `flatRule` dividers:
`list (flex)` / `info (3–14 rows)` / `legend (fixed)`. `paneOverlay` supports at most two:
the primary list plus an optional legend (`legendPlacement: "primary"`, rendered after
`primaryHeight` via a single `flatRule`; see `overlay.js` body loop). There is no slot for a
content zone *between* the list and the legend.

The picker's info zone shows the selected charter's name, status badge, pass counter, timestamps,
and a wrapped objective preview — i.e. selection-derived detail that intentionally lives on the
*left*, not in the detail pane.

Proposal: allow the primary pane to declare an optional `info`/`belowList` region:
`primary.info?: (ctx) => string[]` with its own divider label, sized between list and legend.

### G2 — `renderRow` receives no pane width (blocks width-adaptive rows)
Type: `renderRow?(row: Row, ctx: PaneOverlayContext): string`. `ctx` exposes cursor/scroll/
selection but **not the primary pane's current width**. The picker's `leftRow()` does responsive
column dropping based on width: full `prefix + name + progressBar + count + status`, degrading to
`name + count + status`, then `name + count` as width shrinks. Without the width, rows can't adapt
(and the split is user-resizable via `[`/`]`, so width is dynamic).

Proposal: pass width to the row renderer — `renderRow?(row, ctx, width: number): string` — or add
`ctx.primary.width` / `ctx.detail.width`.

### G3 — No non-selectable separator/group rows in the list
The picker inserts a `flatRule("done")` divider **inside** the list to split non-terminal from
terminal charters. `paneOverlay` renders `primary.rows` as a flat, uniformly selectable list; a
sentinel row would still be cursorable and selection-keyed.

Proposal: support a row-kind discriminator (e.g. rows may return `{ kind: "separator", label }`)
that renders a `flatRule` and is skipped by cursor movement, or a `primary.groupBy`/`sections`
option.

### G4 — Pane titles are label-only (no colored, multi-segment tail)
In `overlay.js`, both titles call `titledTopSegment` with **only** `label`/`labelColor`/`labelBold`
— no `tail`. The picker's detail title carries a right-aligned tail with three independently
colored segments (status badge, `passCount/totalCount VAL`, elapsed) via the
`tailRendered`/`tailPlain` pair that `titledTopSegment` already supports. `paneOverlay` discards
that capability.

Proposal: accept `title` as either a string or a structured `{ label, tail?, tailRendered?,
tailPlain?, labelColor?, tailColor? }`, forwarded to `titledTopSegment`.

### G5 — No initial cursor / initial selection key
`PaneOverlayOptions` has no `initialIndex` / `initialSelectionKey`. The picker opens with the
cursor on the currently bound charter (`initialCursorCharterId`). With `paneOverlay` the cursor
always starts at 0.

Proposal: add `primary.initialSelectionKey?: string` (preferred — stable across row reordering) or
`primary.initialIndex?: number`.

### G6 — No per-render lifecycle hook for transient UI (flash messages)
The picker shows ephemeral in-pane feedback for `O`/`y` actions (open dir / copy id): it sets a
`flashMessage` with a `rendersLeft` TTL and decrements it **inside `render()`**, so the message
self-expires after N frames and temporarily takes over the info zone. `paneOverlay`'s render is
effectively pure (no caller hook runs per frame), and `customActions.run` can mutate external state
but nothing expires it. There's also no built-in transient/toast surface.

Proposal: either a built-in transient message API (`ctx.flash(text, { kind, ttl })` rendered in a
reserved line), or an `onRender(ctx)` hook so consumers can tick their own timers.

## Already expressible — not gaps (do not re-request)

- **Split + resize** (`[`/`]`), min/max widths, `fractionBasis: "interior"` — `split` option.
- **Sidebar collapse to detail-only** — `collapse` option renders `primaryWidth=0` (detail-only,
  forces detail focus), matching the picker's `s` toggle and single-box render path.
- **Two independent detail expand toggles** (`space` = expand all criteria, `o` = expand
  objective) — `customActions` mutating external booleans that `detail.rows(ctx)` reads.
- **Open dir / copy id / notify host hooks** (`O`/`y`) — `customActions.run(ctx)` calling app code;
  `ctx.selectedRow`/`selectedKey` give the target. (Only the *flash display* is a gap — see G6.)
- **Cursor vs scroll modes**, half-page (`u`/`d`), `g`/`G`, focus toggle, banned keys — covered by
  `primary.mode`, standard keys, `bannedKeys`.
- **Footers** (cursor position left, hint + scroll position right) — `primary.footer`/`detail.footer`
  as string or `(ctx) => string`; defaults already emit `cursor+1/total` and `formatScrollInfo`.
- **Per-selection detail scroll reset / sticky** — `perSelectionScroll`, `stickyBottom`.
- **Dynamic height** — `height?: number | ((tui) => number)`.
- **Legend** — `legendPlacement: "primary" | "footer"` + `customActions` auto-listed.

## Recommendation

Do **not** migrate the picker to `paneOverlay` yet. G1 (three-zone left pane), G2 (row width), and
G4 (colored title tails) are load-bearing for the current UX and have no workaround. G3/G5/G6 are
smaller but still visible regressions. Track these upstream; revisit once G1+G2+G4 land. The
low-level primitives the picker already shares with utils remain the right level of reuse in the
meantime.
