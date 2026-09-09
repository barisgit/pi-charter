import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
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
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T11:00:00.000Z",
    objective: "Ship a focused picker.",
    doneCount: 1,
    totalCount: 3,
    legacy: false,
    ...overrides,
  };
}

function snapshot(id: string, overrides: Partial<PickerSnapshot> = {}): PickerSnapshot {
  return {
    header: { name: id, status: "active", elapsed: "1h", doneCount: 1, totalCount: 3 },
    objective: "Ship a focused picker render implementation.",
    references: "docs/spec.md",
    scope: "Picker only.",
    phases: [
      { number: 1, title: "Explore", status: "done", body: "Mapped the UI." },
      { number: 2, title: "Build", status: "current", body: "Implement dashboard. [capture](work/dashboard.png)" },
      { number: 3, title: "Verify", status: "upcoming", body: "Capture a recording." },
    ],
    phaseCounts: { done: 1, current: 1, upcoming: 1 },
    legacy: false,
    charterMarkdown: "# Objective\n\nShip a focused picker render implementation.",
    warnings: [],
    ...overrides,
  };
}

interface PickerComponent { render(width: number): string[]; handleInput(data: string): void; dispose(): void }

function makePicker(opts: { charters?: CharterListRow[]; snapshots?: Map<string, PickerSnapshot>; height?: number; boundCharterId?: string | null } = {}): PickerComponent {
  const charters = opts.charters ?? [charter("alpha"), charter("beta")];
  const height = opts.height ?? 30;
  const factory = createCharterPickerOverlay({
    charters,
    snapshots: opts.snapshots ?? new Map(charters.map((row) => [row.charterId, snapshot(row.charterId)])),
    heightProvider: () => height,
    boundCharterId: opts.boundCharterId ?? null,
  });
  return factory(fakeTui(height), theme, {}, () => undefined) as PickerComponent;
}

function rightPane(lines: string[]): string {
  return lines.slice(1, -1).map((row) => {
    const divider = row.indexOf("│", 1);
    return divider > 0 ? row.slice(divider + 1, row.length - 1) : "";
  }).join("\n");
}

describe("createCharterPickerOverlay", () => {
  test("renders exact fullscreen dimensions", () => {
    const lines = makePicker({ height: 24 }).render(100);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
  });

  test("always shows the full Objective with ordered phases, lifecycle, and done/total position", () => {
    const longObjective = [
      "Ship a focused picker render implementation with a long Objective that wraps across several terminal lines.",
      "Preserve every authorized constraint in the dashboard instead of hiding the completion contract behind a preview toggle.",
      "Verify that navigation and scrolling remain available after the complete Objective is rendered.",
    ].join("\n\n");
    const row = charter("alpha");
    const lines = makePicker({
      charters: [row],
      snapshots: new Map([["alpha", snapshot("alpha", { objective: longObjective })]]),
    }).render(90);
    const text = lines.join("\n");
    const detail = rightPane(lines);
    expect(text).toContain("[active]");
    expect(text).toContain("1/3 done");
    expect(detail).toContain("Objective");
    expect(detail).toContain("Preserve every authorized constraint");
    expect(detail).toContain("Verify that navigation and scrolling remain");
    expect(detail).toContain("Phases");
    expect(detail).toContain("2. Build — current");
    expect(detail).toContain("work/dashboard.png");
    expect(detail).not.toContain("[o for full]");
    expect(text).not.toContain("Blocking complete");
    expect(text).not.toContain("Recent status");
  });

  test("shows REPORT.md for live and terminal charters", () => {
    const report = { markdown: "# Outcome\n\n[capture](work/final.png)", firstHeading: "Outcome", links: ["work/final.png"] };
    for (const status of ["active", "completed"] as const) {
      const row = charter(status, { status });
      const text = rightPane(makePicker({ charters: [row], snapshots: new Map([[status, snapshot(status, { header: { ...snapshot(status).header, status }, report })]]) }).render(110));
      expect(text).toContain("REPORT.md");
      expect(text).toContain("work/final.png");
    }
  });

  test("keeps legacy files visible as read-only raw charter content", () => {
    const row = charter("legacy", { status: "completed", legacy: true, doneCount: 0, totalCount: 0 });
    const snap = snapshot("legacy", { legacy: true, phases: [], phaseCounts: { done: 0, current: 0, upcoming: 0 }, charterMarkdown: "# Charter\n\n### C1. Historic criterion" });
    const text = makePicker({ charters: [row], snapshots: new Map([["legacy", snap]]), boundCharterId: "legacy" }).render(110).join("\n");
    expect(text).toContain("Legacy charter · read-only");
    expect(text).toContain("Historic criterion");
    expect(text).not.toContain("* legacy");
  });

  test("shows guard warning and guard-paused reason", () => {
    const warning = rightPane(makePicker({ snapshots: new Map([["alpha", snapshot("alpha", { ralph: { activations: [1], warnedAt: 2, pausedByGuard: true } })]]) , charters: [charter("alpha")] }).render(110));
    expect(warning).toContain("Ralph guard");
    expect(warning).toContain("paused by Ralph guard");
  });

  test("arrow keys navigate between charter details", () => {
    const picker = makePicker();
    expect(picker.render(100).join("\n")).toContain("alpha");
    picker.handleInput("\x1b[B");
    expect(picker.render(100).join("\n")).toContain("beta");
  });

  test("space folds and restores phase details", () => {
    const picker = makePicker({ charters: [charter("alpha")] });
    picker.handleInput("\t");
    expect(rightPane(picker.render(110))).toContain("2. Build — current");
    picker.handleInput(" ");
    expect(rightPane(picker.render(110))).not.toContain("2. Build — current");
  });

  test("bare /charters opens as a focused fullscreen overlay", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-picker-wire-"));
    try {
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
      registerCharterCommands({ registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> | void }) { commands.set(name, opts); }, events: { on: () => () => {}, emit: () => {} } } as never);
      const customCalls: Array<{ options: unknown }> = [];
      await commands.get("charters")!.handler("", { cwd: projectDir, hasUI: true, ui: { notify: () => undefined, custom: async (_factory: unknown, options: unknown) => { customCalls.push({ options }); return null; } }, sessionManager: { getSessionId: () => undefined } });
      expect(customCalls).toHaveLength(1);
      expect(customCalls[0]!.options).toEqual({ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });
});
