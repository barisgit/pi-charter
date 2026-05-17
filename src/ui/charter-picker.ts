import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import type { CharterListRow, PickerSnapshot, PlanCriterionNode, PlanFeatureNode } from "./picker-snapshot";

interface ThemeLike {
  fg(color: string, text: string): string;
}

export interface CharterPickerOptions {
  charters: CharterListRow[];
  snapshots: Map<string, PickerSnapshot>;
  theme: ThemeLike;
  heightProvider: () => number;
  initialCursorCharterId?: string;
  boundCharterId: string | null;
  onDone: (result: null) => void;
}

const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
  "budget_limited",
]);

const LEFT_FOOTER = "tab:focus  j/k:move  esc:close";
const RIGHT_FOOTER = "tab:focus  j/k:scroll  space:fold  o:objective  esc:close";
const BANNED_PRINTABLE = new Set(["b", "r", "p", "a", "c"]);

export class CharterPickerComponent implements Component {
  private readonly charters: CharterListRow[];
  private readonly snapshots: Map<string, PickerSnapshot>;
  private readonly theme: ThemeLike;
  private readonly heightProvider: () => number;
  private readonly boundCharterId: string | null;
  private readonly onDone: (result: null) => void;
  private cursorIndex = 0;
  private focus: "left" | "right" = "left";
  private allExpanded = false;
  private objectiveExpanded = false;
  private rightScrollLine = 0;
  private finished = false;
  private lastRightMaxScroll = 0;

  constructor(opts: CharterPickerOptions) {
    this.charters = opts.charters;
    this.snapshots = opts.snapshots;
    this.theme = opts.theme;
    this.heightProvider = opts.heightProvider;
    this.boundCharterId = opts.boundCharterId;
    this.onDone = opts.onDone;
    const initial = opts.initialCursorCharterId
      ? this.charters.findIndex((row) => row.charterId === opts.initialCursorCharterId)
      : -1;
    this.cursorIndex = initial >= 0 ? initial : 0;
    this.clampCursor();
  }

  render(width: number): string[] {
    const totalWidth = Math.max(3, Math.floor(width));
    const height = Math.max(2, Math.floor(this.heightProvider()));
    const interiorWidth = Math.max(0, totalWidth - 3);
    let leftWidth = clamp(Math.floor(interiorWidth * 0.32), 28, 50);
    if (leftWidth > interiorWidth) leftWidth = interiorWidth;
    const rightWidth = interiorWidth - leftWidth;
    const bodyHeight = height - 2;
    const contentHeight = Math.max(0, bodyHeight - 1);

    const leftContent = this.buildLeftPane(leftWidth);
    const rightContent = this.buildRightPane(rightWidth);
    this.lastRightMaxScroll = Math.max(0, rightContent.length - contentHeight);
    this.rightScrollLine = clamp(this.rightScrollLine, 0, this.lastRightMaxScroll);
    const rightVisible = rightContent.slice(this.rightScrollLine, this.rightScrollLine + contentHeight);

    const rows = [this.topBorder(leftWidth, rightWidth)];
    for (let i = 0; i < bodyHeight; i++) {
      const isFooter = i === bodyHeight - 1;
      const left = isFooter ? LEFT_FOOTER : (leftContent[i] ?? "");
      const right = isFooter ? RIGHT_FOOTER : (rightVisible[i] ?? "");
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
    if (matchesPrintable(data, "j")) {
      if (this.focus === "left") {
        this.cursorIndex = Math.min(Math.max(0, this.charters.length - 1), this.cursorIndex + 1);
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = clamp(this.rightScrollLine + 1, 0, this.lastRightMaxScroll);
      }
      return;
    }
    if (matchesPrintable(data, "k")) {
      if (this.focus === "left") {
        this.cursorIndex = Math.max(0, this.cursorIndex - 1);
        this.rightScrollLine = 0;
      } else {
        this.rightScrollLine = Math.max(0, this.rightScrollLine - 1);
      }
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
    const lines: string[] = [titledRule("Charters", width, "╭", "╮")];
    for (const entry of nonTerminal) lines.push(this.leftRow(entry.row, entry.index, width, false));
    if (terminal.length > 0) lines.push(titledRule("done", width, "├", "┤"));
    for (const entry of terminal) lines.push(this.leftRow(entry.row, entry.index, width, true));
    return lines;
  }

  private leftRow(row: CharterListRow, index: number, width: number, dim: boolean): string {
    const cursorMark = index === this.cursorIndex ? "►" : " ";
    const boundMark = row.charterId === this.boundCharterId ? "*" : " ";
    const prefix = `${cursorMark}${boundMark} `;
    const bar = progressBar(row.passCount, row.totalCount, 8);
    const count = `${row.passCount}/${row.totalCount}`;
    const tail = `${bar} ${count}  ${row.status}`;
    const nameWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(tail));
    const line = `${prefix}${padRight(clipText(row.name, nameWidth), nameWidth)}${tail}`;
    return dim ? this.color("dim", line) : line;
  }

  private buildRightPane(width: number): string[] {
    if (width <= 0) return [];
    const row = this.charters[this.cursorIndex];
    if (!row) return [this.color("dim", "No charters.")];
    const snapshot = this.snapshots.get(row.charterId);
    if (!snapshot) return [this.color("dim", "No snapshot for this charter.")];

    const lines: string[] = [];
    const header = `${snapshot.header.name}  [${snapshot.header.status}]  ${snapshot.header.passCount}/${snapshot.header.totalCount} VAL  ${formatElapsed(snapshot.header.elapsedMs)}`;
    lines.push(header);
    lines.push(progressBar(snapshot.header.passCount, snapshot.header.totalCount, Math.max(1, width - 1)));
    lines.push(this.color("yellow", "Objective"));
    const objectiveLines = wrapText(snapshot.objective, Math.max(1, width - 2));
    if (!this.objectiveExpanded && objectiveLines.length > 2) {
      lines.push(...objectiveLines.slice(0, 2).map((line) => `  ${line}`));
      lines.push("  [o for full]");
    } else {
      lines.push(...objectiveLines.map((line) => `  ${line}`));
    }

    if (snapshot.evaluatorVerdict) {
      lines.push(this.color(verdictColor(snapshot.evaluatorVerdict.verdict), `Evaluator: ${snapshot.evaluatorVerdict.verdict}`));
      for (const line of wrapText(snapshot.evaluatorVerdict.steer, Math.max(1, width - 2))) {
        lines.push(`  ${line}`);
      }
    }

    lines.push(this.color("red", "Blocking complete:"));
    if (snapshot.blockingForComplete.length === 0 && allPass(snapshot)) {
      lines.push(this.color("green", "  Ready to complete"));
    } else if (snapshot.blockingForComplete.length === 0) {
      lines.push(this.color("dim", "  No blocking data"));
    } else {
      for (const item of snapshot.blockingForComplete) lines.push(this.color("red", `  • ${item}`));
    }

    lines.push("Plan");
    for (const milestone of snapshot.planTree) {
      lines.push(`  ${this.color("bold", milestone.milestoneId)}`);
      for (const feature of milestone.features) {
        lines.push(this.featureLine(feature));
        if (this.allExpanded) {
          for (const criterion of feature.criteria) lines.push(this.criterionLine(criterion));
        }
      }
    }

    lines.push("Recent evidence");
    for (const evidence of snapshot.recentEvidence.slice(0, 5)) {
      lines.push(`${formatTime(evidence.ts)}  ${evidence.criterionId.padEnd(14)}  ${evidence.outcome.padEnd(7)}  ${evidence.recordedBy}`);
    }
    return lines;
  }

  private featureLine(feature: PlanFeatureNode): string {
    const glyph = feature.status === "completed"
      ? this.color("green", "✓")
      : feature.status === "in_progress"
        ? this.color("cyan", "●")
        : this.color("dim", "○");
    const bar = progressBar(feature.passCount, feature.totalCount, 4);
    return `    ${glyph} ${feature.featureId.padEnd(12)} ${bar} ${feature.passCount}/${feature.totalCount}  ${feature.status}`;
  }

  private criterionLine(criterion: PlanCriterionNode): string {
    const glyph = criterion.outcome === "pass"
      ? this.color("green", "✓")
      : criterion.outcome === "fail"
        ? this.color("red", "✗")
        : this.color("dim", "○");
    const title = criterion.titleFromH3 ? `  ${criterion.titleFromH3}` : "";
    return `        ${glyph} ${criterion.criterionId}${title}`;
  }

  private topBorder(leftWidth: number, rightWidth: number): string {
    return `╭${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}╮`;
  }

  private bottomBorder(leftWidth: number, rightWidth: number): string {
    return `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`;
  }

  private bodyRow(left: string, right: string, leftWidth: number, rightWidth: number): string {
    return `│${padRight(left, leftWidth)}│${padRight(right, rightWidth)}│`;
  }

  private color(color: string, text: string): string {
    return this.theme.fg(color, text);
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

function matchesPrintable(data: string, key: string): boolean {
  return data === key || matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function padRight(text: string, width: number): string {
  const clipped = visibleWidth(text) > width ? clipText(text, width) : text;
  const pad = Math.max(0, width - visibleWidth(clipped));
  return clipped + " ".repeat(pad);
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

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

function verdictColor(verdict: string): string {
  if (verdict === "on_track") return "green";
  if (verdict === "drifting") return "orange";
  if (verdict === "blocked") return "red";
  if (verdict === "done") return "cyan";
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

export const PICKER_FOOTERS = {
  left: LEFT_FOOTER,
  right: RIGHT_FOOTER,
} as const;
