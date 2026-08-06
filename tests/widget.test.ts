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
    { id: "C1", title: "First criterion", status: "pass" },
    { id: "C2", title: "Second criterion", status: "in-progress" },
    { id: "C3", title: "Third criterion", status: "pending" },
  ],
  now: Date.parse("2026-07-02T11:00:00.000Z"),
};

const STATUS: CharterWidgetStatus & { createdAt: string } = {
  charterId: "20260702-120000-ship-runtime",
  status: "active",
  objective: "Ship runtime",
  references: "",
  scope: "",
  openEnded: false,
  criteria: [
    { id: "C1", title: "First criterion", body: "", status: "pass", note: "checked", stale: false, depends: [], failCount: 0 },
    { id: "C2", title: "Second criterion", body: "", status: "in-progress", note: "working", stale: false, depends: [], failCount: 0 },
    { id: "C3", title: "Third criterion", body: "", status: "pending", note: "", stale: false, depends: [], failCount: 0 },
  ],
  statusCounts: { pass: 1, fail: 0, pending: 1, blocked: 0, "in-progress": 1 },
  blockers: ["C2 status is in-progress"],
  warnings: [],
  readyNext: ["C3"],
  reportExists: false,
  nextActions: [],
  createdAt: "2026-07-02T10:00:00.000Z",
};

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("widget-state reducer", () => {
  test("maps unified statuses into pass/active/pending bar slots", () => {
    const vm = buildViewModel(BASE);
    expect(vm.bar).toEqual({ pass: 1, running: 1, total: 3 });
    expect(vm.displayName).toBe("ship-runtime");
    expect(vm.isPlanning).toBe(false);
    expect(vm.nextCriterion).toEqual({ id: "C2", title: "Second criterion", status: "in-progress" });
  });

  test("active and paused headers expose distinct state labels", () => {
    const active = renderCharterWidget({ vm: buildCharterWidgetView(STATUS)!, theme, width: 80 });
    const paused = renderCharterWidget({ vm: buildCharterWidgetView({ ...STATUS, status: "paused" })!, theme, width: 80 });
    expect(active[0]).toContain("active ·");
    expect(paused[0]).toContain("paused ·");
  });

  test("renders an amber Ralph countdown row inside the widget", () => {
    const vm = { ...buildCharterWidgetView(STATUS)!, ralphRemainingMs: 10_000 };
    const colors: Array<{ color: string; text: string }> = [];
    const coloredTheme = { fg: (color: string, text: string) => { colors.push({ color, text }); return text; } };
    const lines = renderCharterWidget({ vm, theme: coloredTheme, width: 80 });
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("Ralph continues in 10s");
    expect(colors).toContainEqual({ color: "warning", text: "Ralph continues in 10s" });
  });

  test("prompts for the first criterion when the charter is empty", () => {
    const vm = buildCharterWidgetView({ ...STATUS, criteria: [], statusCounts: { pass: 0, fail: 0, pending: 0, blocked: 0, "in-progress": 0 }, readyNext: [] });
    const lines = renderCharterWidget({ vm: vm!, theme, width: 80 });
    expect(lines[2]).toContain("Next: add the first criterion");
  });

  test("preserves the right border when a wide-character title is truncated", () => {
    const criteria = [{ id: "C1", title: "修正する基準".repeat(8), body: "", status: "pending" as const, note: "", stale: false, depends: [], failCount: 0 }];
    const vm = buildCharterWidgetView({ ...STATUS, criteria, statusCounts: { pass: 0, fail: 0, pending: 1, blocked: 0, "in-progress": 0 }, readyNext: ["C1"] });
    const lines = renderCharterWidget({ vm: vm!, theme, width: 60 });
    expect(lines[2].endsWith("│")).toBe(true);
    expect(visibleWidth(lines[2])).toBe(60);
  });

  test("keeps every line within a narrow terminal width", () => {
    const width = 45;
    const vm = buildCharterWidgetView(STATUS)!;
    const lines = renderCharterWidget({ vm, theme, width });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("terminal status renders as terminal", () => {
    const vm = buildViewModel({ ...BASE, status: "completed" });
    expect(vm.isTerminal).toBe(true);
  });
});

describe("charter widget old visual shell", () => {
  test("renders boxed header, progress bar, next incomplete criterion, and footer", () => {
    const vm = buildCharterWidgetView(STATUS, Date.parse("2026-07-02T11:00:00.000Z"));
    expect(vm).toBeDefined();
    const lines = renderCharterWidget({ vm: vm!, theme, width: 100 });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("ship-runtime");
    expect(lines[1]).toContain("1/3");
    expect(lines[2]).toContain("Current: C2 [in-progress] — Second criterion");
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
