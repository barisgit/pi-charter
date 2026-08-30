import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterCommands } from "../src/application/registration";
import type { CharterStatus } from "../src/domain/types";
import { createCharterPickerOverlay } from "../src/ui/charter-picker";
import type { CharterListRow, PickerSnapshot } from "../src/ui/picker-snapshot";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const fakeTui = (rows: number) => ({ terminal: { rows }, requestRender() {} });

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
    references: "docs/spec.md",
    scope: "In: picker. Out: unrelated commands.",
    blockingForComplete: [],
    plan: {
      status: "in_progress",
      passCount: 1,
      totalCount: 2,
      criteria: [
        { criterionId: "C1", titleFromH3: "First criterion", body: "First body.", depends: [], status: "pass", note: "checked", stale: false },
        { criterionId: "C2", titleFromH3: "Second criterion", body: "Second body.", depends: ["C1"], status: "pending", note: "", stale: false },
      ],
    },
    recentStatus: [
      { ts: "2026-05-15T09:10:00.000Z", criterionId: "C1", status: "pass", note: "tester" },
    ],
    ...overrides,
  };
}

interface PickerComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose(): void;
}

function makePicker(opts: {
  charters?: CharterListRow[];
  snapshots?: Map<string, PickerSnapshot>;
  height?: number;
  initialCursorCharterId?: string;
  boundCharterId?: string | null;
} = {}): PickerComponent {
  const charters = opts.charters ?? [charter("alpha"), charter("beta"), charter("gamma")];
  const height = opts.height ?? 40;
  const factory = createCharterPickerOverlay({
    charters,
    snapshots: opts.snapshots ?? new Map(charters.map((row) => [row.charterId, snapshot(row.charterId)])),
    heightProvider: () => height,
    ...(opts.initialCursorCharterId !== undefined ? { initialCursorCharterId: opts.initialCursorCharterId } : {}),
    boundCharterId: opts.boundCharterId ?? null,
  });
  return factory(fakeTui(height), theme, {}, () => undefined) as PickerComponent;
}

// Split the left/right interior of a rendered body row at the divider column.
function leftCell(row: string): string {
  const divider = row.indexOf("│", 1);
  return divider > 0 ? row.slice(1, divider) : row.slice(1);
}

function rightCell(row: string): string {
  const divider = row.indexOf("│", 1);
  return divider > 0 ? row.slice(divider + 1, row.length - 1) : "";
}

function rightPane(lines: string[]): string {
  return lines.slice(1, -1).map(rightCell).join("\n");
}

describe("createCharterPickerOverlay rendering and navigation", () => {
  test("renders exact height, width, and divider position", () => {
    const picker = makePicker();
    for (const width of [80, 120, 160]) {
      const lines = picker.render(width);
      // paneOverlay renders bodyHeight + 2 borders; bodyHeight = height - 2.
      expect(lines).toHaveLength(40);
      for (const line of lines) expect(line.length).toBe(width);
      // The divider column is consistent across all body rows.
      const dividerColumn = lines[1]!.indexOf("│", 1);
      for (const row of lines.slice(2, -1)) expect(row[dividerColumn]).toBe("│");
    }
  });

  test("does not crash when a snapshot name is not a string (corrupt state.json)", () => {
    // A non-string label reaches pi-tui's truncateToWidth and hard-crashes pi
    // (text.slice is not a function). The detail title must coerce to string.
    const bad = snapshot("alpha", { header: { name: 12345 as unknown as string, status: "active" as CharterStatus, elapsedMs: 1000, passCount: 1, totalCount: 2 } });
    const picker = makePicker({ snapshots: new Map([["alpha", bad]]) });
    expect(() => picker.render(120)).not.toThrow();
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
    const left = picker.render(120).slice(1, -1).map(leftCell).join("\n");
    expect(left).toMatch(/─ done ─+/);
    expect(left.split("\n").find((line) => line.includes("bound"))).toContain("*");
    expect(left.split("\n").find((line) => line.includes("cursor"))).toContain("►");
  });

  test("renders right pane sections in order", () => {
    const picker = makePicker();
    const right = rightPane(picker.render(160));
    // Picker renders either "Blocking complete" or "Ready to complete" depending on state.
    const labels = ["Objective", /Blocking complete|Ready to complete/, "Criteria", "Recent status"];
    let last = -1;
    for (const label of labels) {
      const index = typeof label === "string" ? right.indexOf(label) : right.search(label);
      expect(index).toBeGreaterThan(last);
      last = index;
    }
  });

  test("terminal charter with REPORT.md renders report inline after the live panes", () => {
    const done = charter("done", { status: "completed" as CharterStatus, passCount: 2, totalCount: 2 });
    const picker = makePicker({
      charters: [done],
      snapshots: new Map([["done", snapshot("done", {
        header: { name: "done", status: "completed" as CharterStatus, elapsedMs: 120_000, passCount: 2, totalCount: 2 },
        report: { markdown: "# Final report\n\n## Evidence\n\n- work/output.txt" },
      })]]),
    });

    const right = rightPane(picker.render(160));
    expect(right).toContain("Objective");
    expect(right).toContain("REPORT.md");
    expect(right).toContain("# Final report");
    expect(right).toContain("## Evidence");
    expect(right).toContain("work/output.txt");
    // Inline: the regular panes stay visible above the report.
    expect(right).toContain("Recent status");
    expect(right).toContain("Criteria");
    expect(right).toContain("docs/spec.md");
    expect(right).toContain("In: picker. Out: unrelated commands.");
    expect(right).toContain("First body.");
    expect(right).toContain("Note: checked");
    // Report renders after the live panes.
    expect(right.indexOf("REPORT.md")).toBeGreaterThan(right.indexOf("Recent status"));
  });

  test("terminal charter without REPORT.md falls back to live-work panes", () => {
    const done = charter("done", { status: "completed" as CharterStatus, passCount: 2, totalCount: 2 });
    const picker = makePicker({
      charters: [done],
      snapshots: new Map([["done", snapshot("done", {
        header: { name: "done", status: "completed" as CharterStatus, elapsedMs: 120_000, passCount: 2, totalCount: 2 },
      })]]),
    });

    const right = rightPane(picker.render(160));
    expect(right).toContain("Objective");
    expect(right).toMatch(/Criteria\s+1\/2/);
    expect(right).toContain("Recent status");
    expect(right).not.toContain("REPORT.md");
  });

  test("active charter with scaffolded REPORT.md shows hint but not report", () => {
    const picker = makePicker({
      snapshots: new Map([["alpha", snapshot("alpha", {
        report: { markdown: "# Draft report\n\n## Evidence\n\n- work/output.txt" },
      })]]),
    });

    const right = rightPane(picker.render(160));
    expect(right).toContain("REPORT.md scaffolded — fill before complete");
    expect(right).toContain("Criteria");
    expect(right).toContain("Recent status");
    expect(right).not.toContain("# Draft report");
    expect(right).not.toContain("## Evidence");
  });

  test("renders flat plan criteria and space folds them", () => {
    const picker = makePicker();
    let lines = picker.render(160);
    expect(lines.join("\n")).toContain("█");
    expect(lines.join("\n")).toContain("░");
    expect(lines.join("\n")).toMatch(/Criteria\s+1\/2\s+in_progress/);
    expect(lines.join("\n")).toMatch(/C1 \[pass\]\s\sFirst criterion/);
    expect(lines.join("\n")).toMatch(/C2 \[pending\]\s\sSecond criterion\s+← C1/);
    const criterionRows = rightPane(lines).split("\n").filter((line) => /[✓○] C[12] /.test(line));
    expect(criterionRows).toHaveLength(2);
    expect(criterionRows.every((line) => /^[✓○] C[12] /.test(line))).toBe(true);
    expect(rightPane(lines).split("\n").find((line) => line.includes("First body."))).toStartWith("  First body.");
    expect(lines.join("\n")).not.toContain("VAL");
    expect(lines.join("\n")).not.toContain("f1-render");
    expect(lines.join("\n")).not.toContain("m1");

    // space folds criteria only when the detail pane has focus.
    picker.handleInput("\t");
    picker.handleInput(" ");
    lines = picker.render(160);
    expect(lines.join("\n")).not.toMatch(/C1 \[pass\]\s\sFirst criterion/);

    picker.handleInput(" ");
    lines = picker.render(160);
    expect(lines.join("\n")).toMatch(/C1 \[pass\]\s\sFirst criterion/);
  });

  test("renders objective truncation hint and expansion", () => {
    // The right detail pane truncates objectives > 2 lines and shows [o for full];
    // pressing 'o' (with detail focus) expands. The left info pane has its own
    // short preview — scope this assertion to the right detail pane only.
    const rightOf = (lines: string[]): string => lines.slice(1, -1).map(rightCell).join("\n");

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

  test("tab changes focus and j scrolls the detail pane", () => {
    const picker = makePicker({ height: 8 });
    const detailRow0 = (lines: string[]) => rightCell(lines[1]!);
    const before = detailRow0(picker.render(80));
    picker.handleInput("\t");
    picker.handleInput("j");
    // With detail focus, j scrolls the detail pane: its first visible row changes.
    expect(detailRow0(picker.render(80))).not.toBe(before);
  });

  test("a newly selected charter opens its detail at the top (no mid-scroll bleed)", () => {
    // Give each charter a tall detail pane so it can be scrolled. alpha and beta
    // share the same structure, so a fresh detail's row 0 is identical.
    const tall = (id: string) => snapshot(id, {
      objective: Array.from({ length: 12 }, (_, i) => `${id} objective line ${i}`).join("\n"),
    });
    const charters = [charter("alpha"), charter("beta")];
    const picker = makePicker({
      height: 8,
      charters,
      snapshots: new Map(charters.map((r) => [r.charterId, tall(r.charterId)])),
    });
    const detailRow0 = (lines: string[]) => rightCell(lines[1]!);
    const freshTop = detailRow0(picker.render(80));
    // Scroll alpha's detail down.
    picker.handleInput("\t");
    picker.handleInput("j");
    picker.handleInput("j");
    expect(detailRow0(picker.render(80))).not.toBe(freshTop);
    // Switch to beta: its detail must open at the top, not inherit alpha's scroll.
    picker.handleInput("\t"); // back to list focus
    picker.handleInput("j"); // select beta
    const selectedTop = detailRow0(picker.render(80));
    // The final cell may contain pi-extension-utils' transient scrollbar thumb.
    expect(selectedTop.slice(0, -1)).toBe(freshTop.slice(0, -1));
  });

  test("overlay height tracks live terminal rows on resize", () => {
    let rows = 40;
    const liveTui = { terminal: { get rows() { return rows; } }, requestRender() {} };
    const charters = [charter("alpha"), charter("beta")];
    const factory = createCharterPickerOverlay({
      charters,
      snapshots: new Map(charters.map((r) => [r.charterId, snapshot(r.charterId)])),
      heightProvider: () => 24,
      boundCharterId: null,
    });
    const picker = factory(liveTui, theme, {}, () => undefined) as PickerComponent;
    expect(picker.render(80)).toHaveLength(40);
    rows = 20;
    expect(picker.render(80)).toHaveLength(20);
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

  test("renders the auto-derived legend as a third left-pane zone", () => {
    const lines = makePicker().render(160);
    const left = lines.slice(1, -1).map(leftCell).join("\n");
    // The legend is auto-derived by paneOverlay from nav keys + customActions and
    // stacked as the left pane's third zone. Its divider label is the collapse
    // label ("sidebar"); the picker also surfaces an "info" zone above it.
    expect(left).toMatch(/─ info ─+/);
    expect(left).toMatch(/─ sidebar ─+/);
    expect(left).toMatch(/tab\/←\/→\s+focus/);
    expect(left).toMatch(/j\/k\s+select/);
    expect(left).toMatch(/u\/d\s+half-page/);
    expect(left).toMatch(/g\/G\s+top\/bottom/);
    expect(left).toMatch(/\[\/\]\s+resize/);
    expect(left).toMatch(/s\s+sidebar/);
    // The open-dir / copy-id custom actions stay in the legend (O and y).
    expect(left).toMatch(/shift\+o\s+open dir/);
    expect(left).toMatch(/y\s+copy id/);
    expect(left).toMatch(/q\/esc\s+close/);
    // Detail-only toggles (space/o) are hidden from the legend.
    expect(left).not.toMatch(/space\s+fold/);
    expect(left).not.toMatch(/\bo\s+obj/);
  });

  test("left list hides progress bars and then status under pressure", () => {
    const picker = makePicker();
    const mediumLeft = picker.render(120).slice(1, 4).map(leftCell).join("\n");
    expect(mediumLeft).not.toContain("█");
    expect(mediumLeft).not.toContain("░");
    expect(mediumLeft).toMatch(/active/);

    const tight = makePicker({ charters: [
      charter("done-a", { status: "completed" as CharterStatus, passCount: 10, totalCount: 10 }),
      charter("done-b", { status: "abandoned" as CharterStatus, passCount: 0, totalCount: 1 }),
    ] });
    const tightLeft = tight.render(72).slice(1, 4).map(leftCell).join("\n");
    expect(tightLeft).not.toContain("█");
    expect(tightLeft).not.toContain("░");
    expect(tightLeft).toMatch(/10\/10/);
    expect(tightLeft).not.toMatch(/completed|abandoned/);
  });

  test("arrow keys mirror j/k", () => {
    const picker = makePicker();
    const cursorRow = (lines: string[]) => lines.slice(1, -1).map(leftCell).find((l) => l.includes("►")) ?? "";
    expect(cursorRow(picker.render(80))).toContain("alpha");
    picker.handleInput("\u001b[B");
    expect(cursorRow(picker.render(80))).toContain("beta");
    picker.handleInput("\u001b[A");
    expect(cursorRow(picker.render(80))).toContain("alpha");
  });

  test("right pane uses available space for status updates and wraps fields", () => {
    const manyStatus = Array.from({ length: 8 }, (_, i) => ({
      ts: `2026-05-15T09:${String(10 + i).padStart(2, "0")}:00.000Z`,
      criterionId: `C${i + 10}`,
      status: "pass" as const,
      note: `subagent:charter-reviewer:session-${i}`,
    }));
    const longCriterion = "A very long criterion title that should wrap instead of disappearing past the right border";
    const picker = makePicker({ snapshots: new Map([["alpha", snapshot("alpha", {
      plan: {
        status: "completed",
        passCount: 1,
        totalCount: 1,
        criteria: [{ criterionId: "C99", titleFromH3: longCriterion, body: "Detailed behavior remains visible.", depends: [], status: "pass", note: "checked", stale: false }],
      },
      recentStatus: manyStatus,
    })]]) });
    picker.handleInput("\t");
    const right = picker.render(120).slice(1, -1).map(rightCell).join("\n");
    expect(right.match(/C\d+/g)?.length).toBeGreaterThan(5);
    expect(right).toContain("charter-reviewer:session-0");
    expect(right).toContain("disappearing past");
  });

  test("s collapses and restores the sidebar", () => {
    const picker = makePicker();
    const dividerIndex = (rendered: string[]) => rendered[1]!.indexOf("│", 1);
    const expanded = picker.render(100);
    const expandedDivider = dividerIndex(expanded);
    expect(expandedDivider).toBeGreaterThan(1);
    picker.handleInput("s");
    const collapsed = picker.render(100);
    expect(dividerIndex(collapsed)).toBe(99);
    picker.handleInput("s");
    expect(dividerIndex(picker.render(100))).toBe(expandedDivider);
  });

  test("bracket keys resize split using last rendered width", () => {
    const picker = makePicker();
    const dividerIndex = (rendered: string[]) => rendered[1]!.indexOf("│", 1);
    const initial = dividerIndex(picker.render(80));

    picker.handleInput("[");
    expect(dividerIndex(picker.render(80))).toBeLessThan(initial);

    picker.handleInput("]");
    expect(dividerIndex(picker.render(80))).toBe(initial);

    const wide = makePicker();
    const wideInitial = dividerIndex(wide.render(160));
    for (let i = 0; i < 8; i++) wide.handleInput("]");
    expect(dividerIndex(wide.render(160))).toBeGreaterThan(wideInitial);
  });

  test("bare /charters opens as a focused fullscreen overlay", async () => {
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
      const customCalls: Array<{ options: unknown }> = [];
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
      expect(customCalls[0]!.options).toEqual({
        overlay: true,
        overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
