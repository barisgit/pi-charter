import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CharterStatusResult } from "../src/application/service";
import { buildCharterWidgetView, renderCharterWidget } from "../src/ui/widget";

const STATUS: CharterStatusResult = {
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

const theme = { fg: (_color: string, text: string) => text };

function line(status: CharterStatusResult, width = 100, ralphRemainingMs?: number): string[] {
  // truncateToWidth closes clipped text with ANSI resets; compare the visible text.
  return renderCharterWidget(buildCharterWidgetView(status, ralphRemainingMs)!, width, theme).map((text) => text.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("charter widget", () => {
  test("is one line with the short name and lifecycle only", () => {
    expect(line(STATUS)).toEqual(["charter ship-runtime · active"]);
    expect(line({ ...STATUS, status: "paused" })).toEqual(["charter ship-runtime · paused"]);
  });

  test("adds Ralph guard state and the imminent countdown only when relevant", () => {
    expect(line({ ...STATUS, ralph: { activations: [1, 2, 3, 4, 5], warnedAt: 5 } })).toEqual(["charter ship-runtime · active · Ralph guard warning"]);
    expect(line({ ...STATUS, status: "paused", ralph: { activations: [], warnedAt: 5, pausedByGuard: true } })).toEqual(["charter ship-runtime · paused by Ralph guard · /charter resume"]);
    expect(line(STATUS, 100, 11_200)).toEqual(["charter ship-runtime · active · Ralph continues in 12s"]);
    expect(line(STATUS, 100, 0)).toEqual(["charter ship-runtime · active"]);
    expect(line({ ...STATUS, status: "paused" }, 100, 5_000)).toEqual(["charter ship-runtime · paused"]);
  });

  test("narrow widths shorten the name before the status", () => {
    expect(line(STATUS, 48, 7_000)).toEqual(["charter ship-r… · active · Ralph continues in 7s"]);
    expect(line(STATUS, 40, 7_000)).toEqual(["active · Ralph continues in 7s"]);
    for (const width of [1, 8, 20, 32, 60, 120]) {
      const lines = line({ ...STATUS, status: "paused", ralph: { activations: [], pausedByGuard: true } }, width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
    }
  });

  test("has no frame, arrows, elapsed clock, Objective or progress", () => {
    const text = line(STATUS, 100, 3_000).join("\n");
    expect(text).not.toMatch(/[╭╮╰╯│─↻█▓░]|\d+[hm] |Ship a resilient|phase|REPORT/i);
  });
});
