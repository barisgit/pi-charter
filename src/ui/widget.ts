/**
 * Charter widget — aboveEditor box that shows charter VAL progress at a glance
 * plus a fixed-height feature list with per-feature VAL beads.
 *
 * Layout, glyphs, and selection rules: see widget-state.ts + the spec landed
 * in m2624. Rendering is pure string composition once the ViewModel is built.
 *
 * Mirrors pi-dag-tasks' visual language (boxed widget, `setWidget(key,
 * factory, { placement: "aboveEditor" })`, `tui.requestRender()` on data
 * change, 120ms animation timer while any subagent is running).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import type { CharterWidgetVM, FeatureRowVM, PlanningStep, PlanningVM, ValState } from "./widget-state";

interface ThemeLike {
  fg(color: string, text: string): string;
}

export interface TuiLike {
  terminal?: { columns?: number };
  requestRender?: () => void;
}

export interface UiLike {
  setWidget(
    key: string,
    content:
      | undefined
      | ((tui: TuiLike, theme: ThemeLike) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export const BAR_GLYPHS = { pass: "█", running: "▓", pending: "░" } as const;
export const BEAD_GLYPHS = { pass: "▰", running: "▰", pending: "▱" } as const;
export const BEAD_MIN_BUDGET = 4;
export const MIN_TERMINAL_WIDTH = 60;
export const BOX_KEY = "pi-charter";

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

export interface RenderOptions {
  width: number;
  theme: ThemeLike;
  frame?: number;
  vm: CharterWidgetVM;
}

export function renderCharterWidget(opts: RenderOptions): string[] {
  const width = Math.max(MIN_TERMINAL_WIDTH, opts.width);
  const displayName = opts.vm.displayName;
  const lines: string[] = [];
  if (opts.vm.isTerminal) {
    const tail = statusLabel(opts.vm.status);
    lines.push(renderHeader(width, displayName, tail, opts.theme, statusColor(opts.vm.status)));
    lines.push(renderBarLine(width, opts.vm.bar, opts.theme));
    lines.push(renderFooter(width, opts.theme));
    return lines.map((line) => truncateToWidth(line, width));
  }
  if (opts.vm.isPlanning && opts.vm.planning) {
    return renderPlanningView({
      width,
      theme: opts.theme,
      displayName,
      elapsedMs: opts.vm.elapsedMs,
      planning: opts.vm.planning,
    });
  }
  const headerTail = formatElapsed(opts.vm.elapsedMs);
  lines.push(renderHeader(width, displayName, headerTail, opts.theme, "accent"));
  lines.push(renderBarLine(width, opts.vm.bar, opts.theme));
  lines.push(renderEmptyBoxLine(width, opts.theme));
  const featureLines = renderFeatureRows({
    width,
    theme: opts.theme,
    rows: opts.vm.rows,
    overflow: opts.vm.overflow,
    frame: opts.frame ?? 0,
  });
  for (const line of featureLines) lines.push(line);
  lines.push(renderFooter(width, opts.theme));
  return lines.map((line) => truncateToWidth(line, width));
}

function statusColor(status: CharterStatus): string {
  if (status === "completed") return "success";
  if (status === "abandoned") return "error";
  if (status === "paused" || status === "budget_limited") return "warning";
  return "accent";
}

/**
 * Planning-phase render: pipeline of 5 steps with state glyphs, inline
 * detail counts, and a next-action hint. No VAL bar (no evidence yet) and no
 * feature rows (the task tracker above the widget already shows them).
 */
function renderPlanningView(opts: {
  width: number;
  theme: ThemeLike;
  displayName: string;
  elapsedMs: number;
  planning: PlanningVM;
}): string[] {
  const { width, theme, displayName, planning } = opts;
  const headerTail = `planning · ${formatElapsed(opts.elapsedMs)}`;
  const lines: string[] = [];
  lines.push(renderHeader(width, displayName, headerTail, theme, "warning"));
  lines.push(renderEmptyBoxLine(width, theme));
  const labelWidth = Math.max(0, ...planning.steps.map((s) => s.label.length));
  for (const step of planning.steps) {
    lines.push(renderPlanningStep(width, theme, step, labelWidth));
  }
  lines.push(renderEmptyBoxLine(width, theme));
  lines.push(renderPlanningNext(width, theme, planning.nextHint));
  lines.push(renderFooter(width, theme));
  return lines.map((line) => truncateToWidth(line, width));
}

function renderPlanningStep(width: number, theme: ThemeLike, step: PlanningStep, labelWidth: number): string {
  const glyphRaw = step.state === "done" ? "✔" : step.state === "partial" ? "◐" : "○";
  const glyphColor = step.state === "done" ? "success" : step.state === "partial" ? "accent" : "dim";
  const glyph = theme.fg(glyphColor, glyphRaw);
  const labelColor = step.state === "pending" ? "dim" : "toolTitle";
  const labelPlain = step.label.padEnd(labelWidth, " ");
  const label = theme.fg(labelColor, labelPlain);
  const detailPlain = step.detail ? `  ${step.detail}` : "";
  const detail = step.detail ? theme.fg("dim", detailPlain) : "";
  // Layout: "  <glyph> <label><detail>"
  const visibleLen = 2 + 1 + 1 + labelWidth + detailPlain.length;
  return wrapInBox(`  ${glyph} ${label}${detail}`, visibleLen, width, theme);
}

function renderPlanningNext(width: number, theme: ThemeLike, hint: string): string {
  const prefix = theme.fg("accent", "Next:");
  const text = theme.fg("dim", hint);
  const plain = `  Next: ${hint}`;
  return wrapInBox(`  ${prefix} ${text}`, plain.length, width, theme);
}

function renderHeader(width: number, displayName: string, tail: string, theme: ThemeLike, nameColor: string): string {
  // ╭─ <displayName> ──── ... ──── <tail> ─╮
  const labelPlain = ` ${displayName} `;
  const tailPlain = ` ${tail} `;
  const innerWidth = width - 2;
  const dashCount = innerWidth - labelPlain.length - tailPlain.length - 2;
  const dashes = theme.fg("dim", BORDER.horizontal.repeat(Math.max(1, dashCount)));
  const border = (s: string) => theme.fg("dim", s);
  const label = ` ${theme.fg(nameColor, displayName)} `;
  const tailColored = ` ${theme.fg(nameColor, tail)} `;
  return `${border(BORDER.topLeft)}${border(BORDER.horizontal)}${label}${dashes}${tailColored}${border(BORDER.horizontal)}${border(BORDER.topRight)}`;
}

function renderFooter(width: number, theme: ThemeLike): string {
  const border = (s: string) => theme.fg("dim", s);
  const inner = border(BORDER.horizontal.repeat(Math.max(0, width - 2)));
  return `${border(BORDER.bottomLeft)}${inner}${border(BORDER.bottomRight)}`;
}

function renderEmptyBoxLine(width: number, theme: ThemeLike): string {
  const padding = " ".repeat(Math.max(0, width - 2));
  const v = theme.fg("dim", BORDER.vertical);
  return `${v}${padding}${v}`;
}

function renderBarLine(width: number, bar: CharterWidgetVM["bar"], theme: ThemeLike): string {
  // " <bar> <tail> "
  const tail = `${bar.pass}/${bar.total}`;
  // box vertical + space on each side
  const innerWidth = width - 2;
  // leading " ", trailing " ", " <tail>" (space before tail)
  const barWidth = innerWidth - 1 /*left pad*/ - 1 /*space before tail*/ - tail.length - 1 /*right pad*/;
  const cleanBarWidth = Math.max(1, barWidth);
  const segs = barSegments(cleanBarWidth, bar);
  const barText = `${theme.fg("success", BAR_GLYPHS.pass.repeat(segs.pass))}${theme.fg("accent", BAR_GLYPHS.running.repeat(segs.running))}${theme.fg("dim", BAR_GLYPHS.pending.repeat(segs.pending))}`;
  const tailBlock = ` ${theme.fg("dim", tail)} `;
  const inner = ` ${barText}${tailBlock}`;
  return wrapInBox(inner, cleanBarWidth + 3 + tail.length, width, theme);
}

function barSegments(width: number, bar: CharterWidgetVM["bar"]): { pass: number; running: number; pending: number } {
  if (bar.total <= 0) return { pass: 0, running: 0, pending: width };
  const pass = Math.round((bar.pass / bar.total) * width);
  const running = Math.round((bar.running / bar.total) * width);
  let p = Math.min(pass, width);
  let r = Math.min(running, width - p);
  const pending = Math.max(0, width - p - r);
  // Guarantee at least one running cell when running>0 fits
  if (bar.running > 0 && r === 0 && pending > 0) {
    r = 1;
    return { pass: p, running: r, pending: pending - 1 };
  }
  return { pass: p, running: r, pending };
}

function wrapInBox(innerText: string, visibleLen: number, width: number, theme: ThemeLike): string {
  // visibleLen is the count of *visible* chars in innerText (excluding ANSI).
  // Add trailing spaces so border aligns at column `width - 1`.
  const innerCapacity = width - 2;
  const padCount = Math.max(0, innerCapacity - visibleLen);
  const v = theme.fg("dim", BORDER.vertical);
  return `${v}${innerText}${" ".repeat(padCount)}${v}`;
}

function renderFeatureRows(opts: {
  width: number;
  theme: ThemeLike;
  rows: FeatureRowVM[];
  overflow: CharterWidgetVM["overflow"];
  frame: number;
}): string[] {
  if (opts.rows.length === 0 && opts.overflow.hidden === 0 && opts.overflow.done === 0) {
    return [];
  }
  const idColumnWidth = Math.max(0, ...opts.rows.map((row) => row.id.length));
  const lines: string[] = [];
  for (const row of opts.rows) {
    lines.push(renderFeatureRow(row, opts.theme, opts.width, idColumnWidth, opts.frame));
  }
  const overflowLine = renderOverflow(opts.overflow, opts.theme, opts.width);
  if (overflowLine) lines.push(overflowLine);
  return lines;
}

function renderFeatureRow(row: FeatureRowVM, theme: ThemeLike, width: number, idColumnWidth: number, frame: number): string {
  const isRunning = row.state === "running";
  const glyphRaw = isRunning ? (SPINNER[frame % SPINNER.length] ?? "●") : row.state === "idle_ready" ? "●" : "○";
  const glyph = isRunning ? theme.fg("accent", glyphRaw)
    : row.state === "idle_ready" ? theme.fg("accent", glyphRaw)
    : theme.fg("dim", glyphRaw);
  const idPlain = row.id.padEnd(idColumnWidth, " ");
  const id = isRunning ? theme.fg("accent", idPlain) : row.state === "idle_blocked" ? theme.fg("dim", idPlain) : idPlain;

  // Right tail (subagent + elapsed) only for running rows.
  let tailPlain = "";
  let tailRendered = "";
  if (isRunning && row.subagentName) {
    const elapsed = row.elapsedMs !== undefined ? formatDuration(row.elapsedMs) : "";
    tailPlain = elapsed ? `${row.subagentName}  ${elapsed}` : row.subagentName;
    tailRendered = elapsed
      ? `${theme.fg("accent", row.subagentName)}  ${theme.fg("dim", elapsed)}`
      : theme.fg("accent", row.subagentName);
  }

  // Bead budget: width - 2 borders - 1 (leading space) - 2 (glyph+space) - idColumnWidth - 3 (spaces around beads) - tailPlain.length - 1 (trailing space)
  const fixedCost = 2 /*borders*/ + 1 /*lead space*/ + 1 /*glyph*/ + 1 /*space*/ + idColumnWidth + 3 /*spaces around beads*/ + tailPlain.length + 1 /*trailing*/;
  const beadBudget = Math.max(0, width - fixedCost);
  const beadResult = renderBeads(row.fulfills.length, row.valStates, beadBudget, theme);
  const beadPlainLen = beadResult.plainLen;

  // Compose: " <glyph> <id>   <beads>   <tail> "
  const innerParts = [` ${glyph} ${id}   ${beadResult.rendered}`];
  if (tailRendered) innerParts.push(`   ${tailRendered}`);
  const visibleLen = 1 + 1 + 1 + idColumnWidth + 3 + beadPlainLen + (tailPlain ? 3 + tailPlain.length : 0);
  return wrapInBox(innerParts.join(""), visibleLen, width, theme);
}

function renderBeads(n: number, valStates: ValState[], budget: number, theme: ThemeLike): { rendered: string; plainLen: number } {
  if (n === 0) return { rendered: "", plainLen: 0 };
  if (budget < BEAD_MIN_BUDGET) {
    const passCount = valStates.filter((s) => s === "pass").length;
    const text = `${passCount}/${n}`;
    return { rendered: theme.fg("dim", text), plainLen: text.length };
  }
  if (budget >= n) {
    // Full row: one glyph per VAL.
    const rendered = valStates.map((state) => glyphForState(state, theme)).join("");
    return { rendered, plainLen: n };
  }
  // Compressed: pack ceil(n/budget) VALs per bead. Bucket = worst-state-wins.
  const perBead = Math.ceil(n / budget);
  const beadCount = Math.ceil(n / perBead);
  const beads: string[] = [];
  for (let i = 0; i < beadCount; i++) {
    const slice = valStates.slice(i * perBead, (i + 1) * perBead);
    beads.push(glyphForState(bucketState(slice), theme));
  }
  const passCount = valStates.filter((s) => s === "pass").length;
  const fraction = ` ${passCount}/${n}`;
  return { rendered: `${beads.join("")}${theme.fg("dim", fraction)}`, plainLen: beadCount + fraction.length };
}

function bucketState(slice: ValState[]): ValState {
  if (slice.some((s) => s === "pending")) return "pending";
  if (slice.some((s) => s === "running")) return "running";
  return "pass";
}

function glyphForState(state: ValState, theme: ThemeLike): string {
  if (state === "pass") return theme.fg("success", BEAD_GLYPHS.pass);
  if (state === "running") return theme.fg("accent", BEAD_GLYPHS.running);
  return theme.fg("dim", BEAD_GLYPHS.pending);
}

function renderOverflow(overflow: CharterWidgetVM["overflow"], theme: ThemeLike, width: number): string | undefined {
  if (overflow.hidden === 0 && overflow.done === 0) return undefined;
  const parts: string[] = [];
  if (overflow.hidden > 0) parts.push(`+${overflow.hidden} more`);
  if (overflow.done > 0) parts.push(`· ${overflow.done} done`);
  const plain = parts.join(" ");
  const inner = ` ${theme.fg("dim", plain)}`;
  return wrapInBox(inner, 1 + plain.length, width, theme);
}

function statusLabel(status: CharterStatus): string {
  return status;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rem.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin.toString().padStart(2, "0")}m`;
}

function formatDuration(ms: number): string {
  return formatElapsed(ms);
}

/**
 * Stateful host wrapper. Construction owns:
 *  - the latest ViewModel snapshot (set via `update(vm)`),
 *  - the spinner frame counter + 120ms timer while any row is running,
 *  - the registered `setWidget` factory.
 *
 * Wiring lives in registration.ts; consumers push VMs in and call `dispose()`
 * on unbind.
 */
export class CharterWidget {
  private ui?: UiLike;
  private vm?: CharterWidgetVM;
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private tui?: TuiLike;
  private registered = false;

  setUi(ui: UiLike): void { this.ui = ui; }

  update(vm: CharterWidgetVM): void {
    this.vm = vm;
    if (!this.ui) return;
    if (vm.isTerminal && this.collapseHidesWidget(vm)) {
      // Future: hide widget on long-completed charters. For now, render the
      // collapsed strip — users explicitly asked for the "completed 26/26"
      // tail to remain visible.
    }
    if (this.hasRunning(vm)) this.ensureTimer();
    else this.stopTimer();
    if (!this.registered) {
      this.ui.setWidget(BOX_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: () => {
            const width = tui.terminal?.columns ?? 100;
            this.frame++;
            return renderCharterWidget({ width, theme, frame: this.frame, vm: this.vm! });
          },
          invalidate: () => {},
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender?.();
    }
  }

  dispose(): void {
    this.stopTimer();
    this.ui?.setWidget(BOX_KEY, undefined);
    this.registered = false;
    this.vm = undefined;
  }

  private hasRunning(vm: CharterWidgetVM): boolean {
    return vm.rows.some((row) => row.state === "running");
  }

  private collapseHidesWidget(_vm: CharterWidgetVM): boolean {
    return false;
  }

  private ensureTimer(): void {
    if (!this.interval) this.interval = setInterval(() => this.tui?.requestRender?.(), 120);
  }

  private stopTimer(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}
