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
  phases: [
    { number: 1, title: "Explore", status: "done", body: "Mapped the system." },
    { number: 2, title: "Build", status: "current", body: "Implementing the runtime. [capture](work/build.png)" },
    { number: 3, title: "Verify", status: "upcoming", body: "Capture artifacts." },
  ],
  reportExists: true,
  now: Date.parse("2026-07-02T11:00:00.000Z"),
};

const STATUS = {
  charterId: "20260702-120000-ship-runtime",
  status: "active",
  objective: BASE.objective,
  references: "",
  scope: "",
  phases: BASE.phases,
  phaseCounts: { upcoming: 1, current: 1, done: 1 },
  legacy: false,
  charterMarkdown: "# Objective\n\nShip a resilient runtime for users.",
  warnings: [],
  reportExists: true,
  nextActions: [],
  createdAt: "2026-07-02T10:00:00.000Z",
} as CharterWidgetStatus;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("widget-state reducer", () => {
  test("projects the current phase and done/total position", () => {
    const vm = buildViewModel(BASE);
    expect(vm.position).toEqual({ done: 1, total: 3 });
    expect(vm.displayName).toBe("ship-runtime");
    expect(vm.currentPhase).toEqual({ number: 2, title: "Build", body: "Implementing the runtime. [capture](work/build.png)" });
  });
});

describe("charter widget", () => {
  test("shows only the short name, lifecycle, and current phase in the compact widget", () => {
    const vm = buildCharterWidgetView({
      ...STATUS,
      objective: "Ship a resilient runtime for users.\n\nKeep the complete Objective visible in the dashboard only.",
    }, Date.parse("2026-07-02T11:00:00.000Z"));
    const lines = renderCharterWidget({ vm: vm!, theme, width: 45 });
    const text = lines.join("\n");
    expect(text).toContain("ship-runtime");
    expect(text).toContain("active");
    expect(text).toContain("Phase 2: Build");
    expect(text).not.toContain("Objective:");
    expect(text).not.toContain("Ship a resilient runtime");
    expect(text).not.toContain("work/build.png");
    expect(text).not.toContain("1/3 done");
    expect(text).not.toContain("REPORT.md");
    expect(lines).toHaveLength(3);
  });

  test("shows Ralph guard warning and guard-paused reason", () => {
    const warning = buildCharterWidgetView({ ...STATUS, ralph: { activations: [1, 2, 3, 4], warnedAt: 5 } });
    expect(renderCharterWidget({ vm: warning!, theme, width: 100 }).join("\n")).toContain("Ralph guard warning");

    const paused = buildCharterWidgetView({ ...STATUS, status: "paused", ralph: { activations: [1, 2, 3, 4, 5], warnedAt: 5, pausedByGuard: true } });
    expect(renderCharterWidget({ vm: paused!, theme, width: 100 }).join("\n")).toContain("paused by Ralph guard");
  });

  test("keeps every line within a narrow terminal width", () => {
    const lines = renderCharterWidget({ vm: buildCharterWidgetView(STATUS)!, theme, width: 45 });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(45);
  });

  test("terminal lifecycle remains visible without implying percentage completion", () => {
    const text = renderCharterWidget({ vm: buildCharterWidgetView({ ...STATUS, status: "completed" })!, theme, width: 80 }).join("\n");
    expect(text).toContain("completed");
    expect(text).not.toContain("1/3 done");
    expect(text).not.toContain("33%");
  });

  test("formatElapsed: <1m → seconds, <1h → 'Xm YYs', >=1h → 'Xh YYm'", () => {
    const { formatElapsed } = require("../src/ui/widget");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(150000)).toBe("2m 30s");
    expect(formatElapsed(3720000)).toBe("1h 02m");
  });
});
