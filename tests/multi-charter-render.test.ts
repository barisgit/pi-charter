/**
 * VAL-4 verifier: `renderMultiCharterWidget` is a pure renderer that
 * produces a boxed multi-row widget from a `MultiCharterWidgetVM`.
 *
 * Asserts header/footer presence, one row per charter, overflow row when
 * `hiddenCount > 0`, selection + live-subagent visual distinctions, and
 * that every output line fits within the requested width at 40 / 80 / 120.
 */

import { describe, expect, test } from "bun:test";
import type { CharterStatus } from "../src/domain/types";
import {
  buildMultiCharterViewModel,
  type CharterSnapshotLike,
  type MultiReducerInput,
  type RunningSubagent,
} from "../src/ui/widget-state";
import { renderMultiCharterWidget } from "../src/ui/multi-charter-widget";
import { visibleWidth } from "@earendil-works/pi-tui";

// Identity theme — tests pin glyphs/structure, not ANSI codes.
const theme = { fg: (_color: string, text: string) => text };

function snapshot(
  id: string,
  overrides: Partial<CharterSnapshotLike> = {},
): CharterSnapshotLike {
  return {
    charterId: id,
    displayName: id,
    status: "active" as CharterStatus,
    bar: { pass: 0, running: 0, total: 0 },
    ...overrides,
  };
}

function input(overrides: Partial<MultiReducerInput> = {}): MultiReducerInput {
  return {
    snapshots: [],
    selectedCharterId: null,
    runningSubagentsByCharter: new Map(),
    ...overrides,
  };
}

function liveSub(charterId: string): RunningSubagent {
  return { runId: `run-${charterId}`, charterId, startedAt: "2026-05-15T10:00:00Z" };
}

describe("VAL-4: renderMultiCharterWidget", () => {
  test("empty VM returns [] (no header, no footer)", () => {
    const vm = buildMultiCharterViewModel(input({ snapshots: [] }));
    expect(renderMultiCharterWidget(vm, theme, 80)).toEqual([]);
  });

  test("1 charter -> header + 1 row + footer", () => {
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("alpha", { bar: { pass: 2, running: 1, total: 5 } })],
    }));
    const lines = renderMultiCharterWidget(vm, theme, 80);
    expect(lines).toHaveLength(3);
    // Header
    expect(lines[0]).toMatch(/Charters \(1 active\)/);
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]?.endsWith("╮")).toBe(true);
    // Row carries displayName, status, pass/total, and bar glyphs.
    const row = lines[1]!;
    expect(row).toMatch(/alpha/);
    expect(row).toMatch(/active/);
    expect(row).toMatch(/2\/5/);
    expect(row).toMatch(/[█▓░]/);
    // Footer
    expect(lines[2]?.startsWith("╰")).toBe(true);
    expect(lines[2]?.endsWith("╯")).toBe(true);
  });

  test("5 charters -> 5 rows (no overflow)", () => {
    const snapshots = Array.from({ length: 5 }, (_, i) => snapshot(`c${i + 1}`));
    const vm = buildMultiCharterViewModel(input({ snapshots }));
    const lines = renderMultiCharterWidget(vm, theme, 80);
    // header + 5 rows + footer
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/Charters \(5 active\)/);
    for (let i = 1; i <= 5; i++) {
      expect(lines[i]).toMatch(new RegExp(`c${i}\\b`));
    }
    // No overflow row.
    expect(lines.some((l) => /\+\d+ more/.test(l))).toBe(false);
  });

  test("7 charters -> 5 rows + '+2 more' overflow row + footer", () => {
    const snapshots = Array.from({ length: 7 }, (_, i) => snapshot(`c${i + 1}`));
    const vm = buildMultiCharterViewModel(input({ snapshots }));
    expect(vm.hiddenCount).toBe(2);
    const lines = renderMultiCharterWidget(vm, theme, 80);
    // header + 5 rows + overflow + footer = 8
    expect(lines).toHaveLength(8);
    const overflow = lines.find((l) => l.includes("+2 more"));
    expect(overflow).toBeDefined();
  });

  test("selected charter row is visually distinguished (`*` prefix)", () => {
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("aaa"), snapshot("bbb"), snapshot("ccc")],
      selectedCharterId: "bbb",
    }));
    const lines = renderMultiCharterWidget(vm, theme, 80);
    const rowB = lines.find((l) => l.includes("bbb"))!;
    const rowA = lines.find((l) => l.includes("aaa"))!;
    expect(rowB).toBeDefined();
    expect(rowA).toBeDefined();
    // Selected gets the `*` marker; non-selected does not.
    expect(rowB).toMatch(/\*/);
    expect(rowA).not.toMatch(/\*/);
  });

  test("live-subagent dot appears on the live row", () => {
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("aaa"), snapshot("bbb")],
      runningSubagentsByCharter: new Map([["aaa", [liveSub("aaa")]]]),
    }));
    const lines = renderMultiCharterWidget(vm, theme, 80);
    const rowA = lines.find((l) => l.includes("aaa"))!;
    const rowB = lines.find((l) => l.includes("bbb"))!;
    expect(rowA).toMatch(/●/);
    // Inactive row uses the hollow bullet; should not contain the filled dot.
    expect(rowB).not.toMatch(/●/);
    expect(rowB).toMatch(/○/);
  });

  test.each([40, 80, 120])("every line fits within width %d", (width) => {
    const snapshots = Array.from({ length: 7 }, (_, i) =>
      snapshot(`charter-${i + 1}`, { bar: { pass: i, running: 1, total: 7 } }),
    );
    const vm = buildMultiCharterViewModel(input({
      snapshots,
      selectedCharterId: "charter-2",
      runningSubagentsByCharter: new Map([["charter-3", [liveSub("charter-3")]]]),
    }));
    const lines = renderMultiCharterWidget(vm, theme, width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
