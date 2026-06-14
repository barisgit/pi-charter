import { spawn } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  clipStyled,
  clipText,
  padRight,
  paneOverlay,
  type FullscreenComponentFactory,
  type PaneOverlayContext,
  type PaneOverlayOptions,
  type PaneOverlayPrimaryRow,
} from "pi-extension-utils";
import type { CharterStatus } from "../domain/types";
import {
  BANNED_PRINTABLE,
  DEFAULT_LEFT_FRACTION,
  FLASH_TTL_RENDERS,
  LEFT_PANE_CAP,
  LEFT_ROW_BAR_MIN_NAME_W,
  LEFT_ROW_BAR_W,
  LEFT_ROW_COUNT_W,
  LEFT_ROW_GAP_BAR_COUNT,
  LEFT_ROW_GAP_COUNT_STATUS,
  LEFT_ROW_MIN_NAME_W,
  LEFT_ROW_PREFIX_W,
  MIN_LEFT_PANE,
  MIN_RIGHT_PANE,
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
  heightProvider: () => number;
  initialCursorCharterId?: string;
  boundCharterId: string | null;
  host?: PickerHostHooks;
}

type FlashMessage = { text: string; kind: "info" | "warning" | "error"; rendersLeft: number };
type Ctx = PaneOverlayContext<null, CharterListRow>;

/**
 * Build the charter picker as a `paneOverlay` factory.
 *
 * The pane-overlay content callbacks receive only a `PaneOverlayContext`, not
 * the theme. The picker colorizes via `theme.fg`/`theme.bold`, so the options
 * (and their callbacks) are constructed INSIDE the returned factory where the
 * theme — plus mutable closure state (flash message, expansion toggles) — is in
 * scope. Read-only: the picker never resolves a charter id; it only closes with
 * `null`.
 */
export function createCharterPickerOverlay(opts: CharterPickerOptions): FullscreenComponentFactory<null> {
  return (tui, theme, keybindings, done) => {
    const t = theme as ThemeLike;
    const { charters, snapshots, heightProvider, host } = opts;
    // Read terminal rows LIVE each call (do not capture once): pi-tui's
    // terminal.rows tracks process.stdout resize events, so the overlay height
    // must re-read it every render to follow terminal resize.
    const totalHeight = (): number => (tui as { terminal?: { rows?: number } }).terminal?.rows ?? heightProvider();

    // Mutable closure state (replaces the old component's instance fields).
    let allExpanded = false;
    let objectiveExpanded = false;
    let flash: FlashMessage | null = null;

    const setFlash = (text: string, kind: FlashMessage["kind"] = "info"): void => {
      flash = { text, kind, rendersLeft: FLASH_TTL_RENDERS };
    };

    const statusWidth = Math.max(6, Math.min(10, Math.max(0, ...charters.map((r) => r.status.length))));

    // Primary rows: non-terminal charters, a `done` separator iff any terminal
    // charters exist, then terminal charters. Selection key = charterId.
    const primaryRows: PaneOverlayPrimaryRow<CharterListRow>[] = [];
    const nonTerminal = charters.filter((row) => !TERMINAL_STATUSES.has(row.status));
    const terminal = charters.filter((row) => TERMINAL_STATUSES.has(row.status));
    for (const row of nonTerminal) primaryRows.push(row);
    if (terminal.length > 0) primaryRows.push({ kind: "separator", label: "done" });
    for (const row of terminal) primaryRows.push(row);

    const bodyHeight = (): number => Math.max(0, Math.max(2, Math.floor(totalHeight())) - 2);

    const selectedDir = (row: CharterListRow): string => host?.resolveCharterDir(row.charterId) ?? row.charterId;

    const openSelectedDir = async (ctx: Ctx): Promise<void> => {
      const row = ctx.selectedRow;
      if (!row) {
        setFlash("No charter selected", "warning");
        ctx.requestRender();
        return;
      }
      const path = selectedDir(row);
      try {
        if (host?.openPath) await host.openPath(path);
        else defaultOpenPath(path);
        setFlash(`Opened → ${path}`, "info");
        host?.notify?.(`Opened ${path}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFlash(`Failed to open: ${msg}`, "error");
        host?.notify?.(`Failed to open: ${msg}`, "error");
      }
      ctx.requestRender();
    };

    const copySelectedCharterId = async (ctx: Ctx): Promise<void> => {
      const row = ctx.selectedRow;
      if (!row) {
        setFlash("No charter selected", "warning");
        ctx.requestRender();
        return;
      }
      try {
        if (host?.copyText) await host.copyText(row.charterId);
        else await defaultCopyText(row.charterId);
        setFlash(`Copied id → ${row.charterId}`, "info");
        host?.notify?.(`Copied charterId ${row.charterId.slice(0, 8)}…`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFlash(`Copy failed: ${msg}`, "error");
        host?.notify?.(`Copy failed: ${msg}`, "error");
      }
      ctx.requestRender();
    };

    const options: PaneOverlayOptions<null, CharterListRow> = {
      height: () => bodyHeight(),
      closeKeys: ["escape", "ctrl+c", "q"],
      closeResult: null,
      legendPlacement: "primary",
      // Reset detail scroll per selected charter (each charter's detail opens at
      // the top, matching the old picker's rightScrollLine=0 on cursor move).
      perSelectionScroll: true,
      bannedKeys: [...BANNED_PRINTABLE, "enter", "\r", "\n", "delete"],
      split: {
        initialFraction: DEFAULT_LEFT_FRACTION,
        minPrimaryWidth: MIN_LEFT_PANE,
        minDetailWidth: MIN_RIGHT_PANE,
        maxPrimaryWidth: LEFT_PANE_CAP,
        stepCols: SPLIT_STEP_COLS,
        fractionBasis: "interior",
      },
      collapse: { key: "s", label: "sidebar", collapsedWidth: 0 },
      onRender: () => {
        // Tick down the flash message lifetime once per render; it takes over
        // the info zone for a few renders so O/y get immediate in-pane feedback.
        if (flash) {
          flash.rendersLeft -= 1;
          if (flash.rendersLeft <= 0) flash = null;
        }
      },
      primary: {
        mode: "cursor",
        rows: primaryRows,
        selectionKey: (row) => row.charterId,
        ...(opts.initialCursorCharterId !== undefined || charters[0]
          ? { initialSelectionKey: opts.initialCursorCharterId ?? charters[0]?.charterId }
          : {}),
        renderRow: (row, ctx, width) =>
          leftRow(t, row, {
            isCursor: ctx.selectedKey === row.charterId,
            isBound: row.charterId === opts.boundCharterId,
            dim: TERMINAL_STATUSES.has(row.status),
            width,
            statusWidth,
          }),
        title: () => {
          const activeCount = charters.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;
          const totalCount = charters.length;
          const tail = activeCount === totalCount ? `${totalCount}` : `${activeCount} active / ${totalCount}`;
          return { label: "Charters", tail, tailColor: "dim" };
        },
        infoTitle: "info",
        info: (ctx) => buildInfoLines(t, ctx.selectedRow, ctx.selectedRow ? snapshots.get(ctx.selectedRow.charterId) : undefined, ctx.primary.width, flash),
      },
      detail: {
        title: (ctx) => {
          const row = ctx.selectedRow;
          const snapshot = row ? snapshots.get(row.charterId) : undefined;
          if (!snapshot) return { label: "(no selection)", labelColor: "dim", tailColor: "dim" };
          const passColor = passCountColor(snapshot.header.passCount, snapshot.header.totalCount);
          const tailRendered = [
            t.fg(statusColor(snapshot.header.status), `[${snapshot.header.status}]`),
            t.fg(passColor, `${snapshot.header.passCount}/${snapshot.header.totalCount} VAL`),
            t.fg("muted", formatElapsed(snapshot.header.elapsedMs)),
          ].join("  ");
          const tailPlain = `[${snapshot.header.status}]  ${snapshot.header.passCount}/${snapshot.header.totalCount} VAL  ${formatElapsed(snapshot.header.elapsedMs)}`;
          // Coerce to string: titledTopSegment's truncateToWidth crashes pi on a
          // non-string label, and header.name derives from on-disk JSON.
          return { label: String(snapshot.header.name ?? ""), tailRendered, tailPlain };
        },
        rows: (ctx) => buildDetailLines(t, ctx.selectedRow, ctx.selectedRow ? snapshots.get(ctx.selectedRow.charterId) : undefined, ctx.detail.width, bodyHeight(), { allExpanded, objectiveExpanded }),
      },
      customActions: [
        {
          keys: "space",
          label: "fold",
          showInLegend: false,
          when: (ctx) => ctx.detailFocus,
          run: (ctx) => { allExpanded = !allExpanded; ctx.requestRender(); },
        },
        {
          keys: "o",
          label: "obj",
          showInLegend: false,
          when: (ctx) => ctx.detailFocus,
          run: (ctx) => { objectiveExpanded = !objectiveExpanded; ctx.requestRender(); },
        },
        {
          keys: "shift+o",
          label: "open dir",
          run: (ctx) => { void openSelectedDir(ctx); },
        },
        {
          keys: "y",
          label: "copy id",
          run: (ctx) => { void copySelectedCharterId(ctx); },
        },
      ],
    };

    return paneOverlay<null, CharterListRow>(options)(tui, theme, keybindings, done);
  };
}

type ThemeColorName = "success" | "warning" | "error" | "accent" | "muted" | "dim" | "text" | "borderAccent" | "borderMuted";

function passCountColor(pass: number, total: number): ThemeColorName {
  if (total === 0) return "dim";
  if (pass === total) return "success";
  if (pass === 0) return "muted";
  return "accent";
}

// Render a progress bar with colored filled portion and dim empty portion.
function coloredBar(theme: ThemeLike, pass: number, total: number, width: number): string {
  const filled = total > 0 ? clamp(Math.floor((pass / total) * width), 0, width) : 0;
  const empty = width - filled;
  return theme.fg(passCountColor(pass, total), "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

function leftRow(
  theme: ThemeLike,
  row: CharterListRow,
  opts: { isCursor: boolean; isBound: boolean; dim: boolean; width: number; statusWidth: number },
): string {
  // Fixed-column layout so bars + counters align vertically across rows:
  //   prefix(3)  name(flex,≥6)  bar(8)  ' '  count(7,right-aligned)  '  '  status(rest)
  const { isCursor, isBound, dim, width, statusWidth } = opts;
  const cursorMark = isCursor ? theme.fg("accent", "►") : " ";
  const boundMark = isBound ? theme.fg("accent", "*") : " ";
  const prefix = `${cursorMark}${boundMark} `;
  const countText = `${row.passCount}/${row.totalCount}`;
  const countPadded = countText.padStart(LEFT_ROW_COUNT_W);
  const count = theme.fg(passCountColor(row.passCount, row.totalCount), countPadded);
  const fixedWithBar = LEFT_ROW_PREFIX_W + LEFT_ROW_BAR_W + LEFT_ROW_GAP_BAR_COUNT + LEFT_ROW_COUNT_W + LEFT_ROW_GAP_COUNT_STATUS + statusWidth;
  const fixedWithoutBar = LEFT_ROW_PREFIX_W + LEFT_ROW_COUNT_W + LEFT_ROW_GAP_COUNT_STATUS + statusWidth;
  const fixedWithoutStatus = LEFT_ROW_PREFIX_W + LEFT_ROW_COUNT_W;
  const showBar = width - fixedWithBar >= LEFT_ROW_BAR_MIN_NAME_W;
  const showStatus = !showBar && width - fixedWithoutBar >= LEFT_ROW_MIN_NAME_W;
  const nameWidth = Math.max(0, width - (showBar ? fixedWithBar : showStatus ? fixedWithoutBar : fixedWithoutStatus));
  const nameText = row.name.length > nameWidth
    ? clipText(`${row.name.slice(0, Math.max(0, nameWidth - 1))}…`, nameWidth)
    : row.name;
  const namePart = padRight(nameText, nameWidth);
  const styledName = dim ? theme.fg("dim", namePart) : (isCursor ? theme.bold(namePart) : namePart);
  const bar = showBar
    ? dim
      ? theme.fg("dim", progressBar(row.passCount, row.totalCount, LEFT_ROW_BAR_W))
      : coloredBar(theme, row.passCount, row.totalCount, LEFT_ROW_BAR_W)
    : "";
  const barPart = showBar ? `${bar}${" ".repeat(LEFT_ROW_GAP_BAR_COUNT)}` : "";
  const statusPart = showStatus || showBar
    ? `${" ".repeat(LEFT_ROW_GAP_COUNT_STATUS)}${theme.fg(statusColor(row.status), clipText(row.status, statusWidth))}`
    : "";
  return clipStyled(`${prefix}${styledName}${barPart}${count}${statusPart}`, width);
}

function buildInfoLines(
  theme: ThemeLike,
  row: CharterListRow | undefined,
  snapshot: PickerSnapshot | undefined,
  width: number,
  flash: FlashMessage | null,
): string[] {
  if (width <= 0) return [];
  // Flash message takes over the info pane for a few renders so the user gets
  // immediate in-pane feedback on O/y actions (separate from host notify toast).
  if (flash) {
    const kindColor: ThemeColorName = flash.kind === "error" ? "error" : flash.kind === "warning" ? "warning" : "success";
    return wrapText(flash.text, width).map((line) => theme.fg(kindColor, line));
  }
  if (!row) return [theme.fg("dim", "(no selection)")];
  const out: string[] = [];
  out.push(theme.bold(clipText(row.name, width)));
  const statusBadge = theme.fg(statusColor(row.status), `[${row.status}]`);
  const counter = theme.fg(passCountColor(row.passCount, row.totalCount), `${row.passCount}/${row.totalCount}`);
  out.push(`${statusBadge} ${counter}`);
  // Timestamps: date + HH:MM for created, plus updated (live) or completed/terminated
  // (terminal). Helps distinguish stale active charters at a glance.
  for (const line of formatTimestamps(row)) out.push(theme.fg("dim", clipText(line, width)));
  if (snapshot) {
    const objWidth = Math.max(1, width);
    const wrapped = wrapText(snapshot.objective, objWidth);
    const remaining = Math.max(0, 8 - out.length);
    for (const line of wrapped.slice(0, remaining)) out.push(theme.fg("muted", line));
    if (wrapped.length > remaining && remaining > 0) {
      out[out.length - 1] = theme.fg("muted", clipText(`${out[out.length - 1]}…`, objWidth));
    }
  }
  return out;
}

function formatTimestamps(row: CharterListRow): string[] {
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

function buildDetailLines(
  theme: ThemeLike,
  row: CharterListRow | undefined,
  snapshot: PickerSnapshot | undefined,
  width: number,
  bodyHeight: number,
  expand: { allExpanded: boolean; objectiveExpanded: boolean },
): string[] {
  if (width <= 0) return [];
  if (!row) return [theme.fg("dim", "No charters.")];
  if (!snapshot) return [theme.fg("dim", "No snapshot for this charter.")];

  const lines: string[] = [];
  const sectionHeading = (label: string, color: ThemeColorName = "accent") => theme.bold(theme.fg(color, label));

  // Top: colored progress bar straight under the embedded title.
  lines.push(coloredBar(theme, snapshot.header.passCount, snapshot.header.totalCount, Math.max(1, width - 1)));

  // Objective section.
  lines.push("");
  lines.push(sectionHeading("Objective", "warning"));
  const objectiveLines = wrapText(snapshot.objective, Math.max(1, width - 2));
  if (!expand.objectiveExpanded && objectiveLines.length > 2) {
    lines.push(...objectiveLines.slice(0, 2).map((line) => `  ${line}`));
    lines.push(theme.fg("dim", "  [o for full]"));
  } else {
    lines.push(...objectiveLines.map((line) => `  ${line}`));
  }

  // Blocking-complete section.
  // Suppress entirely for terminal charters (completed/abandoned); the section
  // only makes sense for live work. If all VAL pass on a non-terminal charter,
  // surface Ready regardless of any stale blockingForComplete data.
  const isTerminal = snapshot.header.status === "completed" || snapshot.header.status === "abandoned";
  if (!isTerminal) {
    lines.push("");
    if (allPass(snapshot)) {
      lines.push(sectionHeading("Ready to complete", "success"));
    } else {
      lines.push(sectionHeading("Blocking complete", "error"));
      const blocking = snapshot.blockingForComplete;
      if (blocking.length === 0) {
        lines.push(theme.fg("dim", "  No blocking data"));
      } else {
        const MAX_BLOCKING = 5;
        const shown = blocking.slice(0, MAX_BLOCKING);
        for (const item of shown) lines.push(theme.fg("error", `  • ${item}`));
        if (blocking.length > MAX_BLOCKING) {
          lines.push(theme.fg("dim", `  … +${blocking.length - MAX_BLOCKING} more`));
        }
      }
    }
  }

  // Plan section.
  lines.push("");
  lines.push(sectionHeading("Plan"));
  for (const milestone of snapshot.planTree) {
    lines.push(`  ${theme.bold(theme.fg("text", milestone.milestoneId))}`);
    for (const feature of milestone.features) {
      lines.push(...featureLines(theme, feature, width));
      if (expand.allExpanded) {
        for (const criterion of feature.criteria) lines.push(...criterionLines(theme, criterion, width));
      }
    }
  }

  // Recent evidence section.
  lines.push("");
  lines.push(sectionHeading("Recent evidence"));
  const remainingRows = Math.max(5, bodyHeight - lines.length - 1);
  const evidenceShown = snapshot.recentEvidence.slice(0, Math.max(5, remainingRows));
  for (const evidence of evidenceShown) lines.push(...evidenceLines(theme, evidence, width));
  if (snapshot.recentEvidence.length > evidenceShown.length) {
    lines.push(theme.fg("dim", `… +${snapshot.recentEvidence.length - evidenceShown.length} more`));
  }
  return lines;
}

function featureLines(theme: ThemeLike, feature: PlanFeatureNode, width: number): string[] {
  const glyph = feature.status === "completed"
    ? theme.fg("success", "✓")
    : feature.status === "in_progress"
      ? theme.fg("accent", "●")
      : theme.fg("dim", "○");
  const bar = width >= 44 ? `${coloredBar(theme, feature.passCount, feature.totalCount, 4)} ` : "";
  const statusWord = theme.fg(featureStatusColor(feature.status), feature.status);
  const counter = theme.fg(passCountColor(feature.passCount, feature.totalCount), `${feature.passCount}/${feature.totalCount}`);
  return [`    ${glyph} ${feature.featureId.padEnd(12)} ${bar}${counter}  ${statusWord}`];
}

function criterionLines(theme: ThemeLike, criterion: PlanCriterionNode, width: number): string[] {
  const glyph = criterion.outcome === "pass"
    ? theme.fg("success", "✓")
    : criterion.outcome === "fail"
      ? theme.fg("error", "✗")
      : theme.fg("dim", "○");
  const head = `        ${glyph} ${criterion.criterionId}`;
  if (!criterion.titleFromH3) return [head];
  const titleWidth = Math.max(8, width - visibleWidth(head) - 2);
  const wrapped = wrapText(criterion.titleFromH3, titleWidth);
  return [
    `${head}  ${wrapped[0] ?? ""}`,
    ...wrapped.slice(1).map((line) => `          ${line}`),
  ];
}

function evidenceLines(theme: ThemeLike, evidence: PickerSnapshot["recentEvidence"][number], width: number): string[] {
  const outcomeColor: ThemeColorName = evidence.outcome === "pass" ? "success" : evidence.outcome === "fail" ? "error" : "warning";
  const outcome = theme.fg(outcomeColor, evidence.outcome.padEnd(7));
  const prefix = `${theme.fg("muted", formatTime(evidence.ts))}  ${evidence.criterionId.padEnd(14)}  ${outcome}`;
  const by = compactRecordedBy(evidence.recordedBy);
  const byWidth = Math.max(8, width - visibleWidth(prefix) - 2);
  const wrapped = wrapText(by, byWidth);
  return [
    `${prefix}  ${theme.fg("dim", wrapped[0] ?? "")}`,
    ...wrapped.slice(1).map((line) => theme.fg("dim", `                            ${line}`)),
  ];
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
    .replace(/^subagent:([^:]+):/, "subagent:$1:")
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

function statusColor(status: CharterStatus): ThemeColorName {
  switch (status) {
    case "active": return "accent";
    case "completed": return "success";
    case "paused": return "warning";
    case "abandoned": return "error";
    default: return "dim";
  }
}

function featureStatusColor(status: "completed" | "in_progress" | "pending"): ThemeColorName {
  if (status === "completed") return "success";
  if (status === "in_progress") return "accent";
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
