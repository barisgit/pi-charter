/** Compact above-editor projection of a charter's lifecycle and Ralph guard state. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import type { CharterStatusResult } from "../application/service";
import { buildViewModel, type CharterWidgetVM } from "./widget-state";

export type CharterWidgetStatus = CharterStatusResult;

interface ThemeLike {
  fg(color: string, text: string): string;
}

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

export interface RenderOptions {
  width: number;
  theme: ThemeLike;
  vm: CharterWidgetVM;
}

export function buildCharterWidgetView(status: CharterWidgetStatus | undefined, now?: number): CharterWidgetVM | undefined {
  if (!status) return undefined;
  return buildViewModel({
    charterId: status.charterId,
    name: slugFromId(status.charterId),
    status: status.status,
    createdAt: status.createdAt,
    objective: status.objective,
    reportExists: status.reportExists,
    legacy: status.legacy,
    ralph: status.ralph,
    now,
  });
}

export function renderCharterWidget({ width, theme, vm }: RenderOptions): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  const lifecycle = `${statusLabel(vm.status)} · ${formatElapsed(vm.elapsedMs)}`;
  lines.push(renderHeader(width, vm.displayName, lifecycle, theme, statusColor(vm.status)));
  if (vm.legacy) {
    lines.push(renderBodyLine(width, theme.fg("warning", "Legacy charter") + theme.fg("dim", " · read-only"), theme));
  }
  if (vm.guardPaused) lines.push(renderBodyLine(width, theme.fg("warning", "↻ Guard paused") + theme.fg("dim", " · resume with /charter resume"), theme));
  else if (vm.guardWarning) lines.push(renderBodyLine(width, theme.fg("warning", "↻ Ralph guard warning"), theme));
  const countdownSeconds = ralphCountdownSeconds(vm);
  if (countdownSeconds !== undefined) {
    lines.push(renderBodyLine(width, theme.fg("warning", `↻ Ralph continues in ${countdownSeconds}s`), theme));
  }
  lines.push(renderFooter(width, theme));
  return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Identity of what `renderCharterWidget` would display for `vm` at any width.
 * Time fields are reduced to the granularity the widget shows, so hosts can skip
 * republishing when equal keys would render identical lines.
 */
export function charterWidgetDisplayKey(vm: CharterWidgetVM): string {
  const { elapsedMs: _elapsedMs, ralphRemainingMs: _ralphRemainingMs, ...stable } = vm;
  return JSON.stringify({ ...stable, elapsed: formatElapsed(vm.elapsedMs), countdownSeconds: ralphCountdownSeconds(vm) });
}

function ralphCountdownSeconds(vm: CharterWidgetVM): number | undefined {
  const remainingMs = vm.ralphRemainingMs ?? 0;
  if (vm.status !== "active" || remainingMs <= 0) return undefined;
  return Math.max(1, Math.ceil(remainingMs / 1_000));
}

function renderBodyLine(width: number, content: string, theme: ThemeLike): string {
  if (width === 1) return theme.fg("borderMuted", BORDER.vertical);
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncateToWidth(` ${content}`, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${theme.fg("borderMuted", BORDER.vertical)}${clipped}${padding}${theme.fg("borderMuted", BORDER.vertical)}`;
}

function renderHeader(width: number, title: string, tail: string, theme: ThemeLike, tailColor: string): string {
  if (width <= 1) return theme.fg("borderMuted", BORDER.horizontal.repeat(width));
  const left = ` ${title} `;
  const right = ` ${tail} `;
  const available = Math.max(0, width - 2 - visibleWidth(right));
  const clippedLeft = truncateToWidth(left, available, "");
  const fill = BORDER.horizontal.repeat(Math.max(0, width - 2 - visibleWidth(clippedLeft) - visibleWidth(right)));
  return `${theme.fg("borderMuted", BORDER.topLeft)}${theme.fg("borderMuted", clippedLeft + fill)}${theme.fg(tailColor, right)}${theme.fg("borderMuted", BORDER.topRight)}`;
}

function renderFooter(width: number, theme: ThemeLike): string {
  if (width <= 1) return theme.fg("borderMuted", BORDER.horizontal.repeat(width));
  return theme.fg("borderMuted", `${BORDER.bottomLeft}${BORDER.horizontal.repeat(Math.max(0, width - 2))}${BORDER.bottomRight}`);
}

function statusColor(status: CharterStatus): string {
  if (status === "completed") return "success";
  if (status === "abandoned") return "error";
  if (status === "paused") return "warning";
  return "accent";
}

function statusLabel(status: CharterStatus): string {
  return status;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function slugFromId(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? charterId.slice(0, 8);
}
