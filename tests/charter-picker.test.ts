import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterCommands } from "../src/application/registration";
import type { CharterStatus } from "../src/domain/types";
import { CharterPickerComponent } from "../src/ui/charter-picker";
import { DEFAULT_LEFT_FRACTION, LEFT_PANE_CAP, MIN_LEFT_PANE } from "../src/ui/charter-picker-constants";
import type { CharterListRow, PickerSnapshot } from "../src/ui/picker-snapshot";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function leftWidthFor(width: number): number {
  return Math.max(MIN_LEFT_PANE, Math.min(LEFT_PANE_CAP, Math.round((width - 3) * DEFAULT_LEFT_FRACTION)));
}

function charter(id: string, overrides: Partial<CharterListRow> = {}): CharterListRow {
  return {
    charterId: id,
    name: id,
    status: "active" as CharterStatus,
    passCount: 1,
    totalCount: 3,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
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

describe("CharterPickerComponent rendering and navigation", () => {
  test("renders exact height, width, and divider position", () => {
    const picker = makePicker();
    for (const width of [80, 120, 160]) {
      const lines = picker.render(width);
      expect(lines).toHaveLength(40);
      for (const line of lines) expect(line.length).toBe(width);
      const dividerColumn = 1 + leftWidthFor(width);
      for (const row of lines.slice(1, -1)) expect(row[dividerColumn]).toBe("│");
    }
  });

  test("renders terminal separator, bound marker, and cursor marker", () => {
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

  test("renders right pane sections in order", () => {
    const picker = makePicker();
    const right = picker.render(160).slice(1, -1).map((line) => rightCell(line, 160)).join("\n");
    // Picker renders either "Blocking complete" or "Ready to complete" depending on state.
    const labels = ["Objective", /Blocking complete|Ready to complete/, "Plan", "Recent evidence"];
    let last = -1;
    for (const label of labels) {
      const index = typeof label === "string" ? right.indexOf(label) : right.search(label);
      expect(index).toBeGreaterThan(last);
      last = index;
    }
  });

  test("renders progress bars and space toggles all criteria", () => {
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

  test("renders objective truncation hint and expansion", () => {
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

  test("tab changes focus and j scrolls right pane", () => {
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

  test("banned keys do not mutate rendered output", () => {
    const picker = makePicker();
    for (const key of ["b", "r", "p", "a", "c", "\r", "\n", "\x1b[3~"]) {
      const before = picker.render(120).join("\n");
      picker.handleInput(key);
      const after = picker.render(120).join("\n");
      expect(after).toBe(before);
    }
  });

  test("renders shared and pane-specific keyboard legends", () => {
    const lines = makePicker().render(160);
    const left = lines.slice(1, -1).map((line) => leftCell(line, 160)).join("\n");
    // Shared legend lives as a third section inside the left pane (with a `keys`
    // flatRule divider above it). Only keys that work regardless of focus belong
    // here; pane-specific keys (space/o) live on the right bottom border instead.
    expect(left).toMatch(/── keys ─+/);
    expect(left).toMatch(/j\/k\s+move cursor/);
    expect(left).toMatch(/pgup\/pgdn\s+jump a page/);
    expect(left).toMatch(/g \/ G\s+top \/ end/);
    expect(left).toMatch(/tab\s+switch pane/);
    expect(left).toMatch(/\[ \/ \]\s+resize split/);
    expect(left).toMatch(/s\s+toggle sidebar/);
    expect(left).toMatch(/O\s+open charter dir/);
    expect(left).toMatch(/y\s+copy charterId/);
    expect(left).toMatch(/esc\s+close picker/);
    // Pane-specific keys NOT in the shared legend.
    expect(left).not.toMatch(/space\s+fold/);
    expect(left).not.toMatch(/o\s+toggle objective/);
    // Bottom border: left carries cursor counter; right carries the right-only
    // keybind hint (so the segment is never an empty `dash + spaces + dash` hole).
    const bottom = lines.at(-1)!;
    expect(bottom).toMatch(/1\/3/);
    expect(bottom).toMatch(/space:fold/);
    expect(bottom).toMatch(/o:obj/);
  });

  test("left list hides progress bars and then status under pressure", () => {
    const picker = makePicker();
    const mediumLeft = picker.render(120).slice(1, 4).map((line) => leftCell(line, 120)).join("\n");
    expect(mediumLeft).not.toContain("█");
    expect(mediumLeft).not.toContain("░");
    expect(mediumLeft).toMatch(/active/);

    const tight = makePicker({ charters: [
      charter("done-a", { status: "completed" as CharterStatus, passCount: 10, totalCount: 10 }),
      charter("done-b", { status: "abandoned" as CharterStatus, passCount: 0, totalCount: 1 }),
    ] });
    const tightLeft = tight.render(72).slice(1, 3).map((line) => leftCell(line, 72)).join("\n");
    expect(tightLeft).not.toContain("█");
    expect(tightLeft).not.toContain("░");
    expect(tightLeft).toMatch(/10\/10/);
    expect(tightLeft).not.toMatch(/completed|abandoned/);
  });

  test("arrow keys mirror j/k without legend entries", () => {
    const picker = makePicker({ height: 8 });
    picker.render(80);
    picker.handleInput("\u001b[B");
    expect((picker as any).cursorIndex).toBe(1);
    picker.handleInput("\u001b[A");
    expect((picker as any).cursorIndex).toBe(0);

    picker.handleInput("\t");
    picker.handleInput("\u001b[B");
    expect((picker as any).rightScrollLine).toBeGreaterThan(0);
    picker.handleInput("\u001b[A");
    expect((picker as any).rightScrollLine).toBe(0);

    const left = picker.render(160).slice(1, -1).map((line) => leftCell(line, 160)).join("\n");
    expect(left).not.toMatch(/up|down|arrow/i);
  });

  test("top border stays aligned at minimum left split", () => {
    const picker = makePicker({ charters: [
      charter("depth2-smoke", { status: "abandoned" as CharterStatus, passCount: 0, totalCount: 1 }),
      charter("autobind-smoke", { status: "abandoned" as CharterStatus, passCount: 0, totalCount: 1 }),
      charter("subagent-binding", { status: "completed" as CharterStatus, passCount: 6, totalCount: 6 }),
    ] });
    let lines = picker.render(120);
    for (let i = 0; i < 8; i++) picker.handleInput("[");
    lines = picker.render(120);
    const bodyDivider = lines[1]!.indexOf("│", 1);
    expect(lines[0]!.length).toBe(120);
    expect(lines[0]![bodyDivider]).toBe("┬");
    expect(lines[0]!.slice(1, bodyDivider)).not.toContain("active /");
  });

  test("right pane uses available space for evidence and wraps fields", () => {
    const manyEvidence = Array.from({ length: 8 }, (_, i) => ({
      ts: `2026-05-15T09:${String(10 + i).padStart(2, "0")}:00.000Z`,
      criterionId: `VAL-LONG-${i}`,
      outcome: "pass" as const,
      recordedBy: `subagent:charter-reviewer:session-${i}`,
    }));
    const longCriterion = "A very long criterion title that should wrap instead of disappearing past the right border";
    const picker = makePicker({ snapshots: new Map([["alpha", snapshot("alpha", {
      planTree: [{ milestoneId: "m1", features: [{
        featureId: "f1-long-wrap",
        status: "completed",
        passCount: 1,
        totalCount: 1,
        criteria: [{ criterionId: "VAL-WRAP", titleFromH3: longCriterion, outcome: "pass" }],
      }] }],
      recentEvidence: manyEvidence,
    })]]) });
    picker.handleInput("\t");
    picker.handleInput(" ");
    const right = picker.render(120).slice(1, -1).map((line) => rightCell(line, 120)).join("\n");
    expect(right.match(/VAL-LONG-/g)?.length).toBeGreaterThan(5);
    expect(right).toContain("charter-reviewer:session-0");
    expect(right).toContain("disappearing past");
  });

  test("s collapses and restores the sidebar", () => {
    const picker = makePicker();
    const expanded = picker.render(100);
    const expandedDivider = expanded[1]!.indexOf("│", 1);
    expect(expandedDivider).toBeGreaterThan(1);
    picker.handleInput("s");
    const collapsed = picker.render(100);
    expect(collapsed[1]!.indexOf("│", 1)).toBe(99);
    expect((picker as any).focus).toBe("right");
    picker.handleInput("s");
    const restored = picker.render(100);
    expect(restored[1]!.indexOf("│", 1)).toBe(expandedDivider);
  });

  test("bracket keys resize split using last rendered width", () => {
    const picker = makePicker();
    let lines = picker.render(80);
    const dividerIndex = (rendered: string[]) => rendered[1]!.indexOf("│", 1);
    const initial = dividerIndex(lines);

    picker.handleInput("[");
    lines = picker.render(80);
    expect(dividerIndex(lines)).toBeLessThan(initial);

    picker.handleInput("]");
    lines = picker.render(80);
    expect(dividerIndex(lines)).toBe(initial);

    const wide = makePicker();
    lines = wide.render(160);
    const wideInitial = dividerIndex(lines);
    for (let i = 0; i < 8; i++) wide.handleInput("]");
    lines = wide.render(160);
    expect(dividerIndex(lines)).toBeGreaterThan(wideInitial);
  });

  test("bare /charters opens top-left fullscreen overlay", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-picker-wire-"));
    try {
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
      registerCharterCommands({
        registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> | void }) {
          commands.set(name, opts);
        },
        // Picker opens a short-lived utils client for a fullscreen lease; a
        // no-op event bus keeps it in fallback mode for this wiring test.
        events: { on: () => () => {}, emit: () => {} },
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
