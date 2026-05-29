import { describe, expect, test } from "bun:test";
import { buildViewModel, type ReducerInput } from "../src/ui/widget-state";
import { renderCharterWidget } from "../src/ui/widget";
import { CharterWidget } from "../src/ui/widget";
import type { CharterWidgetVM } from "../src/ui/widget-state";

const BASE: ReducerInput = {
  charterId: "abc123de-0000-0000-0000-000000000000",
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  criteria: [
    { id: "VAL-A", title: "A", verifier: "command", requireFreshEvidence: false, requireReviewSubagent: undefined },
    { id: "VAL-B", title: "B", verifier: "manual", requireFreshEvidence: false, requireReviewSubagent: undefined },
    { id: "VAL-C", title: "C", verifier: "manual", requireFreshEvidence: false, requireReviewSubagent: undefined },
  ],
  criterionOutcomes: {},
  runningSubagents: [],
  now: Date.parse("2026-05-01T01:00:00.000Z"),
};

function base(overrides: Partial<ReducerInput> = {}): ReducerInput {
  return { ...BASE, ...overrides };
}

describe("widget-state reducer", () => {
  test("counts pass/running/total across whole charter", () => {
    const vm = buildViewModel(base({
      criterionOutcomes: { "VAL-A": { outcome: "pass" } },
      runningSubagents: [{ runId: "r1", charterId: BASE.charterId, criterionId: "VAL-B", startedAt: "2026-05-01T00:30:00.000Z" }],
    }));
    expect(vm.bar.pass).toBe(1);
    expect(vm.bar.running).toBe(1);
    expect(vm.bar.total).toBe(3);
  });

  test("terminal status: isTerminal true, elapsedMs frozen", () => {
    const vm = buildViewModel(base({ status: "completed" }));
    expect(vm.isTerminal).toBe(true);
    expect(vm.isPlanning).toBe(false);
    expect(vm.elapsedMs).toBe(3600000);
  });

  test("all pass: bar.pass === total", () => {
    const vm = buildViewModel(base({
      criterionOutcomes: {
        "VAL-A": { outcome: "pass" },
        "VAL-B": { outcome: "pass" },
        "VAL-C": { outcome: "pass" },
      },
    }));
    expect(vm.bar.pass).toBe(3);
    expect(vm.bar.total).toBe(3);
  });

  test("explicit name overrides UUID prefix", () => {
    const vm = buildViewModel(base({ name: "my-charter" }));
    expect(vm.displayName).toBe("my-charter");
  });

  test("UUID prefix fallback when name absent", () => {
    const vm = buildViewModel(base());
    expect(vm.displayName).toBe("abc123de");
  });

  test("isPlanning is always false without the planning pipeline", () => {
    const vm = buildViewModel(base({ status: "active" }));
    expect(vm.isPlanning).toBe(false);
  });

  test("bar.running counts verifying criteria (pinned by criterionId)", () => {
    const vm = buildViewModel(base({
      runningSubagents: [
        { runId: "r1", charterId: BASE.charterId, criterionId: "VAL-A", startedAt: "2026-05-01T00:30:00.000Z" },
        { runId: "r2", charterId: BASE.charterId, criterionId: "VAL-B", startedAt: "2026-05-01T00:31:00.000Z" },
      ],
    }));
    expect(vm.bar.running).toBe(2);
  });

  test("pass criterion not counted as running even with live subagent", () => {
    const vm = buildViewModel(base({
      criterionOutcomes: { "VAL-A": { outcome: "pass" } },
      runningSubagents: [{ runId: "r1", charterId: BASE.charterId, criterionId: "VAL-A", startedAt: "2026-05-01T00:30:00.000Z" }],
    }));
    expect(vm.bar.pass).toBe(1);
    expect(vm.bar.running).toBe(0);
  });
});

describe("widget render", () => {
  const noopTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };

  test("renders box border + bar tail at 100 cols", () => {
    const vm = buildViewModel(base({
      criterionOutcomes: { "VAL-A": { outcome: "pass" } },
    }));
    const lines = renderCharterWidget({ vm, theme: noopTheme, width: 100 });
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("1/3");
  });

  test("terminal state renders header with status", () => {
    const vm = buildViewModel(base({
      status: "completed",
      criterionOutcomes: {
        "VAL-A": { outcome: "pass" },
        "VAL-B": { outcome: "pass" },
        "VAL-C": { outcome: "pass" },
      },
    }));
    const lines = renderCharterWidget({ vm, theme: noopTheme, width: 100 });
    const joined = lines.join("\n");
    expect(joined).toContain("completed");
    expect(joined).toContain("3/3");
  });

  test("explicit name shows in header", () => {
    const vm = buildViewModel(base({ name: "my-charter" }));
    const lines = renderCharterWidget({ vm, theme: noopTheme, width: 100 });
    expect(lines.join("\n")).toContain("my-charter");
  });

  test("formatElapsed: <1m → seconds, <1h → 'Xm YYs', >=1h → 'Xh YYm'", () => {
    const { formatElapsed } = require("../src/ui/widget");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(150000)).toBe("2m 30s");
    expect(formatElapsed(3720000)).toBe("1h 02m");
  });
});

describe("widget host timers", () => {
  test("CharterWidget.update starts a 5s elapsed ticker that requests render when hasUI", async () => {
    const renderCalls: number[] = [];
    const mockTui = { requestRender: () => renderCalls.push(Date.now()) };
    const mockUi = {
      setWidget: (_key: string, factory: Function | undefined, _opts?: unknown) => {
        if (typeof factory === "function") {
          factory(mockTui, { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t });
        }
      },
      removeWidget: () => {},
    };
    const widget = new CharterWidget();
    widget.setUi(mockUi as any);
    const vm = buildViewModel(base());
    widget.update(vm);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(renderCalls.length).toBeGreaterThanOrEqual(1);
    widget.dispose();
  }, 10000);

  test("CharterWidget.dispose clears elapsed ticker and prevents further render calls", async () => {
    const renderCalls: number[] = [];
    const mockTui = { requestRender: () => renderCalls.push(Date.now()) };
    const mockUi = {
      setWidget: (_key: string, factory: Function | undefined, _opts?: unknown) => {
        if (typeof factory === "function") {
          factory(mockTui, { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t });
        }
      },
      removeWidget: () => {},
    };
    const widget = new CharterWidget();
    widget.setUi(mockUi as any);
    widget.update(buildViewModel(base()));
    widget.dispose();
    const before = renderCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(renderCalls.length).toBe(before);
  }, 10000);
});

describe("widget without planning pipeline", () => {
  test("active charter uses execution view (isPlanning=false, bar present)", () => {
    const vm = buildViewModel(base({ status: "active" }));
    expect(vm.isPlanning).toBe(false);
    expect(vm.bar).toBeDefined();
    expect(vm.bar.total).toBe(3);
  });
});
