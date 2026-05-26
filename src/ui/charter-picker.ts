import { spawn } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import {
  BANNED_PRINTABLE,
  DEFAULT_LEFT_FRACTION,
  FLASH_TTL_RENDERS,
  LEFT_FOOTER,
  LEFT_PANE_CAP,
  LEFT_ROW_BAR_MIN_NAME_W,
  LEFT_ROW_BAR_W,
  LEFT_ROW_COUNT_W,
  LEFT_ROW_GAP_BAR_COUNT,
  LEFT_ROW_GAP_COUNT_STATUS,
  LEFT_ROW_MIN_NAME_W,
  LEFT_ROW_PREFIX_W,
  LEGEND_ENTRIES,
  LEGEND_KEY_W,
  MIN_LEFT_PANE,
  MIN_RIGHT_PANE,
  PAGE_SIZE,
  RIGHT_FOOTER,
  RIGHT_PANE_HINT,
  SPLIT_STEP_COLS,
  TERMINAL_STATUSES,
} from "./charter-picker-constants";
import type { CharterListRow, PickerSnapshot, PlanCriterionNode, PlanFeatureNode } from "./picker-snapshot";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface PickerHostHooks {
  resolveCharterDir(charterId: string): string;
  openPath?(absPath: string): Promise<void> | void;
  copyText?(text: string): Promise<void> | void;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface CharterPickerOptions {
  charters: CharterListRow[];
  snapshots: Map<string, PickerSnapshot>;
  theme: ThemeLike;
  heightProvider: () => number;
  initialCursorCharterId?: string;
  boundCharterId: string | null;
  onDone: (result: null) => void;
  host?: PickerHostHooks;
}

export class CharterPickerComponent implements Component {
  private readonly charters: CharterListRow[];
  private readonly snapshots: Map<string, PickerSnapshot>;
  private readonly theme: ThemeLike;
  private readonly heightProvider: () => number;
  private readonly boundCharterId: string | null;
  private readonly onDone: (result: null) => void;
  private readonly host: PickerHostHooks | undefined;
  private cursorIndex = 0;
  private focus: "left" | "right" = "left";
  private allExpanded = false;
  private objectiveExpanded = false;
  private rightScrollLine = 0;
  private splitFraction = DEFAULT_LEFT_FRACTION;
  private sidebarCollapsed = false;
  private finished = false;
  private lastRightMaxScroll = 0;
  private lastRenderWidth = 120;
  private flashMessage: { text: string; kind: "info" | "warning" | "error"; rendersLeft: number } | null = null;

  constructor(opts: CharterPickerOptions) {
    this.charters = opts.charters;
    this.snapshots = opts.snapshots;
    this.theme = opts.theme;
    this.heightProvider = opts.heightProvider;
    this.boundCharterId = opts.boundCharterId;
    this.onDone = opts.onDone;
    this.host = opts.host;
    const initial = opts.initialCursorCharterId
      ? this.charters.findIndex((row) => row.charterId === opts.initialCursorCharterId)
      : -1;
    this.cursorIndex = initial >= 0 ? initial : 0;
    this.clampCursor();
  }

  render(width: number): string[] {
    const totalWidth = Math.max(3, Math.floor(width));
    this.lastRenderWidth = totalWidth;
    const height = Math.max(2, Math.floor(this.heightProvider()));
    const bodyHeight = Math.max(0, height - 2);
    const cursor = this.charters[this.cursorIndex];
    const snapshot = cursor ? this.snapshots.get(cursor.charterId) : undefined;

    if (this.sidebarCollapsed) {
      const rightWidth = Math.max(1, totalWidth - 2);
      const rightContent = this.buildRightPane(rightWidth, bodyHeight);
      this.lastRightMaxScroll = Math.max(0, rightContent.length - bodyHeight);
      this.rightScrollLine = clamp(this.rightScrollLine, 0, this.lastRightMaxScroll);
      const rightVisible = rightContent.slice(this.rightScrollLine, this.rightScrollLine + bodyHeight);
      const rows: string[] = [this.singleTopBorder(rightWidth, snapshot)];
      for (let i = 0; i < bodyHeight; i++) rows.push(this.singleBodyRow(rightVisible[i] ?? "", rightWidth));
      rows.push(this.singleBottomBorder(rightWidth));
      return rows.map((line) => padRight(line, totalWidth));
    }

    const interiorWidth = Math.max(0, totalWidth - 3);
    const leftWidth = this.computeLeftWidth(totalWidth);
    const rightWidth = Math.max(0, interiorWidth - leftWidth);
    // Top + bottom rows carry titles (widget-style).
    // Left pane has three stacked sections: list (top) / info (middle) / legend
    // (bottom). Each pair is separated by one flatRule divider row. Info and
    // legend size to their actual content so there's no padding gap above the
    // dividers; list absorbs everything else.
    const legendContent = this.buildLegendPane(leftWidth);
    const infoContent = this.buildInfoPane(leftWidth);
    const legendHeight = legendContent.length;
    const infoHeight = clamp(infoContent.length, 3, 14);
    const listHeight = Math.max(1, bodyHeight - infoHeight - legendHeight - 2); // -2 for two dividers

    // Tick down the flash message lifetime once per render.
    if (this.flashMessage) {
      this.flashMessage.rendersLeft -= 1;
      if (this.flashMessage.rendersLeft <= 0) this.flashMessage = null;
    }

    const listContent = this.buildLeftPane(leftWidth);
    const rightContent = this.buildRightPane(rightWidth, bodyHeight);
    this.lastRightMaxScroll = Math.max(0, rightContent.length - bodyHeight);
    this.rightScrollLine = clamp(this.rightScrollLine, 0, this.lastRightMaxScroll);
    const rightVisible = rightContent.slice(this.rightScrollLine, this.rightScrollLine + bodyHeight);

    const rows: string[] = [];
    rows.push(this.topBorder(leftWidth, rightWidth, snapshot));
    const infoDivider = this.color("dim", flatRule("info", leftWidth));
    const legendDivider = this.color("dim", flatRule("keys", leftWidth));
    const infoStart = listHeight + 1; // after list + info-divider
    const legendStart = infoStart + infoHeight + 1; // after info + legend-divider
    for (let i = 0; i < bodyHeight; i++) {
      let left: string;
      if (i < listHeight) {
        left = listContent[i] ?? "";
      } else if (i === listHeight) {
        left = infoDivider;
      } else if (i < legendStart - 1) {
        const infoIdx = i - infoStart;
        left = infoContent[infoIdx] ?? "";
      } else if (i === legendStart - 1) {
        left = legendDivider;
      } else {
        const legendIdx = i - legendStart;
        left = legendContent[legendIdx] ?? "";
      }
      const right = rightVisible[i] ?? "";
      rows.push(this.bodyRow(left, right, leftWidth, rightWidth));
    }
    rows.push(this.bottomBorder(leftWidth, rightWidth));
    return rows.map((line) => padRight(line, totalWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish();
      return;
    }
    if (isBannedKey(data)) return;
    if (matchesKey(data, "tab")) {
      this.focus = this.focus === "left" ? "right" : "left";
      return;
    }
    if (matchesPrintable(data, "j") || matchesKey(data, "down") || data === "\u001b[B") {
      this.moveVertical(1);
      return;
    }
    if (matchesPrintable(data, "k") || matchesKey(data, "up") || data === "\u001b[A") {
      this.moveVertical(-1);
      return;
    }
    if (matchesKey(data, "space") && this.focus === "right") {
      this.allExpanded = !this.allExpanded;
      this.rightScrollLine = 0;
      return;
    }
    if (matchesPrintable(data, "o") && this.focus === "right") {
      this.objectiveExpanded = !this.objectiveExpanded;
      this.rightScrollLine = 0;
      return;
    }
    if (matchesPrintable(data, "s")) {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      if (this.sidebarCollapsed) this.focus = "right";
      return;
    }
    if (matchesPrintable(data, "[")) {
      this.shiftSplit(-1);
      return;
    }
    if (matchesPrintable(data, "]")) {
      this.shiftSplit(1);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      if (this.focus === "left") {
        this.cursorIndex = Math.min(Math.max(0, this.charters.length - 1), this.cursorIndex + PAGE_SIZE);
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = clamp(this.rightScrollLine + PAGE_SIZE, 0, this.lastRightMaxScroll);
      }
      return;
    }
    if (matchesKey(data, "pageUp")) {
      if (this.focus === "left") {
        this.cursorIndex = Math.max(0, this.cursorIndex - PAGE_SIZE);
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = Math.max(0, this.rightScrollLine - PAGE_SIZE);
      }
      return;
    }
    // g / G / O via matchesKey so Kitty CSI-u sequences (where shift+letter does
    // NOT arrive as a raw uppercase character) are recognised. matchesKey("g")
    // matches the raw 'g' char AND the disambiguated kitty sequence; matchesKey(
    // "shift+g") matches both the legacy uppercase 'G' and shift-modified CSI-u.
    if (matchesKey(data, "home") || matchesKey(data, "g")) {
      if (this.focus === "left") {
        this.cursorIndex = 0;
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = 0;
      }
      return;
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      if (this.focus === "left") {
        this.cursorIndex = Math.max(0, this.charters.length - 1);
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = this.lastRightMaxScroll;
      }
      return;
    }
    if (matchesKey(data, "shift+o")) {
      void this.openSelectedDir();
      return;
    }
    if (matchesPrintable(data, "y")) {
      void this.copySelectedCharterId();
      return;
    }
  }

  private get selectedCharter(): CharterListRow | undefined {
    return this.charters[this.cursorIndex];
  }

  private setFlash(text: string, kind: "info" | "warning" | "error" = "info"): void {
    this.flashMessage = { text, kind, rendersLeft: FLASH_TTL_RENDERS };
  }

  private async openSelectedDir(): Promise<void> {
    const row = this.selectedCharter;
    if (!row) {
      this.setFlash("No charter selected", "warning");
      return;
    }
    const host = this.host;
    const path = host?.resolveCharterDir(row.charterId) ?? row.charterId;
    try {
      if (host?.openPath) {
        await host.openPath(path);
      } else {
        defaultOpenPath(path);
      }
      this.setFlash(`Opened → ${path}`, "info");
      host?.notify?.(`Opened ${path}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setFlash(`Failed to open: ${msg}`, "error");
      host?.notify?.(`Failed to open: ${msg}`, "error");
    }
  }

  private async copySelectedCharterId(): Promise<void> {
    const row = this.selectedCharter;
    if (!row) {
      this.setFlash("No charter selected", "warning");
      return;
    }
    const host = this.host;
    try {
      if (host?.copyText) {
        await host.copyText(row.charterId);
      } else {
        await defaultCopyText(row.charterId);
      }
      this.setFlash(`Copied id → ${row.charterId}`, "info");
      host?.notify?.(`Copied charterId ${row.charterId.slice(0, 8)}…`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setFlash(`Copy failed: ${msg}`, "error");
      host?.notify?.(`Copy failed: ${msg}`, "error");
    }
  }

  invalidate(): void {
    // No cached render output.
  }

  private buildLeftPane(width: number): string[] {
    if (width <= 0) return [];
    const nonTerminal = this.charters
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !TERMINAL_STATUSES.has(row.status));
    const terminal = this.charters
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => TERMINAL_STATUSES.has(row.status));
    const lines: string[] = [];
    for (const entry of nonTerminal) lines.push(this.leftRow(entry.row, entry.index, width, false));
    if (terminal.length > 0) lines.push(this.color("dim", flatRule("done", width)));
    for (const entry of terminal) lines.push(this.leftRow(entry.row, entry.index, width, true));
    return lines;
  }

  private buildInfoPane(width: number): string[] {
    if (width <= 0) return [];
    // Flash message takes over the info pane for a few renders so the user gets
    // immediate in-pane feedback on O/y actions (separate from host notify toast).
    if (this.flashMessage) {
      const kindColor: ThemeColorName = this.flashMessage.kind === "error" ? "error" : this.flashMessage.kind === "warning" ? "warning" : "success";
      const wrapped = wrapText(this.flashMessage.text, width);
      return wrapped.map((line) => this.color(kindColor, line));
    }
    const row = this.charters[this.cursorIndex];
    if (!row) return [this.color("dim", "(no selection)")];
    const snapshot = this.snapshots.get(row.charterId);
    const out: string[] = [];
    out.push(this.theme.bold(clipText(row.name, width)));
    const statusBadge = this.color(statusColor(row.status), `[${row.status}]`);
    const passColor = this.passCountColor(row.passCount, row.totalCount);
    const counter = this.color(passColor, `${row.passCount}/${row.totalCount}`);
    out.push(`${statusBadge} ${counter}`);
    // Timestamps: date + HH:MM for created, plus updated (live) or completed/terminated
    // (terminal). Helps distinguish stale active charters at a glance.
    const tsLines = this.formatTimestamps(row);
    for (const line of tsLines) out.push(this.color("dim", clipText(line, width)));
    if (snapshot) {
      const objWidth = Math.max(1, width);
      const wrapped = wrapText(snapshot.objective, objWidth);
      const remaining = Math.max(0, 8 - out.length);
      for (const line of wrapped.slice(0, remaining)) out.push(this.color("muted", line));
      if (wrapped.length > remaining && remaining > 0) {
        out[out.length - 1] = this.color("muted", clipText(`${out[out.length - 1]}…`, objWidth));
      }
    }
    return out;
  }

  private formatTimestamps(row: CharterListRow): string[] {
    const out: string[] = [];
    out.push(`created  ${formatDateTime(row.createdAt)}`);
    const endIso = row.completedAt ?? row.terminatedAt;
    if (endIso) {
      const label = row.completedAt ? "done   " : "ended  ";
      out.push(`${label} ${formatDateTime(endIso)}`);
    } else if (row.updatedAt && row.updatedAt !== row.createdAt) {
      out.push(`updated  ${formatDateTime(row.updatedAt)}`);
    }
    return out;
  }

  private buildLegendPane(width: number): string[] {
    if (width <= 0) return [];
    // Shared legend describes keybinds that apply across both panes (tab toggles
    // focus; the same nav/action keys work everywhere). Aligned two-column format
    // makes it scannable; dim styling keeps it visually quieter than the list above.
    const keyW = Math.min(LEGEND_KEY_W, Math.max(3, width - 4));
    return LEGEND_ENTRIES.map(([key, desc]) => {
      const keyPart = padRight(key, keyW);
      const line = `${keyPart}  ${desc}`;
      return this.color("dim", clipText(line, width));
    });
  }

  private leftRow(row: CharterListRow, index: number, width: number, dim: boolean): string {
    // Fixed-column layout so bars + counters align vertically across rows:
    //   prefix(3)  name(flex,≥6)  bar(8)  ' '  count(7,right-aligned)  '  '  status(rest)
    const isCursor = index === this.cursorIndex;
    const cursorMark = isCursor ? this.color("accent", "►") : " ";
    const boundMark = row.charterId === this.boundCharterId ? this.color("accent", "*") : " ";
    const prefix = `${cursorMark}${boundMark} `;
    const STATUS_W = Math.max(6, Math.min(10, Math.max(...this.charters.map((r) => r.status.length))));
    const countText = `${row.passCount}/${row.totalCount}`;
    const countPadded = countText.padStart(LEFT_ROW_COUNT_W);
    const count = this.color(this.passCountColor(row.passCount, row.totalCount), countPadded);
    const fixedWithBar = LEFT_ROW_PREFIX_W + LEFT_ROW_BAR_W + LEFT_ROW_GAP_BAR_COUNT + LEFT_ROW_COUNT_W + LEFT_ROW_GAP_COUNT_STATUS + STATUS_W;
    const fixedWithoutBar = LEFT_ROW_PREFIX_W + LEFT_ROW_COUNT_W + LEFT_ROW_GAP_COUNT_STATUS + STATUS_W;
    const fixedWithoutStatus = LEFT_ROW_PREFIX_W + LEFT_ROW_COUNT_W;
    const showBar = width - fixedWithBar >= LEFT_ROW_BAR_MIN_NAME_W;
    const showStatus = !showBar && width - fixedWithoutBar >= LEFT_ROW_MIN_NAME_W;
    const nameWidth = Math.max(0, width - (showBar ? fixedWithBar : showStatus ? fixedWithoutBar : fixedWithoutStatus));
    const nameText = row.name.length > nameWidth
      ? clipText(`${row.name.slice(0, Math.max(0, nameWidth - 1))}…`, nameWidth)
      : row.name;
    const namePart = padRight(nameText, nameWidth);
    const styledName = dim ? this.color("dim", namePart) : (isCursor ? this.theme.bold(namePart) : namePart);
    const bar = showBar
      ? dim
        ? this.color("dim", progressBar(row.passCount, row.totalCount, LEFT_ROW_BAR_W))
        : this.coloredBar(row.passCount, row.totalCount, LEFT_ROW_BAR_W)
      : "";
    const barPart = showBar ? `${bar}${" ".repeat(LEFT_ROW_GAP_BAR_COUNT)}` : "";
    const statusPart = showStatus || showBar
      ? `${" ".repeat(LEFT_ROW_GAP_COUNT_STATUS)}${this.color(statusColor(row.status), clipText(row.status, STATUS_W))}`
      : "";
    return clipStyled(`${prefix}${styledName}${barPart}${count}${statusPart}`, width);
  }

  private computeLeftWidth(totalWidth: number): number {
    const interiorWidth = Math.max(0, totalWidth - 3);
    if (interiorWidth <= 0) return 0;
    const raw = Math.round(interiorWidth * this.splitFraction);
    const capped = Math.min(LEFT_PANE_CAP, Math.max(0, interiorWidth - MIN_RIGHT_PANE));
    const maxLeft = capped > 0 ? capped : interiorWidth;
    const minLeft = Math.min(MIN_LEFT_PANE, maxLeft);
    return clamp(raw, minLeft, maxLeft);
  }

  private shiftSplit(direction: -1 | 1): void {
    const totalWidth = this.lastRenderWidth;
    const currentLeft = this.computeLeftWidth(totalWidth);
    const interiorWidth = Math.max(1, totalWidth - 3);
    const targetLeft = currentLeft + (direction * SPLIT_STEP_COLS);
    const next = clamp(targetLeft / interiorWidth, 0.2, 0.7);
    const previous = this.splitFraction;
    this.splitFraction = next;
    if (this.computeLeftWidth(totalWidth) === currentLeft) {
      this.splitFraction = previous;
    }
  }

  private moveVertical(direction: -1 | 1): void {
    if (this.focus === "left") {
      this.cursorIndex = direction > 0
        ? Math.min(Math.max(0, this.charters.length - 1), this.cursorIndex + 1)
        : Math.max(0, this.cursorIndex - 1);
      this.rightScrollLine = 0;
    } else {
      this.rightScrollLine = direction > 0
        ? clamp(this.rightScrollLine + 1, 0, this.lastRightMaxScroll)
        : Math.max(0, this.rightScrollLine - 1);
    }
  }

  private buildRightPane(width: number, bodyHeight: number): string[] {
    if (width <= 0) return [];
    const row = this.charters[this.cursorIndex];
    if (!row) return [this.color("dim", "No charters.")];
    const snapshot = this.snapshots.get(row.charterId);
    if (!snapshot) return [this.color("dim", "No snapshot for this charter.")];

    const lines: string[] = [];
    const sectionHeading = (label: string, color: ThemeColorName = "accent") =>
      this.theme.bold(this.color(color, label));

    // Top: colored progress bar straight under the embedded title.
    lines.push(this.coloredBar(snapshot.header.passCount, snapshot.header.totalCount, Math.max(1, width - 1)));

    // Objective section.
    lines.push("");
    lines.push(sectionHeading("Objective", "warning"));
    const objectiveLines = wrapText(snapshot.objective, Math.max(1, width - 2));
    if (!this.objectiveExpanded && objectiveLines.length > 2) {
      lines.push(...objectiveLines.slice(0, 2).map((line) => `  ${line}`));
      lines.push(this.color("dim", "  [o for full]"));
    } else {
      lines.push(...objectiveLines.map((line) => `  ${line}`));
    }


    // Blocking-complete section.
    // Suppress entirely for terminal charters (completed/abandoned/budget_limited);
    // the section only makes sense for live work. If all VAL pass on a non-terminal
    // charter, surface Ready regardless of any stale blockingForComplete data.
    const isTerminal = snapshot.header.status === "completed" || snapshot.header.status === "abandoned" || snapshot.header.status === "budget_limited";
    if (!isTerminal) {
    lines.push("");
    if (allPass(snapshot)) {
      lines.push(sectionHeading("Ready to complete", "success"));
    } else {
      lines.push(sectionHeading("Blocking complete", "error"));
      const blocking = snapshot.blockingForComplete;
      if (blocking.length === 0) {
        lines.push(this.color("dim", "  No blocking data"));
      } else {
        const MAX_BLOCKING = 5;
        const shown = blocking.slice(0, MAX_BLOCKING);
        for (const item of shown) lines.push(this.color("error", `  • ${item}`));
        if (blocking.length > MAX_BLOCKING) {
          lines.push(this.color("dim", `  … +${blocking.length - MAX_BLOCKING} more`));
        }
      }
    }
    }

    // Plan section.
    lines.push("");
    lines.push(sectionHeading("Plan"));
    for (const milestone of snapshot.planTree) {
      lines.push(`  ${this.theme.bold(this.color("text", milestone.milestoneId))}`);
      for (const feature of milestone.features) {
        lines.push(...this.featureLines(feature, width));
        if (this.allExpanded) {
          for (const criterion of feature.criteria) lines.push(...this.criterionLines(criterion, width));
        }
      }
    }

    // Recent evidence section.
    lines.push("");
    lines.push(sectionHeading("Recent evidence"));
    const remainingRows = Math.max(5, bodyHeight - lines.length - 1);
    const evidenceShown = snapshot.recentEvidence.slice(0, Math.max(5, remainingRows));
    for (const evidence of evidenceShown) lines.push(...this.evidenceLines(evidence, width));
    if (snapshot.recentEvidence.length > evidenceShown.length) {
      lines.push(this.color("dim", `… +${snapshot.recentEvidence.length - evidenceShown.length} more`));
    }
    return lines;
  }

  // Render a progress bar with colored filled portion (success/accent/muted) and dim empty portion.
  private coloredBar(pass: number, total: number, width: number): string {
    const filled = total > 0 ? clamp(Math.floor((pass / total) * width), 0, width) : 0;
    const empty = width - filled;
    const filledColor = this.passCountColor(pass, total);
    return this.color(filledColor, "█".repeat(filled)) + this.color("dim", "░".repeat(empty));
  }

  private featureLines(feature: PlanFeatureNode, width: number): string[] {
    const glyph = feature.status === "completed"
      ? this.color("success", "✓")
      : feature.status === "in_progress"
        ? this.color("accent", "●")
        : this.color("dim", "○");
    const bar = width >= 44 ? `${this.coloredBar(feature.passCount, feature.totalCount, 4)} ` : "";
    const statusWord = this.color(featureStatusColor(feature.status), feature.status);
    const counter = this.color(this.passCountColor(feature.passCount, feature.totalCount), `${feature.passCount}/${feature.totalCount}`);
    return [`    ${glyph} ${feature.featureId.padEnd(12)} ${bar}${counter}  ${statusWord}`];
  }

  private criterionLines(criterion: PlanCriterionNode, width: number): string[] {
    const glyph = criterion.outcome === "pass"
      ? this.color("success", "✓")
      : criterion.outcome === "fail"
        ? this.color("error", "✗")
        : this.color("dim", "○");
    const head = `        ${glyph} ${criterion.criterionId}`;
    if (!criterion.titleFromH3) return [head];
    const titleWidth = Math.max(8, width - visibleWidth(head) - 2);
    const wrapped = wrapText(criterion.titleFromH3, titleWidth);
    return [
      `${head}  ${wrapped[0] ?? ""}`,
      ...wrapped.slice(1).map((line) => `          ${line}`),
    ];
  }

  private evidenceLines(evidence: PickerSnapshot["recentEvidence"][number], width: number): string[] {
    const outcomeColor: ThemeColorName = evidence.outcome === "pass" ? "success" : evidence.outcome === "fail" ? "error" : "warning";
    const outcome = this.color(outcomeColor, evidence.outcome.padEnd(7));
    const prefix = `${this.color("muted", formatTime(evidence.ts))}  ${evidence.criterionId.padEnd(14)}  ${outcome}`;
    const by = compactRecordedBy(evidence.recordedBy);
    const byWidth = Math.max(8, width - visibleWidth(prefix) - 2);
    const wrapped = wrapText(by, byWidth);
    return [
      `${prefix}  ${this.color("dim", wrapped[0] ?? "")}`,
      ...wrapped.slice(1).map((line) => this.color("dim", `                            ${line}`)),
    ];
  }

  private topBorder(leftWidth: number, rightWidth: number, snapshot: PickerSnapshot | undefined): string {
    const activeCount = this.charters.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;
    const totalCount = this.charters.length;
    const leftTail = activeCount === totalCount ? `${totalCount}` : `${activeCount} active / ${totalCount}`;
    const leftFocused = this.focus === "left";
    const leftSegment = this.titledTopSegment({
      width: leftWidth,
      label: "Charters",
      tail: leftTail,
      labelColor: leftFocused ? "accent" : "text",
      tailColor: "dim",
      labelBold: leftFocused,
    });
    const rightFocused = this.focus === "right";
    let rightSegment: string;
    if (snapshot) {
      const passColor = this.passCountColor(snapshot.header.passCount, snapshot.header.totalCount);
      const tailParts = [
        this.color(statusColor(snapshot.header.status), `[${snapshot.header.status}]`),
        this.color(passColor, `${snapshot.header.passCount}/${snapshot.header.totalCount} VAL`),
        this.color("muted", formatElapsed(snapshot.header.elapsedMs)),
      ];
      const tailPlain = `[${snapshot.header.status}]  ${snapshot.header.passCount}/${snapshot.header.totalCount} VAL  ${formatElapsed(snapshot.header.elapsedMs)}`;
      rightSegment = this.titledTopSegment({
        width: rightWidth,
        label: snapshot.header.name,
        tailRendered: tailParts.join("  "),
        tailPlain,
        labelColor: rightFocused ? "accent" : "text",
        labelBold: rightFocused,
      });
    } else {
      rightSegment = this.titledTopSegment({
        width: rightWidth,
        label: "(no selection)",
        tail: "",
        labelColor: "dim",
        tailColor: "dim",
      });
    }
    const corner = (s: string) => this.color("dim", s);
    return `${corner("╭")}${leftSegment}${corner("┬")}${rightSegment}${corner("╮")}`;
  }

  private singleTopBorder(rightWidth: number, snapshot: PickerSnapshot | undefined): string {
    const label = snapshot?.header.name ?? "(no selection)";
    const corner = (s: string) => this.color("dim", s);
    return `${corner("╭")}${this.titledTopSegment({
      width: rightWidth,
      label,
      labelColor: "accent",
      labelBold: true,
    })}${corner("╮")}`;
  }

  private singleBottomBorder(rightWidth: number): string {
    const hint = this.lastRightMaxScroll > 0
      ? `${RIGHT_PANE_HINT}  ${this.rightScrollLine}/${this.lastRightMaxScroll}`
      : RIGHT_PANE_HINT;
    const corner = (s: string) => this.color("dim", s);
    return `${corner("╰")}${this.titledBottomSegment(rightWidth, hint, true)}${corner("╯")}`;
  }

  private singleBodyRow(right: string, rightWidth: number): string {
    const v = this.color("dim", "│");
    return `${v}${padRight(clipStyled(right, rightWidth), rightWidth)}${v}`;
  }

  private bottomBorder(leftWidth: number, rightWidth: number): string {
    // Left bottom carries only the cursor position (the shared legend covers the
    // keys). Right bottom carries the right-pane-only keybinds plus, when
    // scrollable, the scroll counter — so neither side renders as an empty
    // "hole" between dashes.
    const leftHint = this.charters.length > 0
      ? `${this.cursorIndex + 1}/${this.charters.length}`
      : "";
    const rightHint = this.lastRightMaxScroll > 0
      ? `${RIGHT_PANE_HINT}  ${this.rightScrollLine}/${this.lastRightMaxScroll}`
      : RIGHT_PANE_HINT;
    const leftSegment = this.titledBottomSegment(leftWidth, leftHint, false);
    const rightSegment = this.titledBottomSegment(rightWidth, rightHint, this.focus === "right");
    const corner = (s: string) => this.color("dim", s);
    return `${corner("╰")}${leftSegment}${corner("┴")}${rightSegment}${corner("╯")}`;
  }

  private titledTopSegment(opts: {
    width: number;
    label: string;
    tail?: string;
    tailRendered?: string;
    tailPlain?: string;
    labelColor: ThemeColorName;
    tailColor?: ThemeColorName;
    labelBold?: boolean;
  }): string {
    const width = Math.max(0, opts.width);
    const dash = (n: number) => this.color("dim", "─".repeat(Math.max(0, n)));
    if (width <= 0) return "";
    if (width <= 2) return dash(width);

    const tailPlain = opts.tailPlain ?? opts.tail ?? "";
    const tailRendered = opts.tailRendered ?? (opts.tail !== undefined ? this.color(opts.tailColor ?? "dim", opts.tail) : "");
    const tailLen = visibleWidth(tailPlain);
    const canShowTail = tailLen > 0 && width - tailLen >= 14;
    const labelBudget = Math.max(0, width - (canShowTail ? tailLen + 6 : 4));
    const labelText = clipText(opts.label, labelBudget);
    const labelLen = visibleWidth(labelText);
    if (labelLen === 0) return dash(width);
    const labelStyled = opts.labelBold
      ? this.theme.bold(this.color(opts.labelColor, labelText))
      : this.color(opts.labelColor, labelText);
    if (canShowTail) {
      const fillDashes = Math.max(1, width - labelLen - tailLen - 6);
      return clipStyled(`${dash(1)} ${labelStyled} ${dash(fillDashes)} ${tailRendered} ${dash(1)}`, width);
    }
    const fillDashes = Math.max(1, width - labelLen - 3);
    return clipStyled(`${dash(1)} ${labelStyled} ${dash(fillDashes)}`, width);
  }

  private titledBottomSegment(width: number, hint: string, focused: boolean): string {
    // Borders stay uniformly dim regardless of focus — partial-color borders
    // looked uneven against the side `│` glyphs. Focus tint lives on the hint
    // text itself, and on the top title. Empty-hint segments render solid dashes
    // (no `dash + 2 spaces + dash` hole).
    const dash = (n: number) => this.color("dim", "─".repeat(Math.max(0, n)));
    const hintLen = visibleWidth(hint);
    if (hintLen === 0) return dash(width);
    const hintStyled = focused
      ? this.theme.bold(this.color("accent", hint))
      : this.color("dim", hint);
    const fixedCost = 1 + 1 + hintLen + 1;
    const fillDashes = Math.max(0, width - fixedCost);
    return `${dash(1)} ${hintStyled} ${dash(fillDashes)}`;
  }

  private bodyRow(left: string, right: string, leftWidth: number, rightWidth: number): string {
    // All borders are uniformly dim to match the embedded title dashes + the glance widget.
    const v = this.color("dim", "│");
    const leftCell = padRight(clipStyled(left, leftWidth), leftWidth);
    const rightCell = padRight(clipStyled(right, rightWidth), rightWidth);
    return `${v}${leftCell}${v}${rightCell}${v}`;
  }

  private color(color: ThemeColorName, text: string): string {
    return this.theme.fg(color, text);
  }

  private passCountColor(pass: number, total: number): ThemeColorName {
    if (total === 0) return "dim";
    if (pass === total) return "success";
    if (pass === 0) return "muted";
    return "accent";
  }

  private footerText(text: string, focused: boolean): string {
    return focused ? this.theme.bold(this.color("accent", text)) : this.color("dim", text);
  }

  private clampCursor(): void {
    this.cursorIndex = clamp(this.cursorIndex, 0, Math.max(0, this.charters.length - 1));
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone(null);
  }
}

function isBannedKey(data: string): boolean {
  return [...BANNED_PRINTABLE].some((key) => matchesPrintable(data, key))
    || matchesKey(data, "enter")
    || data === "\r"
    || data === "\n"
    || matchesKey(data, "delete");
}

function matchesPrintable(data: string, key: string, opts?: { exactCase?: boolean }): boolean {
  if (opts?.exactCase) return data === key;
  return data === key || matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

function defaultOpenPath(path: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [path], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* swallow — host notify? was already called by caller path */
  });
  child.unref();
}

function defaultCopyText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
    const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
    child.stdin?.end(text);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function padRight(text: string, width: number): string {
  const clipped = visibleWidth(text) > width ? clipStyled(text, width) : text;
  const pad = Math.max(0, width - visibleWidth(clipped));
  return clipped + " ".repeat(pad);
}

function clipStyled(text: string, width: number): string {
  if (width <= 0) return "";
  if (!text.includes("\u001b[")) return clipText(text, width);
  return truncateToWidth(text, width, "");
}

function clipText(text: string, width: number): string {
  if (width <= 0) return "";
  return Array.from(text).slice(0, width).join("");
}

function titledRule(title: string, width: number, left: string, right: string): string {
  if (width <= 1) return clipText(`${left}${right}`, width);
  const label = `─ ${title} `;
  const middleWidth = Math.max(0, width - 2);
  return `${left}${clipText(label + "─".repeat(middleWidth), middleWidth)}${right}`;
}

// Inline horizontal rule with a label, NO corner/tee glyphs — used inside
// a pane to subdivide sections without faking a second box border.
function flatRule(title: string, width: number): string {
  if (width <= 0) return "";
  const label = ` ${title} `;
  const labelW = visibleWidth(label);
  if (labelW + 4 >= width) return "─".repeat(width);
  const left = "─".repeat(2);
  const right = "─".repeat(Math.max(0, width - labelW - 2));
  return `${left}${label}${right}`;
}

function progressBar(passCount: number, totalCount: number, width: number): string {
  const filled = totalCount > 0 ? Math.floor((passCount / totalCount) * width) : 0;
  const clamped = clamp(filled, 0, width);
  return "█".repeat(clamped) + "░".repeat(width - clamped);
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (visibleWidth(word) > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(clipText(word, width));
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (visibleWidth(next) > width) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

function compactRecordedBy(recordedBy: string): string {
  return recordedBy
    .replace(/^subagent:charter-reviewer:/, "charter-reviewer:")
    .replace(/^subagent:/, "")
    .replace(/^agent:/, "");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

type ThemeColorName = "success" | "warning" | "error" | "accent" | "muted" | "dim" | "text" | "borderAccent" | "borderMuted";

function statusColor(status: CharterStatus): ThemeColorName {
  switch (status) {
    case "active": return "accent";
    case "completed": return "success";
    case "planning": return "muted";
    case "paused": return "warning";
    case "review": return "warning";
    case "abandoned": return "error";
    case "budget_limited": return "error";
    default: return "dim";
  }
}

function featureStatusColor(status: "completed" | "in_progress" | "pending"): ThemeColorName {
  if (status === "completed") return "success";
  if (status === "in_progress") return "accent";
  return "dim";
}

function verdictColor(verdict: string): ThemeColorName {
  if (verdict === "on_track") return "success";
  if (verdict === "drifting") return "warning";
  if (verdict === "blocked") return "error";
  if (verdict === "done") return "accent";
  return "dim";
}

function allPass(snapshot: PickerSnapshot): boolean {
  return snapshot.header.totalCount > 0 && snapshot.header.passCount === snapshot.header.totalCount;
}

function formatTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

function formatDateTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return "--";
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mi = String(parsed.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export const PICKER_FOOTERS = {
  left: LEFT_FOOTER,
  right: RIGHT_FOOTER,
} as const;
