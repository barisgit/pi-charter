import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildViewModel, type ReducerInput } from "../src/ui/widget-state";
import { buildCharterWidgetView, renderCharterWidget, type CharterWidgetStatus } from "../src/ui/widget";

const BASE: ReducerInput = {
  charterId: "20260702-120000-ship-runtime",
  name: "ship-runtime",
  status: "active",
  createdAt: "2026-07-02T10:00:00.000Z",
  criteria: [
    { id: "C1", evidence: "pass" },
    { id: "C2", evidence: "fail" },
    { id: "C3", evidence: "none" },
  ],
  now: Date.parse("2026-07-02T11:00:00.000Z"),
};

const STATUS: CharterWidgetStatus & { createdAt: string } = {
  charterId: "20260702-120000-ship-runtime",
  status: "active",
  objective: "Ship runtime",
  openEnded: false,
  criteria: [
    { id: "C1", title: "First criterion", evidence: "pass", note: "checked", stale: false, depends: [] },
    { id: "C2", title: "Second criterion", evidence: "fail", note: "broken", stale: false, depends: [] },
    { id: "C3", title: "Third criterion", evidence: "none", note: "", stale: false, depends: [] },
  ],
  evidenceCounts: { pass: 1, fail: 1, none: 1 },
  blockers: ["C2 has fail evidence"],
  warnings: [],
  readyNext: ["C3"],
  reportExists: false,
  nextActions: [],
  createdAt: "2026-07-02T10:00:00.000Z",
};

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("widget-state reducer", () => {
  test("maps ADR-0014 evidence counts into the old pass/accent/pending bar slots", () => {
    const vm = buildViewModel(BASE);
    expect(vm.bar).toEqual({ pass: 1, running: 1, total: 3 });
    expect(vm.displayName).toBe("ship-runtime");
    expect(vm.isPlanning).toBe(false);
  });

  test("terminal status renders as terminal", () => {
    const vm = buildViewModel({ ...BASE, status: "completed" });
    expect(vm.isTerminal).toBe(true);
  });
});

describe("charter widget old visual shell", () => {
  test("renders boxed header, progress bar, empty detail slot, and footer", () => {
    const vm = buildCharterWidgetView(STATUS, Date.parse("2026-07-02T11:00:00.000Z"));
    expect(vm).toBeDefined();
    const lines = renderCharterWidget({ vm: vm!, theme, width: 100 });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("ship-runtime");
    expect(lines[1]).toContain("1/3");
    expect(lines[3]).toContain("╰");
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(100);
  });

  test("terminal state keeps the old collapsed boxed strip", () => {
    const vm = buildCharterWidgetView({ ...STATUS, status: "completed" }, Date.parse("2026-07-02T11:00:00.000Z"));
    const lines = renderCharterWidget({ vm: vm!, theme, width: 80 });
    expect(lines.join("\n")).toContain("completed");
    expect(lines.join("\n")).toContain("1/3");
  });

  test("formatElapsed: <1m → seconds, <1h → 'Xm YYs', >=1h → 'Xh YYm'", () => {
    const { formatElapsed } = require("../src/ui/widget");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(150000)).toBe("2m 30s");
    expect(formatElapsed(3720000)).toBe("1h 02m");
  });
});
