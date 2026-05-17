import { describe, expect, test } from "bun:test";
import type { CharterCriterion, CharterStatus } from "../src/domain/types";
import type { FeatureDefinition } from "../src/domain/feature-md";
import { buildViewModel, type ReducerInput, type RunningSubagent } from "../src/ui/widget-state";
import { CharterWidget, renderCharterWidget, formatElapsed, type UiLike, type TuiLike } from "../src/ui/widget";

// Plain identity theme: tests assert on the raw glyph stream, not ANSI codes.
const theme = { fg: (_color: string, text: string) => text };

type CapturedInterval = {
  handle: ReturnType<typeof setInterval>;
  ms: number | undefined;
  callback: () => void;
  cleared: boolean;
};

function withCapturedIntervals(run: (intervals: CapturedInterval[]) => void): void {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals: CapturedInterval[] = [];
  globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
    const captured: CapturedInterval = {
      handle: { id: intervals.length + 1 } as unknown as ReturnType<typeof setInterval>,
      ms: timeout,
      callback: () => {
        if (typeof callback === "function") callback();
      },
      cleared: false,
    };
    intervals.push(captured);
    return captured.handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    const captured = intervals.find((entry) => entry.handle === handle);
    if (captured) captured.cleared = true;
  }) as unknown as typeof clearInterval;
  try {
    run(intervals);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

function makeWidgetHarness(): {
  ui: UiLike;
  tui: TuiLike;
  mount(): void;
  requestCount(): number;
  isCleared(): boolean;
} {
  let content: Parameters<UiLike["setWidget"]>[1];
  let requestCount = 0;
  const tui: TuiLike = {
    terminal: { columns: 100 },
    requestRender: () => { requestCount += 1; },
  };
  const ui: UiLike = {
    setWidget(_key, next) {
      content = next;
    },
  };
  return {
    ui,
    tui,
    mount() {
      if (typeof content !== "function") throw new Error("widget was not registered");
      content(tui, theme).render();
    },
    requestCount: () => requestCount,
    isCleared: () => content === undefined,
  };
}

function criterion(id: string): CharterCriterion {
  return {
    id,
    title: `${id} title`,
    verifier: "manual",
    requireFreshEvidence: false,
    requireReviewSubagent: false,
  };
}

function feature(input: {
  id: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  milestone?: string;
}): FeatureDefinition {
  return {
    id: input.id,
    milestone: input.milestone ?? "m1",
    order: input.order ?? 10,
    fulfills: input.fulfills ?? [],
    preconditions: input.preconditions ?? [],
    body: "",
  };
}

function defaultInput(overrides: Partial<ReducerInput> = {}): ReducerInput {
  return {
    charterId: "test-charter",
    status: "active" as CharterStatus,
    createdAt: "2026-05-15T10:00:00Z",
    criteria: [],
    features: [],
    criterionOutcomes: {},
    featureStates: {},
    runningSubagents: [],
    now: Date.parse("2026-05-15T10:05:00Z"),
    ...overrides,
  };
}

describe("widget-state reducer", () => {
  test("counts pass/running/total across whole charter", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3"), criterion("VAL-4")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" }, "VAL-2": { outcome: "pass" } },
      runningSubagents: [{ runId: "r1", agentName: "charter-verifier", criterionId: "VAL-3", featureId: "f1", startedAt: "2026-05-15T10:04:00Z" }],
    }));
    expect(vm.bar).toEqual({ pass: 2, running: 1, total: 4 });
  });

  test("running features sort oldest-first; idle ready before idle blocked", () => {
    const subs: RunningSubagent[] = [
      { runId: "r1", agentName: "fixer", featureId: "f-newer", startedAt: "2026-05-15T10:04:30Z" },
      { runId: "r2", agentName: "fixer", featureId: "f-older", startedAt: "2026-05-15T10:03:00Z" },
    ];
    const features = [
      feature({ id: "f-blocked", order: 10, preconditions: ["f-older"] }),
      feature({ id: "f-newer", order: 20 }),
      feature({ id: "f-older", order: 30 }),
      feature({ id: "f-ready", order: 40 }),
    ];
    const vm = buildViewModel(defaultInput({ features, runningSubagents: subs }));
    expect(vm.rows.map((r) => `${r.state}:${r.id}`)).toEqual([
      "running:f-older",
      "running:f-newer",
      "idle_ready:f-ready",
      "idle_blocked:f-blocked",
    ]);
  });

  test("terminal status returns collapsed view (no rows)", () => {
    const vm = buildViewModel(defaultInput({
      status: "completed",
      criteria: [criterion("VAL-1"), criterion("VAL-2")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" }, "VAL-2": { outcome: "pass" } },
      features: [feature({ id: "f1" })],
    }));
    expect(vm.isTerminal).toBe(true);
    expect(vm.rows).toEqual([]);
  });

  test("done features increment overflow.done, never appear as rows", () => {
    const vm = buildViewModel(defaultInput({
      features: [feature({ id: "f1" }), feature({ id: "f2" }), feature({ id: "f3" })],
      featureStates: { f1: { status: "done" }, f2: { status: "completed" } },
    }));
    expect(vm.rows.map((r) => r.id)).toEqual(["f3"]);
    expect(vm.overflow).toEqual({ hidden: 0, done: 2 });
  });

  test("trims to MAX_ROWS - 1 when overflow needed and surfaces hidden count", () => {
    const features = Array.from({ length: 10 }, (_, i) => feature({ id: `f${i}`, order: i }));
    const vm = buildViewModel(defaultInput({ features }));
    // MAX_ROWS=6 → 5 rows + overflow line
    expect(vm.rows.length).toBe(5);
    expect(vm.overflow.hidden).toBe(5);
    expect(vm.overflow.done).toBe(0);
  });

  test("per-feature valStates reflect outcome + running state in declaration order", () => {
    // A running row (live subagent on the feature) paints every non-pass VAL
    // as running, so the user sees the in-flight feature contribute to the
    // bar instead of showing pending pips that lie about progress.
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" } },
      features: [feature({ id: "f1", fulfills: ["VAL-1", "VAL-3", "VAL-2"] })],
      runningSubagents: [{ runId: "r1", agentName: "v", featureId: "f1", criterionId: "VAL-2", startedAt: "2026-05-15T10:04:00Z" }],
    }));
    expect(vm.rows[0]?.valStates).toEqual(["pass", "running", "running"]);
  });

  test("bar credits in_progress features (feature-state) without a live subagent", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" } },
      features: [feature({ id: "f1", fulfills: ["VAL-2", "VAL-3"] })],
      featureStates: { f1: { status: "in_progress" } },
      runningSubagents: [],
    }));
    expect(vm.bar).toEqual({ pass: 1, running: 2, total: 3 });
  });
});

describe("widget render", () => {
  test("renders box border + bar tail at 100 cols", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3"), criterion("VAL-4")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" } },
      features: [feature({ id: "m3-cli", fulfills: ["VAL-1", "VAL-2", "VAL-3"] })],
    }));
    const lines = renderCharterWidget({ width: 100, theme, vm });
    // No explicit name set; reducer falls back to first 8 chars of charterId.
    expect(lines[0]?.startsWith("╭─ test-cha ")).toBe(true);
    expect(lines[0]?.endsWith("─╮")).toBe(true);
    // Bar tail must show 1/4
    expect(lines[1]).toMatch(/1\/4/);
    // Final line is the bottom border.
    expect(lines[lines.length - 1]?.startsWith("╰")).toBe(true);
    expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
  });

  test("terminal state renders boxed celebratory view (header + full bar + footer)", () => {
    const vm = buildViewModel(defaultInput({
      name: "my-charter",
      status: "completed",
      criteria: [criterion("VAL-1"), criterion("VAL-2")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" }, "VAL-2": { outcome: "pass" } },
    }));
    const lines = renderCharterWidget({ width: 60, theme, vm });
    expect(lines.length).toBe(3); // header + bar + footer
    expect(lines[0]).toMatch(/my-charter/);
    expect(lines[0]).toMatch(/completed/);
    expect(lines[1]).toMatch(/2\/2/);
    // Bar should be entirely pass glyphs.
    expect(lines[1]).toMatch(/█/);
    expect(lines[1]).not.toMatch(/░/);
    expect(lines[2]?.startsWith("╰")).toBe(true);
    expect(lines[2]?.endsWith("╯")).toBe(true);
  });

  test("explicit name overrides UUID prefix in header", () => {
    const vm = buildViewModel(defaultInput({ name: "headless-click-pid" }));
    const lines = renderCharterWidget({ width: 100, theme, vm });
    expect(lines[0]).toMatch(/headless-click-pid/);
  });

  test("full bead row at wide width (B >= N)", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" } },
      features: [feature({ id: "f", fulfills: ["VAL-1", "VAL-2", "VAL-3"] })],
    }));
    const lines = renderCharterWidget({ width: 180, theme, vm });
    // f row should contain three beads: ▰ pass, ▱ pending, ▱ pending.
    const row = lines.find((line) => line.includes(" f "));
    expect(row).toBeDefined();
    expect(row).toMatch(/▰▱▱/);
  });

  test("fraction-only beads when budget < BEAD_MIN_BUDGET (narrow + long subagent name)", () => {
    const vm = buildViewModel(defaultInput({
      criteria: Array.from({ length: 20 }, (_, i) => criterion(`VAL-${i + 1}`)),
      criterionOutcomes: Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [`VAL-${i + 1}`, { outcome: "pass" }] as const),
      ),
      features: [feature({ id: "wide-feature-name", fulfills: Array.from({ length: 20 }, (_, i) => `VAL-${i + 1}`) })],
      runningSubagents: [{ runId: "r1", agentName: "charter-verifier-with-loud-name", featureId: "wide-feature-name", startedAt: "2026-05-15T10:04:00Z" }],
    }));
    const lines = renderCharterWidget({ width: 60, theme, vm });
    // Minimum width clamps to 60; row should still render. Beads should fall
    // back to fraction "7/20" rather than 20 individual glyphs.
    const row = lines.find((line) => line.includes("wide-feature-name"));
    expect(row).toBeDefined();
    expect(row).toMatch(/7\/20/);
    // 20 sequential bead glyphs should NOT appear.
    expect(row).not.toMatch(/▱▱▱▱▱▱▱▱▱▱/);
  });

  test("overflow line shows '+N more · M done' when both apply", () => {
    const features = Array.from({ length: 8 }, (_, i) => feature({ id: `f${i}`, order: i }));
    const featureStates = { f0: { status: "done" }, f1: { status: "done" } };
    const vm = buildViewModel(defaultInput({ features, featureStates }));
    const lines = renderCharterWidget({ width: 100, theme, vm });
    const overflowRow = lines.find((line) => line.includes("more"));
    expect(overflowRow).toBeDefined();
    expect(overflowRow).toMatch(/\+1 more/);
    expect(overflowRow).toMatch(/2 done/);
  });

  test("formatElapsed: <1m → seconds, <1h → 'Xm YYs', >=1h → 'Xh YYm'", () => {
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(4 * 60 * 1000 + 12_000)).toBe("4m 12s");
    expect(formatElapsed(63 * 60 * 1000 + 12_000)).toBe("1h 03m");
  });
});

describe("widget host timers", () => {
  test("CharterWidget.update starts a 5s elapsed ticker that requests render while registered", () => {
    withCapturedIntervals((intervals) => {
      const widget = new CharterWidget();
      const harness = makeWidgetHarness();
      widget.setUi(harness.ui);

      widget.update(buildViewModel(defaultInput({ features: [feature({ id: "f1" })] })));
      harness.mount();
      const elapsed = intervals.find((entry) => entry.ms === 5_000);

      expect(elapsed).toBeDefined();
      expect(harness.requestCount()).toBe(0);
      elapsed!.callback();
      expect(harness.requestCount()).toBe(1);
    });
  });

  test("CharterWidget.dispose clears elapsed ticker and prevents further render requests", () => {
    withCapturedIntervals((intervals) => {
      const widget = new CharterWidget();
      const harness = makeWidgetHarness();
      widget.setUi(harness.ui);

      widget.update(buildViewModel(defaultInput({ features: [feature({ id: "f1" })] })));
      harness.mount();
      const elapsed = intervals.find((entry) => entry.ms === 5_000);
      expect(elapsed).toBeDefined();

      widget.dispose();

      expect(elapsed!.cleared).toBe(true);
      expect(harness.isCleared()).toBe(true);
      elapsed!.callback();
      expect(harness.requestCount()).toBe(0);
    });
  });

  test("spinner and elapsed timers coexist and are both cleared on dispose", () => {
    withCapturedIntervals((intervals) => {
      const widget = new CharterWidget();
      const harness = makeWidgetHarness();
      widget.setUi(harness.ui);

      widget.update(buildViewModel(defaultInput({
        features: [feature({ id: "f1" })],
        runningSubagents: [{ runId: "r1", agentName: "fixer", featureId: "f1", startedAt: "2026-05-15T10:04:00Z" }],
      })));

      const spinner = intervals.find((entry) => entry.ms === 120);
      const elapsed = intervals.find((entry) => entry.ms === 5_000);
      expect(spinner).toBeDefined();
      expect(elapsed).toBeDefined();

      widget.dispose();

      expect(spinner!.cleared).toBe(true);
      expect(elapsed!.cleared).toBe(true);
    });
  });
});

describe("planning widget", () => {
  test("empty charter: only 'create' step done, hint asks for VAL criteria", () => {
    const vm = buildViewModel(defaultInput({ status: "planning" }));
    expect(vm.isPlanning).toBe(true);
    expect(vm.planning?.steps.map((s) => `${s.id}:${s.state}`)).toEqual([
      "create:done",
      "criteria:pending",
      "features:pending",
      "critique:pending",
      "lock:pending",
    ]);
    expect(vm.planning?.nextHint).toMatch(/charter\.md/);
  });

  test("partial coverage: features step is partial, hint targets uncovered ids", () => {
    const vm = buildViewModel(defaultInput({
      status: "planning",
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3")],
      features: [feature({ id: "f1", fulfills: ["VAL-1"] })],
    }));
    const steps = vm.planning?.steps ?? [];
    expect(steps.find((s) => s.id === "criteria")?.state).toBe("done");
    expect(steps.find((s) => s.id === "features")?.state).toBe("partial");
    expect(vm.planning?.uncoveredCriteria).toEqual(["VAL-2", "VAL-3"]);
    expect(vm.planning?.nextHint).toMatch(/VAL-2/);
  });

  test("full coverage: features step done, hint nudges critique + lock_plan", () => {
    const vm = buildViewModel(defaultInput({
      status: "planning",
      criteria: [criterion("VAL-1")],
      features: [feature({ id: "f1", fulfills: ["VAL-1"] })],
    }));
    expect(vm.planning?.steps.find((s) => s.id === "features")?.state).toBe("done");
    expect(vm.planning?.nextHint).toMatch(/charter-planner-critic|lock_plan/);
  });

  test("render: pipeline replaces the bar/feature view in planning", () => {
    const vm = buildViewModel(defaultInput({
      status: "planning",
      name: "my-charter",
      criteria: [criterion("VAL-1")],
      features: [feature({ id: "f1", fulfills: ["VAL-1"] })],
    }));
    const lines = renderCharterWidget({ width: 100, theme, vm });
    // Header shows planning state.
    expect(lines[0]).toMatch(/my-charter/);
    expect(lines[0]).toMatch(/planning/);
    // No VAL bar glyphs anywhere.
    expect(lines.some((l) => /[█▓░]/.test(l))).toBe(false);
    // All five pipeline steps appear.
    expect(lines.some((l) => l.includes("Create charter"))).toBe(true);
    expect(lines.some((l) => l.includes("Define VAL criteria"))).toBe(true);
    expect(lines.some((l) => l.includes("Seed features"))).toBe(true);
    expect(lines.some((l) => l.includes("charter-planner-critic"))).toBe(true);
    expect(lines.some((l) => l.includes("lock_plan"))).toBe(true);
    // Next-action hint row present.
    expect(lines.some((l) => l.includes("Next:"))).toBe(true);
  });
});
