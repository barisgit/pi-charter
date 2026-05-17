import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterCommands } from "../src/application/registration";
import type { CharterStatus } from "../src/domain/types";
import { CharterPickerComponent } from "../src/ui/charter-picker";
import type { CharterListRow, PickerSnapshot } from "../src/ui/picker-snapshot";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function leftWidthFor(width: number): number {
  return Math.max(28, Math.min(50, Math.floor((width - 3) * 0.32)));
}

function charter(id: string, overrides: Partial<CharterListRow> = {}): CharterListRow {
  return {
    charterId: id,
    name: id,
    status: "active" as CharterStatus,
    passCount: 1,
    totalCount: 3,
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(id: string, overrides: Partial<PickerSnapshot> = {}): PickerSnapshot {
  return {
    charterId: id,
    header: {
      name: id,
      status: "active" as CharterStatus,
      elapsedMs: 65_000,
      passCount: 3,
      totalCount: 3,
    },
    objective: "Ship a focused picker render implementation.",
    evaluatorVerdict: { verdict: "on_track", steer: "Keep the implementation small.", ts: "2026-05-15T01:00:00.000Z" },
    blockingForComplete: [],
    planTree: [
      {
        milestoneId: "m1",
        features: [
          {
            featureId: "f1-render",
            status: "in_progress",
            passCount: 1,
            totalCount: 2,
            criteria: [
              { criterionId: "VAL-A", titleFromH3: "First criterion", outcome: "pass" },
              { criterionId: "VAL-B", titleFromH3: "Second criterion", outcome: null },
            ],
          },
        ],
      },
    ],
    recentEvidence: [
      { ts: "2026-05-15T09:10:00.000Z", criterionId: "VAL-A", outcome: "pass", recordedBy: "tester" },
    ],
    ...overrides,
  };
}

function makePicker(opts: {
  charters?: CharterListRow[];
  snapshots?: Map<string, PickerSnapshot>;
  height?: number;
  initialCursorCharterId?: string;
  boundCharterId?: string | null;
} = {}): CharterPickerComponent {
  const charters = opts.charters ?? [charter("alpha"), charter("beta"), charter("gamma")];
  return new CharterPickerComponent({
    charters,
    snapshots: opts.snapshots ?? new Map(charters.map((row) => [row.charterId, snapshot(row.charterId)])),
    theme,
    heightProvider: () => opts.height ?? 40,
    ...(opts.initialCursorCharterId !== undefined ? { initialCursorCharterId: opts.initialCursorCharterId } : {}),
    boundCharterId: opts.boundCharterId ?? null,
    onDone: () => undefined,
  });
}

function leftCell(row: string, width: number): string {
  const leftWidth = leftWidthFor(width);
  return row.slice(1, 1 + leftWidth);
}

function rightCell(row: string, width: number): string {
  const leftWidth = leftWidthFor(width);
  return row.slice(2 + leftWidth, -1);
}

describe("CharterPickerComponent f5-picker-render", () => {
  test("VAL-PICKER-RENDER-001: exact height, width, and divider position", () => {
    const picker = makePicker();
    for (const width of [80, 120, 160]) {
      const lines = picker.render(width);
      expect(lines).toHaveLength(40);
      for (const line of lines) expect(line.length).toBe(width);
      const dividerColumn = 1 + leftWidthFor(width);
      for (const row of lines.slice(1, -1)) expect(row[dividerColumn]).toBe("│");
    }
  });

  test("VAL-PICKER-RENDER-002: terminal separator, bound marker, and cursor marker", () => {
    const charters = [
      charter("alpha"),
      charter("bound"),
      charter("cursor"),
      charter("done-a", { status: "completed" as CharterStatus }),
      charter("done-b", { status: "abandoned" as CharterStatus }),
    ];
    const picker = makePicker({ charters, boundCharterId: "bound", initialCursorCharterId: "cursor" });
    const lines = picker.render(120);
    const left = lines.slice(1, -1).map((line) => leftCell(line, 120)).join("\n");
    expect(left).toMatch(/── done ─+/);
    expect(left.split("\n").find((line) => line.includes("bound"))).toContain("*");
    expect(left.split("\n").find((line) => line.includes("cursor"))).toContain("►");
  });

  test("VAL-PICKER-RENDER-003: right pane sections render in order", () => {
    const picker = makePicker();
    const right = picker.render(160).slice(1, -1).map((line) => rightCell(line, 160)).join("\n");
    // Picker renders either "Blocking complete" or "Ready to complete" depending on state.
    const labels = ["Objective", "Evaluator", /Blocking complete|Ready to complete/, "Plan", "Recent evidence"];
    let last = -1;
    for (const label of labels) {
      const index = typeof label === "string" ? right.indexOf(label) : right.search(label);
      expect(index).toBeGreaterThan(last);
      last = index;
    }
  });

  test("VAL-PICKER-RENDER-004: bars use █░ and space toggles all criteria", () => {
    const picker = makePicker();
    let lines = picker.render(160);
    expect(lines.some((line) => line.includes("▰") || line.includes("▱"))).toBe(false);
    expect(lines.join("\n")).toContain("█");
    expect(lines.join("\n")).toContain("░");
    expect(lines.join("\n")).not.toMatch(/VAL-A\s\sFirst criterion/);

    picker.handleInput("\t");
    picker.handleInput(" ");
    lines = picker.render(160);
    expect(lines.join("\n")).toMatch(/VAL-A\s\sFirst criterion/);
    expect(lines.join("\n")).toMatch(/VAL-B\s\sSecond criterion/);

    picker.handleInput(" ");
    lines = picker.render(160);
    expect(lines.join("\n")).not.toMatch(/VAL-A\s\sFirst criterion/);
  });

  test("VAL-PICKER-RENDER-005: objective truncation hint and expansion", () => {
    // The right detail pane truncates objectives > 2 lines and shows [o for full];
    // pressing 'o' (with focus right) expands. The left info pane has its own short
    // preview — we scope this assertion to the right detail pane only.
    const rightOf = (lines: string[]): string => lines.map((l) => l.split("\u2502")[2] ?? "").join("\n");

    const one = makePicker({ snapshots: new Map([["alpha", snapshot("alpha", { objective: "one line" })]]) });
    expect(rightOf(one.render(80))).not.toContain("[o for full]");

    const two = makePicker({ snapshots: new Map([["alpha", snapshot("alpha", { objective: "line one\nline two" })]]) });
    expect(rightOf(two.render(80))).not.toContain("[o for full]");

    const long = makePicker({ snapshots: new Map([["alpha", snapshot("alpha", { objective: "line one\nline two\nline three\nline four" })]]) });
    expect(rightOf(long.render(80))).toContain("[o for full]");
    expect(rightOf(long.render(80))).not.toContain("line three");
    long.handleInput("\t");
    long.handleInput("o");
    const expandedRight = rightOf(long.render(80));
    expect(expandedRight).not.toContain("[o for full]");
    expect(expandedRight).toContain("line three");
    expect(expandedRight).toContain("line four");
  });

  test("VAL-PICKER-NAV-001: tab changes focus and j scrolls right pane", () => {
    const picker = makePicker({ height: 8 });
    picker.render(80);
    expect((picker as any).focus).toBe("left");
    picker.handleInput("\t");
    expect((picker as any).focus).toBe("right");
    expect((picker as any).rightScrollLine).toBe(0);
    picker.handleInput("j");
    expect((picker as any).rightScrollLine).toBeGreaterThan(0);
    expect((picker as any).cursorIndex).toBe(0);
  });

  test("VAL-PICKER-NAV-002: banned keys do not mutate rendered output", () => {
    const picker = makePicker();
    for (const key of ["b", "r", "p", "a", "c", "\r", "\n", "\x1b[3~"]) {
      const before = picker.render(120).join("\n");
      picker.handleInput(key);
      const after = picker.render(120).join("\n");
      expect(after).toBe(before);
    }
  });

  test("VAL-PICKER-NAV-003: footer keybind hints embedded in bottom border", () => {
    const lines = makePicker().render(160);
    const bottom = lines.at(-1)!;
    expect(bottom).toContain("tab:focus  j/k:move  esc:close");
    expect(bottom).toContain("tab:focus  j/k:scroll  space:fold  o:objective  esc:close");
  });

  test("VAL-PICKER-WIRE-001: bare /charters opens top-left fullscreen overlay", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-picker-wire-"));
    try {
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
      registerCharterCommands({
        registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> | void }) {
          commands.set(name, opts);
        },
      } as never);
      const customCalls: Array<{ options: any }> = [];
      await commands.get("charters")!.handler("", {
        cwd: projectDir,
        hasUI: true,
        ui: {
          notify: () => undefined,
          custom: async (_factory: unknown, options: unknown) => {
            customCalls.push({ options });
            return null;
          },
        },
        sessionManager: { getSessionId: () => undefined },
      });
      expect(customCalls).toHaveLength(1);
      expect(customCalls[0]!.options.overlay).toBe(true);
      expect(customCalls[0]!.options.overlayOptions.anchor).toBe("top-left");
      expect(customCalls[0]!.options.overlayOptions.width).toBe("100%");
      expect(customCalls[0]!.options.overlayOptions.maxHeight).toBe("100%");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
