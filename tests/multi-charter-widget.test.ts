/**
 * VAL-3 verifier: `buildMultiCharterViewModel` is a pure projection from N
 * pre-built single-charter snapshots into the multi-charter widget VM.
 * Caps visible rows at 5; everything else collapses into `hiddenCount`.
 */

import { describe, expect, test } from "bun:test";
import type { CharterStatus } from "../src/domain/types";
import {
  buildMultiCharterViewModel,
  MAX_MULTI_ROWS,
  type CharterSnapshotLike,
  type MultiReducerInput,
  type RunningSubagent,
} from "../src/ui/widget-state";

function snapshot(
  id: string,
  overrides: Partial<CharterSnapshotLike> = {},
): CharterSnapshotLike {
  return {
    charterId: id,
    displayName: id.slice(0, 8),
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

function nSnapshots(n: number): CharterSnapshotLike[] {
  return Array.from({ length: n }, (_, i) => snapshot(`charter-${i + 1}`));
}

describe("VAL-3: buildMultiCharterViewModel", () => {
  test("MAX_MULTI_ROWS is 5", () => {
    expect(MAX_MULTI_ROWS).toBe(5);
  });

  test("0 charters -> empty VM { charters: [], hiddenCount: 0 }", () => {
    const vm = buildMultiCharterViewModel(input({ snapshots: [] }));
    expect(vm).toEqual({ charters: [], hiddenCount: 0 });
  });

  test("1 charter -> 1 row, isSelected=false when selectedCharterId=null", () => {
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("c1", { displayName: "alpha", bar: { pass: 2, running: 1, total: 5 } })],
      selectedCharterId: null,
    }));
    expect(vm.hiddenCount).toBe(0);
    expect(vm.charters).toHaveLength(1);
    expect(vm.charters[0]).toEqual({
      charterId: "c1",
      displayName: "alpha",
      status: "active",
      bar: { pass: 2, running: 1, total: 5 },
      isSelected: false,
      hasLiveSubagent: false,
    });
  });

  test("5 charters -> 5 rows, hiddenCount=0", () => {
    const vm = buildMultiCharterViewModel(input({ snapshots: nSnapshots(5) }));
    expect(vm.charters).toHaveLength(5);
    expect(vm.hiddenCount).toBe(0);
    expect(vm.charters.map((row) => row.charterId)).toEqual([
      "charter-1", "charter-2", "charter-3", "charter-4", "charter-5",
    ]);
  });

  test("7 charters -> 5 rows, hiddenCount=2", () => {
    const vm = buildMultiCharterViewModel(input({ snapshots: nSnapshots(7) }));
    expect(vm.charters).toHaveLength(5);
    expect(vm.hiddenCount).toBe(2);
    // The first 5 (input order) are kept; the rest collapse.
    expect(vm.charters.map((row) => row.charterId)).toEqual([
      "charter-1", "charter-2", "charter-3", "charter-4", "charter-5",
    ]);
  });

  test("selection highlighting -> isSelected=true on the matching row only", () => {
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("a"), snapshot("b"), snapshot("c")],
      selectedCharterId: "b",
    }));
    expect(vm.charters.map((row) => ({ id: row.charterId, sel: row.isSelected }))).toEqual([
      { id: "a", sel: false },
      { id: "b", sel: true },
      { id: "c", sel: false },
    ]);
  });

  test("live-subagent dot -> hasLiveSubagent=true when registry has entries for that charterId", () => {
    const sub = (charterId: string): RunningSubagent => ({
      runId: `run-${charterId}`,
      charterId,
      startedAt: "2026-05-15T10:00:00.000Z",
    });
    const vm = buildMultiCharterViewModel(input({
      snapshots: [snapshot("a"), snapshot("b"), snapshot("c")],
      runningSubagentsByCharter: new Map([
        ["a", [sub("a")]],
        // "b" omitted entirely
        ["c", []], // empty array still counts as "no live"
      ]),
    }));
    expect(vm.charters.map((row) => ({ id: row.charterId, live: row.hasLiveSubagent }))).toEqual([
      { id: "a", live: true },
      { id: "b", live: false },
      { id: "c", live: false },
    ]);
  });
});
