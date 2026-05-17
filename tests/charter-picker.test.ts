/**
 * VAL-5 verifier: `CharterPickerComponent` is a pi-tui Component that
 * renders a master-detail picker overlay. Tests pin:
 *  - construction defaults (cursor on row 0; reconcileSelection),
 *  - render(width) shape (left + right panes joined by `│` dividers),
 *  - j/k navigation (clamps at bounds, no wrap),
 *  - enter -> onDone(cursor charter id),
 *  - q/esc -> onDone(null),
 *  - empty active list -> "No active charters." message,
 *  - every render line fits the requested width.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CharterListEntry } from "../src/application/service";
import type { CharterStatus } from "../src/domain/types";
import { CharterPickerComponent } from "../src/ui/charter-picker";
import type { CharterWidgetVM } from "../src/ui/widget-state";

// Identity theme so assertions can pin glyphs/structure without ANSI noise.
const theme = { fg: (_color: string, text: string) => text };

function entry(id: string, overrides: Partial<CharterListEntry> = {}): CharterListEntry {
  return {
    charterId: id,
    name: id,
    objective: `${id} objective`,
    status: "active" as CharterStatus,
    createdAt: "2026-05-15T10:00:00Z",
    passCount: 0,
    totalCount: 0,
    ...overrides,
  };
}

function snapshot(id: string, overrides: Partial<CharterWidgetVM> = {}): CharterWidgetVM {
  return {
    charterId: id,
    displayName: id,
    status: "active" as CharterStatus,
    isTerminal: false,
    isPlanning: false,
    elapsedMs: 0,
    bar: { pass: 0, running: 0, total: 0 },
    rows: [],
    overflow: { hidden: 0, done: 0 },
    featureRows: [],
    readyNext: [],
    ...overrides,
  };
}

function makePicker(opts: {
  charters: CharterListEntry[];
  initialSelectedCharterId?: string;
  snapshots?: Map<string, CharterWidgetVM>;
}): { picker: CharterPickerComponent; doneCalls: Array<string | null> } {
  const doneCalls: Array<string | null> = [];
  const snapshots = opts.snapshots ?? new Map(opts.charters.map((c) => [c.charterId, snapshot(c.charterId)]));
  const picker = new CharterPickerComponent({
    charters: opts.charters,
    snapshots,
    theme,
    ...(opts.initialSelectedCharterId !== undefined ? { initialSelectedCharterId: opts.initialSelectedCharterId } : {}),
    onDone: (id) => doneCalls.push(id),
  });
  return { picker, doneCalls };
}

describe("VAL-5: CharterPickerComponent", () => {
  test("constructs with cursor on first charter; render(80) shows both panes joined by │ dividers", () => {
    const charters = [entry("alpha"), entry("beta"), entry("gamma")];
    const { picker } = makePicker({ charters, initialSelectedCharterId: "beta" });
    expect(picker.getCursorIndex()).toBe(0);
    const lines = picker.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
    // Top + bottom borders carry the box corners with a tee marking the divider.
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]).toContain("┬");
    expect(lines[0]?.endsWith("╮")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.at(-1)).toContain("┴");
    expect(lines.at(-1)?.endsWith("╯")).toBe(true);
    // Every body row starts/ends with the picker's outer `│` and carries the
    // pane splitter `│` in the middle. The right pane embeds the nested
    // single-charter widget (which has its own `│` borders), so the total
    // count is >=3 rather than exactly 3.
    const bodyRows = lines.slice(1, -1);
    expect(bodyRows.length).toBeGreaterThan(0);
    for (const row of bodyRows) {
      expect(row.startsWith("│")).toBe(true);
      expect(row.endsWith("│")).toBe(true);
      expect(row.split("│").length - 1).toBeGreaterThanOrEqual(3);
    }
    // The left pane must mention every charter name; cursor + selected markers visible.
    const leftBlob = bodyRows.join("\n");
    expect(leftBlob).toContain("alpha");
    expect(leftBlob).toContain("beta");
    expect(leftBlob).toContain("gamma");
    // Cursor on row 0 (alpha) — `> ` prefix; beta carries the `*` initial-selection marker.
    expect(bodyRows[0]).toMatch(/>\s/);
    const betaRow = bodyRows.find((r) => r.includes("beta"))!;
    expect(betaRow).toContain("*");
  });

  test("j moves cursor to second charter; right pane reflects cursor (not initial selection)", () => {
    const charters = [entry("alpha"), entry("beta"), entry("gamma")];
    const snapshots = new Map<string, CharterWidgetVM>([
      ["alpha", snapshot("alpha", { displayName: "ALPHA-DETAIL" })],
      ["beta", snapshot("beta", { displayName: "BETA-DETAIL" })],
      ["gamma", snapshot("gamma", { displayName: "GAMMA-DETAIL" })],
    ]);
    const { picker } = makePicker({ charters, initialSelectedCharterId: "alpha", snapshots });
    // Before nav: right pane shows ALPHA detail.
    const before = picker.render(80).join("\n");
    expect(before).toContain("ALPHA-DETAIL");
    expect(before).not.toContain("BETA-DETAIL");
    picker.handleInput("j");
    expect(picker.getCursorIndex()).toBe(1);
    const after = picker.render(80);
    const blob = after.join("\n");
    // Cursor mark moved to row 2 (beta) — first body row no longer has `> `.
    const bodyRows = after.slice(1, -1);
    expect(bodyRows[0]).not.toMatch(/>\s/);
    expect(bodyRows[1]).toMatch(/>\s/);
    // Right pane now shows BETA detail.
    expect(blob).toContain("BETA-DETAIL");
  });

  test("k at row 0 clamps (no wrap)", () => {
    const charters = [entry("alpha"), entry("beta")];
    const { picker } = makePicker({ charters });
    expect(picker.getCursorIndex()).toBe(0);
    picker.handleInput("k");
    expect(picker.getCursorIndex()).toBe(0);
    picker.handleInput("k");
    expect(picker.getCursorIndex()).toBe(0);
  });

  test("g jumps to top; G jumps to bottom", () => {
    const charters = [entry("a"), entry("b"), entry("c")];
    const { picker } = makePicker({ charters });
    picker.handleInput("j");
    picker.handleInput("j");
    expect(picker.getCursorIndex()).toBe(2);
    picker.handleInput("g");
    expect(picker.getCursorIndex()).toBe(0);
    picker.handleInput("G");
    expect(picker.getCursorIndex()).toBe(2);
  });

  test("enter fires onDone(cursor charter id)", () => {
    const charters = [entry("alpha"), entry("beta")];
    const { picker, doneCalls } = makePicker({ charters });
    picker.handleInput("j");
    picker.handleInput("\r");
    expect(doneCalls).toEqual(["beta"]);
  });

  test("q fires onDone(null)", () => {
    const charters = [entry("alpha"), entry("beta")];
    const { picker, doneCalls } = makePicker({ charters });
    picker.handleInput("q");
    expect(doneCalls).toEqual([null]);
  });

  test("esc fires onDone(null)", () => {
    const charters = [entry("alpha")];
    const { picker, doneCalls } = makePicker({ charters });
    picker.handleInput("\x1b");
    expect(doneCalls).toEqual([null]);
  });

  test("subsequent input after done is ignored (no double-fire)", () => {
    const charters = [entry("alpha")];
    const { picker, doneCalls } = makePicker({ charters });
    picker.handleInput("\r");
    picker.handleInput("q");
    picker.handleInput("\r");
    expect(doneCalls).toEqual(["alpha"]);
  });

  test("render(40) produces output where every line fits within 40 cols", () => {
    const charters = [entry("alpha"), entry("beta"), entry("gamma")];
    const { picker } = makePicker({ charters });
    const lines = picker.render(40);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("empty charters renders 'No active charters.'", () => {
    const { picker, doneCalls } = makePicker({ charters: [] });
    const lines = picker.render(40);
    expect(lines.join("\n")).toContain("No active charters.");
    // Both enter and esc resolve to null in empty state.
    picker.handleInput("\r");
    expect(doneCalls).toEqual([null]);
    // After fire, further input is ignored (single onDone).
    picker.handleInput("\x1b");
    expect(doneCalls).toEqual([null]);
  });

  test("empty charters: esc still fires onDone(null)", () => {
    const { picker, doneCalls } = makePicker({ charters: [] });
    picker.handleInput("\x1b");
    expect(doneCalls).toEqual([null]);
  });

  test("invalidate() is a no-op", () => {
    const charters = [entry("alpha")];
    const { picker } = makePicker({ charters });
    expect(() => picker.invalidate()).not.toThrow();
    // State preserved after invalidate.
    expect(picker.getCursorIndex()).toBe(0);
  });
});
