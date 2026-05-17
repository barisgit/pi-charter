/**
 * Multi-charter widget renderer.
 *
 * Sibling to widget.ts. Produces a boxed widget with one row per active
 * charter (`<sel-mark><dot> <name>  <status>  <pass>/<total>  <bar>`) plus
 * an optional `+M more` overflow row when the VM caps visible rows.
 *
 * Pure string-in / string[] out: no I/O, no globals, no timers. The host
 * (`registerCharterWidget` in registration.ts) builds the VM via
 * `buildMultiCharterViewModel` and invokes this on every refresh.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import { BAR_GLYPHS } from "./widget";
import type { MultiCharterWidgetVM, PerCharterRowVM } from "./widget-state";

export interface ThemeLike {
  fg(color: string, text: string): string;
}

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

/**
 * Minimum width below which we still render but content gets aggressively
 * truncated. The widget is expected to render at widths 40, 80, 120 without
 * crashing or overflowing the column budget.
 */
const MIN_WIDTH = 20;

/**
 * Render the multi-charter widget. Empty VM returns `[]` so the host can
 * clear the `setWidget` slot.
 */
export function renderMultiCharterWidget(
  vm: MultiCharterWidgetVM,
  theme: ThemeLike,
  width: number,
): string[] {
  if (vm.charters.length === 0) return [];
  const w = Math.max(MIN_WIDTH, width);
  const lines: string[] = [];
  lines.push(renderHeader(w, theme, vm.charters.length));
  for (const row of vm.charters) {
    lines.push(renderRow(row, theme, w));
  }
  if (vm.hiddenCount > 0) {
    lines.push(renderOverflow(vm.hiddenCount, theme, w));
  }
  lines.push(renderFooter(w, theme));
  // Final safety net — truncateToWidth is ANSI-aware.
  return lines.map((line) => truncateToWidth(line, w));
}

function renderHeader(width: number, theme: ThemeLike, count: number): string {
  const label = ` Charters (${count} active) `;
  const border = (s: string) => theme.fg("dim", s);
  // Visible budget: 2 corners + 1 leading dash + label + N dashes + 1 trailing dash = width.
  const dashCount = Math.max(1, width - label.length - 4);
  const leftDash = border(BORDER.horizontal);
  const rightDash = border(BORDER.horizontal.repeat(dashCount));
  const labelStyled = theme.fg("accent", label);
  return `${border(BORDER.topLeft)}${leftDash}${labelStyled}${rightDash}${border(BORDER.horizontal)}${border(BORDER.topRight)}`;
}

function renderFooter(width: number, theme: ThemeLike): string {
  const border = (s: string) => theme.fg("dim", s);
  const inner = border(BORDER.horizontal.repeat(Math.max(0, width - 2)));
  return `${border(BORDER.bottomLeft)}${inner}${border(BORDER.bottomRight)}`;
}

function renderRow(row: PerCharterRowVM, theme: ThemeLike, width: number): string {
  // Inner capacity = width - 2 borders. We reserve 1 leading + 1 trailing
  // space inside the box, so the variable content gets `width - 4` cols.
  const contentCapacity = Math.max(0, width - 4);

  const selMarkPlain = row.isSelected ? "*" : " ";
  const dotPlain = row.hasLiveSubagent ? "●" : "○";
  const fracPlain = `${row.bar.pass}/${row.bar.total}`;
  const namePlain = row.displayName;
  const statusPlain = row.status;
  const gap = "  ";

  // Plain layout: "<mark><dot> <name>  <status>  <pass>/<total>  <bar>".
  const fixedPlain = `${selMarkPlain}${dotPlain} ${namePlain}${gap}${statusPlain}${gap}${fracPlain}${gap}`;
  const barCells = Math.max(0, contentCapacity - fixedPlain.length);
  const segs = barSegments(barCells, row.bar);

  const selMark = row.isSelected ? theme.fg("accent", "*") : " ";
  const dot = row.hasLiveSubagent ? theme.fg("accent", "●") : theme.fg("dim", "○");
  const name = row.isSelected ? theme.fg("accent", namePlain) : namePlain;
  const status = theme.fg(statusColor(row.status), statusPlain);
  const frac = theme.fg("dim", fracPlain);
  const bar = `${theme.fg("success", BAR_GLYPHS.pass.repeat(segs.pass))}${theme.fg("accent", BAR_GLYPHS.running.repeat(segs.running))}${theme.fg("dim", BAR_GLYPHS.pending.repeat(segs.pending))}`;

  const styled = `${selMark}${dot} ${name}${gap}${status}${gap}${frac}${gap}${bar}`;
  const styledPlainLen = fixedPlain.length + barCells;
  return wrapInBox(styled, styledPlainLen, width, theme);
}

function renderOverflow(hiddenCount: number, theme: ThemeLike, width: number): string {
  const text = `+${hiddenCount} more`;
  const inner = ` ${theme.fg("dim", text)}`;
  // visible len = 1 leading space + text length
  return wrapInBox(inner, 1 + text.length, width, theme);
}

function wrapInBox(innerText: string, visibleLen: number, width: number, theme: ThemeLike): string {
  // innerText already includes the visible content for the slot inside the
  // borders; we pad with spaces (and truncate if it would overflow) so the
  // closing border lands exactly at column `width - 1`.
  const innerCapacity = Math.max(0, width - 2);
  const v = theme.fg("dim", BORDER.vertical);
  if (visibleLen <= innerCapacity) {
    const padCount = innerCapacity - visibleLen;
    return `${v}${innerText}${" ".repeat(padCount)}${v}`;
  }
  // Defensive: visible content longer than capacity. truncateToWidth is
  // ANSI-aware so styled segments survive the cut.
  return `${v}${truncateToWidth(innerText, innerCapacity, "", true)}${v}`;
}

function barSegments(width: number, bar: PerCharterRowVM["bar"]): { pass: number; running: number; pending: number } {
  if (width <= 0) return { pass: 0, running: 0, pending: 0 };
  if (bar.total <= 0) return { pass: 0, running: 0, pending: width };
  const pass = Math.round((bar.pass / bar.total) * width);
  const running = Math.round((bar.running / bar.total) * width);
  let p = Math.min(pass, width);
  let r = Math.min(running, width - p);
  const pending = Math.max(0, width - p - r);
  if (bar.running > 0 && r === 0 && pending > 0) {
    r = 1;
    return { pass: p, running: r, pending: pending - 1 };
  }
  return { pass: p, running: r, pending };
}

function statusColor(status: CharterStatus): string {
  if (status === "completed") return "success";
  if (status === "abandoned") return "error";
  if (status === "paused" || status === "budget_limited") return "warning";
  if (status === "planning") return "warning";
  return "accent";
}
