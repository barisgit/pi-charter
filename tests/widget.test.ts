import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildViewModel, type ReducerInput } from "../src/ui/widget-state";
import { buildCharterWidgetView, renderCharterWidget, type CharterWidgetStatus } from "../src/ui/widget";

const BASE: ReducerInput = {
  charterId: "20260702-120000-ship-runtime",
  name: "ship-runtime",
  status: "active",
  createdAt: "2026-07-02T10:00:00.000Z",
  objective: "Ship a resilient runtime for users.",
  reportExists: true,
  now: Date.parse("2026-07-02T11:00:00.000Z"),
};

const STATUS: CharterWidgetStatus = {
  charterId: "20260702-120000-ship-runtime",
  status: "active",
  objective: "Ship a resilient runtime for users.",
  references: "",
  scope: "",
  notes: "## Phases\n\n1. Explore — done\n2. Build — current",
  legacy: false,
  charterMarkdown: "# Objective\n\nShip a resilient runtime for users.",
  warnings: [],
  reportExists: true,
  nextActions: [],
  createdAt: "2026-07-02T10:00:00.000Z",
};

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("widget-state reducer", () => {
  test("projects name, lifecycle and elapsed time without phase progress", () => {
    const vm = buildViewModel(BASE);
    expect(vm).toMatchObject({ displayName: "ship-runtime", status: "active", isTerminal: false, elapsedMs: 3_600_000 });
    for (const removed of ["position", "currentPhase"]) expect(vm).not.toHaveProperty(removed);
  });
});

describe("charter widget", () => {
  test("shows the short name and lifecycle in a bordered widget without Objective, notes or progress", () => {
    const vm = buildCharterWidgetView(STATUS, Date.parse("2026-07-02T11:00:00.000Z"));
    const lines = renderCharterWidget({ vm: vm!, theme, width: 45 });
    const text = lines.join("\n");
    expect(lines[0]).toMatch(/^╭.*╮$/);
    expect(lines[0]).toContain("ship-runtime");
    expect(lines[0]).toContain("active · 1h 00m");
    expect(text.match(/active/g)).toHaveLength(1);
    expect(text).not.toMatch(/phase|Build|Ship a resilient|REPORT|[█▓░]|\d\/\d/i);
    expect(lines).toHaveLength(2);
  });

  test("shows Ralph guard warning and guard-paused reason", () => {
    const warning = buildCharterWidgetView({ ...STATUS, ralph: { activations: [1, 2, 3, 4], warnedAt: 5 } });
    expect(renderCharterWidget({ vm: warning!, theme, width: 100 }).join("\n")).toContain("Ralph guard warning");

    const paused = buildCharterWidgetView({ ...STATUS, status: "paused", ralph: { activations: [1, 2, 3, 4, 5], warnedAt: 5, pausedByGuard: true } });
    expect(renderCharterWidget({ vm: paused!, theme, width: 100 }).join("\n")).toContain("Guard paused · resume with /charter resume");
  });

  test("marks legacy charters read-only", () => {
    const text = renderCharterWidget({ vm: buildCharterWidgetView({ ...STATUS, legacy: true })!, theme, width: 80 }).join("\n");
    expect(text).toContain("Legacy charter · read-only");
  });

  test("keeps elapsed time and the Ralph countdown visible at every width", () => {
    const vm = buildViewModel(BASE);
    vm.ralphRemainingMs = 12_000;
    for (const width of [38, 64, 120]) {
      const lines = renderCharterWidget({ vm, theme, width });
      expect(lines[0]).toContain("active · 1h 00m");
      expect(lines[1]).toContain("↻ Ralph continues in 12s");
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  test("keeps every line within a narrow terminal width", () => {
    const lines = renderCharterWidget({ vm: buildCharterWidgetView({ ...STATUS, ralph: { activations: [1], warnedAt: 5 } })!, theme, width: 20 });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  test("terminal lifecycle remains visible", () => {
    const text = renderCharterWidget({ vm: buildCharterWidgetView({ ...STATUS, status: "completed" })!, theme, width: 80 }).join("\n");
    expect(text).toContain("completed");
  });

  test("formatElapsed: <1m → seconds, <1h → 'Xm YYs', >=1h → 'Xh YYm'", () => {
    const { formatElapsed } = require("../src/ui/widget");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(150000)).toBe("2m 30s");
    expect(formatElapsed(3720000)).toBe("1h 02m");
  });
});
