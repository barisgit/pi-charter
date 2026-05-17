import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import type { CharterListRow, PickerSnapshot, PlanCriterionNode, PlanFeatureNode } from "./picker-snapshot";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
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
    // Top + bottom rows carry titles and footer keybinds (widget-style).
    const bodyHeight = Math.max(0, height - 2);
    // Bottom ~30% of left pane shows cursor-info sub-panel (min 5, max 10).
    const infoHeight = clamp(Math.floor(bodyHeight * 0.30), 5, 10);
    const listHeight = Math.max(1, bodyHeight - infoHeight - 1); // -1 for blank separator

    const cursor = this.charters[this.cursorIndex];
    const snapshot = cursor ? this.snapshots.get(cursor.charterId) : undefined;

    const listContent = this.buildLeftPane(leftWidth);
    const infoContent = this.buildInfoPane(leftWidth);
    const rightContent = this.buildRightPane(rightWidth);
    this.lastRightMaxScroll = Math.max(0, rightContent.length - bodyHeight);
    this.rightScrollLine = clamp(this.rightScrollLine, 0, this.lastRightMaxScroll);
    const rightVisible = rightContent.slice(this.rightScrollLine, this.rightScrollLine + bodyHeight);

    const rows: string[] = [];
    rows.push(this.topBorder(leftWidth, rightWidth, snapshot));
    for (let i = 0; i < bodyHeight; i++) {
      let left: string;
      if (i < listHeight) {
        left = listContent[i] ?? "";
      } else if (i === listHeight) {
        left = "";
      } else {
        const infoIdx = i - listHeight - 1;
        left = infoContent[infoIdx] ?? "";
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
    const lines: string[] = [];
    for (const entry of nonTerminal) lines.push(this.leftRow(entry.row, entry.index, width, false));
    if (terminal.length > 0) lines.push(this.color("dim", flatRule("done", width)));
    for (const entry of terminal) lines.push(this.leftRow(entry.row, entry.index, width, true));
    return lines;
  }

  private buildInfoPane(width: number): string[] {
    if (width <= 0) return [];
    const row = this.charters[this.cursorIndex];
    if (!row) return [this.color("dim", "(no selection)")];
    const snapshot = this.snapshots.get(row.charterId);
    const out: string[] = [];
    out.push(this.theme.bold(clipText(row.name, width)));
    const statusBadge = this.color(statusColor(row.status), `[${row.status}]`);
    const passColor = this.passCountColor(row.passCount, row.totalCount);
    const counter = this.color(passColor, `${row.passCount}/${row.totalCount}`);
    out.push(`${statusBadge} ${counter}`);
    if (snapshot?.evaluatorVerdict) {
      out.push(this.color(verdictColor(snapshot.evaluatorVerdict.verdict), `⚑ ${snapshot.evaluatorVerdict.verdict}`));
    }
    if (snapshot) {
      const objWidth = Math.max(1, width);
      const wrapped = wrapText(snapshot.objective, objWidth);
      const remaining = Math.max(0, 6 - out.length);
      for (const line of wrapped.slice(0, remaining)) out.push(this.color("muted", line));
      if (wrapped.length > remaining && remaining > 0) {
        out[out.length - 1] = this.color("muted", clipText(`${out[out.length - 1]}…`, objWidth));
      }
    }
    return out;
  }

  private leftRow(row: CharterListRow, index: number, width: number, dim: boolean): string {
    // Fixed-column layout so bars + counters align vertically across rows:
    //   prefix(3)  name(flex,≥6)  bar(8)  ' '  count(7,right-aligned)  '  '  status(rest)
    const isCursor = index === this.cursorIndex;
    const cursorMark = isCursor ? this.color("accent", "►") : " ";
    const boundMark = row.charterId === this.boundCharterId ? this.color("accent", "*") : " ";
    const prefix = `${cursorMark}${boundMark} `;
    const PREFIX_W = 3;
    const BAR_W = 8;
    const COUNT_W = 7; // fits up to "999/999"
    const GAP_BAR_COUNT = 1;
    const GAP_COUNT_STATUS = 2;
    const STATUS_W = Math.max(6, Math.min(10, Math.max(...this.charters.map((r) => r.status.length))));
    let nameWidth = width - PREFIX_W - BAR_W - GAP_BAR_COUNT - COUNT_W - GAP_COUNT_STATUS - STATUS_W;
    if (nameWidth < 4) nameWidth = Math.max(0, width - PREFIX_W - BAR_W - GAP_BAR_COUNT - COUNT_W - GAP_COUNT_STATUS);
    const nameText = row.name.length > nameWidth
      ? clipText(`${row.name.slice(0, Math.max(0, nameWidth - 1))}…`, nameWidth)
      : row.name;
    const namePart = padRight(nameText, nameWidth);
    const styledName = dim ? this.color("dim", namePart) : (isCursor ? this.theme.bold(namePart) : namePart);
    const bar = progressBar(row.passCount, row.totalCount, BAR_W);
    const countText = `${row.passCount}/${row.totalCount}`;
    const countPadded = countText.padStart(COUNT_W);
    const count = this.color(this.passCountColor(row.passCount, row.totalCount), countPadded);
    const statusRaw = clipText(row.status, STATUS_W);
    const status = this.color(statusColor(row.status), statusRaw);
    return `${prefix}${styledName}${bar} ${count}  ${status}`;
  }

  private buildRightPane(width: number): string[] {
    if (width <= 0) return [];
    const row = this.charters[this.cursorIndex];
    if (!row) return [this.color("dim", "No charters.")];
    const snapshot = this.snapshots.get(row.charterId);
    if (!snapshot) return [this.color("dim", "No snapshot for this charter.")];

    const lines: string[] = [];
    // Name + status + counter + elapsed all live in the top-border title (rendered by topBorder).
    // Inside the pane: progress bar then sections.
    lines.push(progressBar(snapshot.header.passCount, snapshot.header.totalCount, Math.max(1, width - 1)));
    lines.push("");
    lines.push(this.color("warning", "Objective"));
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

    lines.push(this.color("error", "Blocking complete:"));
    if (snapshot.blockingForComplete.length === 0 && allPass(snapshot)) {
      lines.push(this.color("success", "  Ready to complete"));
    } else if (snapshot.blockingForComplete.length === 0) {
      lines.push(this.color("dim", "  No blocking data"));
    } else {
      for (const item of snapshot.blockingForComplete) lines.push(this.color("error", `  • ${item}`));
    }

    lines.push("Plan");
    for (const milestone of snapshot.planTree) {
      lines.push(`  ${this.theme.bold(milestone.milestoneId)}`);
      for (const feature of milestone.features) {
        lines.push(this.featureLine(feature));
        if (this.allExpanded) {
          for (const criterion of feature.criteria) lines.push(this.criterionLine(criterion));
        }
      }
    }

    lines.push(this.theme.bold("Recent evidence"));
    for (const evidence of snapshot.recentEvidence.slice(0, 5)) {
      const outcomeColor: ThemeColorName = evidence.outcome === "pass" ? "success" : evidence.outcome === "fail" ? "error" : "warning";
      const outcome = this.color(outcomeColor, evidence.outcome.padEnd(7));
      lines.push(`${this.color("muted", formatTime(evidence.ts))}  ${evidence.criterionId.padEnd(14)}  ${outcome}  ${this.color("dim", evidence.recordedBy)}`);
    }
    return lines;
  }

  private featureLine(feature: PlanFeatureNode): string {
    const glyph = feature.status === "completed"
      ? this.color("success", "✓")
      : feature.status === "in_progress"
        ? this.color("accent", "●")
        : this.color("dim", "○");
    const bar = progressBar(feature.passCount, feature.totalCount, 4);
    const statusWord = this.color(featureStatusColor(feature.status), feature.status);
    const counter = this.color(this.passCountColor(feature.passCount, feature.totalCount), `${feature.passCount}/${feature.totalCount}`);
    return `    ${glyph} ${feature.featureId.padEnd(12)} ${bar} ${counter}  ${statusWord}`;
  }

  private criterionLine(criterion: PlanCriterionNode): string {
    const glyph = criterion.outcome === "pass"
      ? this.color("success", "✓")
      : criterion.outcome === "fail"
        ? this.color("error", "✗")
        : this.color("dim", "○");
    const title = criterion.titleFromH3 ? `  ${criterion.titleFromH3}` : "";
    return `        ${glyph} ${criterion.criterionId}${title}`;
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

  private bottomBorder(leftWidth: number, rightWidth: number): string {
    const leftFocused = this.focus === "left";
    const rightFocused = this.focus === "right";
    const leftSegment = this.titledBottomSegment(leftWidth, LEFT_FOOTER, leftFocused);
    const rightSegment = this.titledBottomSegment(rightWidth, RIGHT_FOOTER, rightFocused);
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
    const dash = (n: number) => this.color("dim", "─".repeat(Math.max(0, n)));
    const labelText = clipText(opts.label, Math.max(0, opts.width - 6));
    const labelStyled = opts.labelBold
      ? this.theme.bold(this.color(opts.labelColor, labelText))
      : this.color(opts.labelColor, labelText);
    const tailPlain = opts.tailPlain ?? opts.tail ?? "";
    const tailRendered = opts.tailRendered ?? (opts.tail !== undefined ? this.color(opts.tailColor ?? "dim", opts.tail) : "");
    const labelLen = visibleWidth(labelText);
    const tailLen = visibleWidth(tailPlain);
    const fixedCost = 1 + 1 + labelLen + 1 + 1 + tailLen + (tailLen > 0 ? 1 : 0) + 1;
    const fillDashes = Math.max(1, opts.width - fixedCost);
    if (tailLen > 0) {
      return `${dash(1)} ${labelStyled} ${dash(fillDashes)} ${tailRendered} ${dash(1)}`;
    }
    return `${dash(1)} ${labelStyled} ${dash(fillDashes + 2)}${dash(1)}`;
  }

  private titledBottomSegment(width: number, hint: string, focused: boolean): string {
    const dash = (n: number) => this.color("dim", "─".repeat(Math.max(0, n)));
    const hintColor: ThemeColorName = focused ? "accent" : "dim";
    const hintStyled = focused
      ? this.theme.bold(this.color(hintColor, hint))
      : this.color(hintColor, hint);
    const hintLen = visibleWidth(hint);
    const fixedCost = 1 + 1 + hintLen + 1;
    const fillDashes = Math.max(0, width - fixedCost);
    return `${dash(1)} ${hintStyled} ${dash(fillDashes)}`;
  }

  private bodyRow(left: string, right: string, leftWidth: number, rightWidth: number): string {
    const v = this.color("dim", "│");
    return `${v}${padRight(left, leftWidth)}${v}${padRight(right, rightWidth)}${v}`;
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

export const PICKER_FOOTERS = {
  left: LEFT_FOOTER,
  right: RIGHT_FOOTER,
} as const;
