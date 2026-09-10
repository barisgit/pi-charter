import { spawn } from "node:child_process";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
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
  MIN_LEFT_PANE,
  MIN_RIGHT_PANE,
  SPLIT_STEP_COLS,
  TERMINAL_STATUSES,
} from "./charter-picker-constants";
import type { CharterListRow, PickerSnapshot } from "./picker-snapshot";

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
 * theme — plus mutable closure state (flash message, phase folding) — is in
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
    let allExpanded = true;
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
            isBound: !row.legacy && row.charterId === opts.boundCharterId,
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
          const legacy = snapshot.legacy ? "  legacy · read-only" : "";
          const tailRendered = [
            t.fg(statusColor(snapshot.header.status), `[${snapshot.header.status}]`),
            t.fg("muted", snapshot.header.elapsed),
          ].join("  ") + legacy;
          const tailPlain = `[${snapshot.header.status}]  ${snapshot.header.elapsed}${legacy}`;
          // Coerce to string: titledTopSegment's truncateToWidth crashes pi on a
          // non-string label, and header.name derives from on-disk JSON.
          return { label: String(snapshot.header.name ?? ""), tailRendered, tailPlain };
        },
        rows: (ctx) => buildDetailLines(t, ctx.selectedRow, ctx.selectedRow ? snapshots.get(ctx.selectedRow.charterId) : undefined, ctx.detail.width, bodyHeight(), { allExpanded }),
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

function doneCountColor(done: number, total: number): ThemeColorName {
  if (total === 0) return "dim";
  if (done === total) return "success";
  if (done === 0) return "muted";
  return "accent";
}

function leftRow(
  theme: ThemeLike,
  row: CharterListRow,
  opts: { isCursor: boolean; isBound: boolean; dim: boolean; width: number; statusWidth: number },
): string {
  const { isCursor, isBound, dim, width, statusWidth } = opts;
  const prefix = "  ";
  const position = row.legacy ? "legacy" : `${row.doneCount}/${row.totalCount}`;
  const status = clipText(row.status, statusWidth);
  const bound = isBound ? "  bound" : "";
  const suffixPlain = `  ${position}  ${status}${bound}`;
  const nameWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffixPlain));
  const name = padRight(clipText(row.name, nameWidth), nameWidth);
  const styledName = dim ? theme.fg("dim", name) : isCursor ? theme.bold(theme.fg("accent", name)) : name;
  const positionColor = row.legacy ? "warning" : doneCountColor(row.doneCount, row.totalCount);
  return clipStyled(`${prefix}${styledName}  ${theme.fg(positionColor, position)}  ${theme.fg(statusColor(row.status), status)}${isBound ? theme.fg("accent", bound) : ""}`, width);
}

function buildInfoLines(
  theme: ThemeLike,
  row: CharterListRow | undefined,
  snapshot: PickerSnapshot | undefined,
  width: number,
  flash: FlashMessage | null,
): string[] {
  if (width <= 0) return [];
  if (flash) {
    const color: ThemeColorName = flash.kind === "error" ? "error" : flash.kind === "warning" ? "warning" : "success";
    return wrapText(flash.text, width).map((line) => theme.fg(color, line));
  }
  if (!row) return [theme.bold("No charters yet"), theme.fg("muted", "Create a charter to begin durable work.")];
  const out = [theme.bold(clipText(row.name, width))];
  out.push(...wrapText(row.charterId, width).map((line) => theme.fg("dim", line)));
  for (const line of formatTimestamps(row)) out.push(theme.fg("dim", clipText(line, width)));
  if (!snapshot) out.push(theme.fg("error", "Charter unavailable"));
  return out;
}

function formatTimestamps(row: CharterListRow): string[] {
  const out = [`created  ${formatDateTime(row.createdAt)}`];
  const endIso = row.completedAt ?? row.terminatedAt;
  if (endIso) out.push(`${row.completedAt ? "done   " : "ended  "} ${formatDateTime(endIso)}`);
  else if (row.updatedAt !== row.createdAt) out.push(`updated  ${formatDateTime(row.updatedAt)}`);
  return out;
}

function buildDetailLines(
  theme: ThemeLike,
  row: CharterListRow | undefined,
  snapshot: PickerSnapshot | undefined,
  width: number,
  _bodyHeight: number,
  expand: { allExpanded: boolean },
): string[] {
  if (width <= 0) return [];
  if (!row) return [theme.bold("No charters yet"), theme.fg("muted", "Create a charter to begin durable work.")];
  if (!snapshot) return [theme.bold(theme.fg("error", "Unable to load charter")), "", ...wrapText("The charter files could not be read.", width).map((line) => theme.fg("muted", line))];

  const lines: string[] = [];
  const heading = (label: string, color: ThemeColorName = "accent") => theme.bold(theme.fg(color, label));
  if (snapshot.legacy) lines.push(heading("Legacy charter · read-only", "warning"), "");

  lines.push(heading("Objective"));
  lines.push(...wrapText(snapshot.objective, Math.max(1, width - 2)).map((line) => `  ${line}`));

  if (snapshot.references) lines.push("", heading("References"), ...wrapText(snapshot.references, Math.max(1, width - 2)).map((line) => `  ${line}`));
  if (snapshot.scope) lines.push("", heading("Scope"), ...wrapText(snapshot.scope, Math.max(1, width - 2)).map((line) => `  ${line}`));

  if (snapshot.legacy) {
    lines.push("", heading("charter.md"), ...renderMarkdownLines(theme, snapshot.charterMarkdown, width));
  } else {
    lines.push("", `${heading("Phases")} ${theme.fg(doneCountColor(snapshot.header.doneCount, snapshot.header.totalCount), `${snapshot.header.doneCount}/${snapshot.header.totalCount} done`)}`);
    if (snapshot.phases.length === 0) lines.push(theme.fg("muted", "  No phases recorded."));
    if (expand.allExpanded) for (const phase of snapshot.phases) lines.push(...phaseLines(theme, phase, width));
  }

  if (snapshot.ralph?.pausedByGuard) lines.push("", heading("Ralph guard", "warning"), `  ${theme.fg("warning", "Paused before another Ralph activation.")}`, `  ${theme.fg("text", "Resume with /charter resume.")}`);
  else if (snapshot.ralph?.warnedAt !== undefined) lines.push("", heading("Ralph guard", "warning"), theme.fg("warning", "  Activation warning issued."));

  if (snapshot.warnings.length > 0) lines.push("", heading("Parser warnings", "warning"), ...snapshot.warnings.flatMap((warning) => wrapText(warning, Math.max(1, width - 2)).map((line) => `  ${theme.fg("warning", line)}`)));
  if (snapshot.report) lines.push("", heading("REPORT.md"), ...renderMarkdownLines(theme, snapshot.report.markdown, width));
  return lines;
}

function phaseLines(theme: ThemeLike, phase: PickerSnapshot["phases"][number], width: number): string[] {
  const color: ThemeColorName = phase.status === "done" ? "success" : phase.status === "current" ? "accent" : "dim";
  const prefix = `  ${padRight(phase.status, 10)}${phase.number}. `;
  const continuation = " ".repeat(visibleWidth(prefix));
  const titleLines = wrapText(phase.title, Math.max(1, width - visibleWidth(prefix)));
  const out = titleLines.map((line, index) => `${index === 0 ? theme.fg(color, prefix) : continuation}${theme.fg(index === 0 || phase.status === "current" ? "text" : "muted", line)}`);
  if (phase.body) out.push(...wrapText(phase.body, Math.max(8, width - 4)).map((line) => theme.fg(phase.status === "current" ? "text" : "muted", `    ${line}`)));
  return out;
}

function renderMarkdownLines(theme: ThemeLike, markdown: string, width: number): string[] {
  // Prefer pi's real markdown renderer (same one the chat view uses).
  // getMarkdownTheme() depends on the interactive theme being initialized;
  // fall back to plain wrapped text in headless contexts (tests).
  try {
    return new Markdown(markdown, 2, 0, getMarkdownTheme()).render(Math.max(10, width));
  } catch {
    /* fall through to plain rendering */
  }
  const out: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim().length === 0) {
      out.push("");
      continue;
    }
    out.push(...wrapText(line, Math.max(1, width)).map((wrapped) => `  ${wrapped}`));
  }
  return out;
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
        const chunks = splitWordByWidth(word, width);
        out.push(...chunks.slice(0, -1));
        line = chunks.at(-1) ?? "";
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

function splitWordByWidth(word: string, width: number): string[] {
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word), ({ segment }) => segment);
  const chunks: string[] = [];
  let chunk = "";
  for (const grapheme of graphemes) {
    if (chunk && visibleWidth(chunk + grapheme) > width) {
      chunks.push(chunk);
      chunk = "";
    }
    if (!chunk && visibleWidth(grapheme) > width) {
      chunks.push(grapheme);
      continue;
    }
    chunk += grapheme;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
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
