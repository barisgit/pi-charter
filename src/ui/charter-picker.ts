/**
 * Master-detail charter picker overlay (VAL-5 / f4-picker-overlay).
 *
 * Renders inside a single `Component.render(width)`: the viewport is split
 * into a left list pane and a right detail pane joined with `│` dividers.
 * Lifted from the pi-subagents `subagents-status.ts` `bodyRow(left, right,
 * leftW, rightW)` pattern — same 2-column layout, same `│<cell>│<cell>│`
 * border, same MIN_LEFT_PANE / MIN_RIGHT_PANE clamps. We intentionally
 * copy-adapt rather than depend on pi-subagents (per f4 plan).
 *
 * Right pane reuses `renderCharterWidget` so the detail view matches the
 * single-charter widget look exactly (header line, VAL bar, feature rows).
 * Each detail line is already padded to its target width by renderCharterWidget,
 * so we drop it straight into the right cell as-is — the outer `│` from
 * `bodyRow` ends up next to the widget's own border, giving nested-box chrome.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { CharterListEntry } from "../application/service";
import { renderCharterWidget } from "./widget";
import type { CharterWidgetVM } from "./widget-state";

interface ThemeLike {
  fg(color: string, text: string): string;
}

const LEFT_PANE_CAP = 50;
const MIN_LEFT_PANE = 20;
const MIN_RIGHT_PANE = 20;

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeDown: "┬",
  teeUp: "┴",
} as const;

export interface CharterPickerOptions {
  charters: CharterListEntry[];
  snapshots: Map<string, CharterWidgetVM>;
  theme: ThemeLike;
  initialSelectedCharterId?: string;
  onDone: (charterId: string | null) => void;
}

/**
 * pi-tui Component. Cursor navigation clamps at the bounds (no wrap), matching
 * the subagents-status behavior. Empty active list renders a one-line "No
 * active charters." message and treats both enter and esc as `onDone(null)`.
 */
export class CharterPickerComponent implements Component {
  private readonly charters: CharterListEntry[];
  private readonly snapshots: Map<string, CharterWidgetVM>;
  private readonly theme: ThemeLike;
  private readonly initialSelectedCharterId?: string;
  private readonly onDone: (charterId: string | null) => void;
  private cursor = 0;
  private finished = false;

  constructor(opts: CharterPickerOptions) {
    this.charters = opts.charters;
    this.snapshots = opts.snapshots;
    this.theme = opts.theme;
    this.initialSelectedCharterId = opts.initialSelectedCharterId;
    this.onDone = opts.onDone;
    this.reconcileSelection();
  }

  /** Auto-select the first row on construction; clamp the cursor on later refreshes. */
  private reconcileSelection(): void {
    if (this.charters.length === 0) {
      this.cursor = 0;
      return;
    }
    this.cursor = Math.max(0, Math.min(this.charters.length - 1, this.cursor));
  }

  render(width: number): string[] {
    const w = Math.max(8, width);
    if (this.charters.length === 0) {
      return renderEmptyBox(w, this.theme);
    }
    // Spec: left ~35% capped at [MIN_LEFT_PANE, LEFT_PANE_CAP]; right takes
    // the remainder, with 3 vertical border columns reserved (`│<L>│<R>│`).
    let leftW = Math.max(MIN_LEFT_PANE, Math.min(LEFT_PANE_CAP, Math.floor(w * 0.35)));
    let rightW = Math.max(MIN_RIGHT_PANE, w - leftW - 3);
    // If both mins can't fit (very narrow terminal), drop the right-pane
    // floor and then the left-pane floor rather than overflow `w`.
    if (leftW + rightW + 3 > w) {
      rightW = Math.max(4, w - leftW - 3);
      if (leftW + rightW + 3 > w) {
        leftW = Math.max(4, w - rightW - 3);
      }
    }

    const leftLines = this.buildLeftPane(leftW);
    const rightLines = this.buildRightPane(rightW);

    const bodyHeight = Math.max(leftLines.length, rightLines.length);
    const rows: string[] = [];
    rows.push(this.renderTopBorder(leftW, rightW));
    for (let i = 0; i < bodyHeight; i++) {
      rows.push(this.bodyRow(leftLines[i] ?? "", rightLines[i] ?? "", leftW, rightW));
    }
    rows.push(this.renderBottomBorder(leftW, rightW));
    return rows;
  }

  private buildLeftPane(width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.charters.length; i++) {
      const entry = this.charters[i]!;
      const isCursor = i === this.cursor;
      const isInitial = this.initialSelectedCharterId !== undefined
        && entry.charterId === this.initialSelectedCharterId;
      const cursorMark = isCursor ? this.theme.fg("accent", "> ") : "  ";
      const selectedMark = isInitial ? this.theme.fg("accent", "*") : " ";
      const namePlain = entry.name;
      const fracPlain = ` ${entry.passCount}/${entry.totalCount}`;
      // Visible plain layout: "<cursor 2><selected 1><space 1><name…><frac>"
      const fixed = 2 + 1 + 1 + fracPlain.length;
      const nameBudget = Math.max(0, width - fixed);
      const nameTrunc = truncateToWidth(namePlain, nameBudget);
      const nameStyled = isCursor ? this.theme.fg("accent", nameTrunc) : nameTrunc;
      const frac = this.theme.fg("dim", fracPlain);
      const line = `${cursorMark}${selectedMark} ${nameStyled}${frac}`;
      lines.push(line);
    }
    return lines;
  }

  private buildRightPane(width: number): string[] {
    const entry = this.charters[this.cursor];
    if (!entry) return [];
    const vm = this.snapshots.get(entry.charterId);
    if (!vm) {
      return [this.theme.fg("dim", truncateToWidth("(no snapshot for this charter)", width))];
    }
    // renderCharterWidget enforces its own MIN_TERMINAL_WIDTH (60). When the
    // right pane is narrower we let it render at 60 and clip per-line; the
    // bodyRow padRight will truncate excess columns. Tests pin widths >=40
    // where rightW ends up ~17-49 cols.
    return renderCharterWidget({ width, theme: this.theme, vm });
  }

  private bodyRow(left: string, right: string, leftW: number, rightW: number): string {
    const v = this.theme.fg("dim", BORDER.vertical);
    return `${v}${padRight(left, leftW)}${v}${padRight(right, rightW)}${v}`;
  }

  private renderTopBorder(leftW: number, rightW: number): string {
    const border = (s: string) => this.theme.fg("dim", s);
    return `${border(BORDER.topLeft)}${border(BORDER.horizontal.repeat(leftW))}${border(BORDER.teeDown)}${border(BORDER.horizontal.repeat(rightW))}${border(BORDER.topRight)}`;
  }

  private renderBottomBorder(leftW: number, rightW: number): string {
    const border = (s: string) => this.theme.fg("dim", s);
    return `${border(BORDER.bottomLeft)}${border(BORDER.horizontal.repeat(leftW))}${border(BORDER.teeUp)}${border(BORDER.horizontal.repeat(rightW))}${border(BORDER.bottomRight)}`;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.fire(null);
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const entry = this.charters[this.cursor];
      this.fire(entry ? entry.charterId : null);
      return;
    }
    if (this.charters.length === 0) return;
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.cursor = Math.min(this.charters.length - 1, this.cursor + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, "g")) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, "shift+g")) {
      this.cursor = this.charters.length - 1;
      return;
    }
  }

  invalidate(): void {
    // No cached state to reset.
  }

  /** Test-only accessor for the current cursor index. */
  getCursorIndex(): number {
    return this.cursor;
  }

  private fire(result: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone(result);
  }
}

function padRight(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - visible);
}

function renderEmptyBox(width: number, theme: ThemeLike): string[] {
  const inner = Math.max(0, width - 2);
  const border = (s: string) => theme.fg("dim", s);
  const top = `${border(BORDER.topLeft)}${border(BORDER.horizontal.repeat(inner))}${border(BORDER.topRight)}`;
  const bottom = `${border(BORDER.bottomLeft)}${border(BORDER.horizontal.repeat(inner))}${border(BORDER.bottomRight)}`;
  const text = "No active charters.";
  const visible = Math.min(text.length, inner);
  const padCount = Math.max(0, inner - visible);
  const v = border(BORDER.vertical);
  const middle = `${v}${theme.fg("dim", truncateToWidth(text, inner))}${" ".repeat(padCount)}${v}`;
  return [top, middle, bottom];
}
