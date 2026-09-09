/** Compact above-editor projection of a charter's lifecycle and current phase. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CharterStatus } from "../domain/types";
import type { CharterStatusResult } from "../application/service";
import { buildViewModel, type CharterWidgetVM } from "./widget-state";

export type CharterWidgetStatus = CharterStatusResult;

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

export const BOX_KEY = "pi-charter";
const ELAPSED_TICK_MS = 5_000;

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
  frame?: number;
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
    phases: status.phases,
    reportExists: status.reportExists,
    legacy: status.legacy,
    ralph: status.ralph,
    now,
  });
}

export function renderCharterWidget({ width, theme, vm }: RenderOptions): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  const lifecycle = statusLabel(vm.status);
  lines.push(renderHeader(width, vm.displayName, lifecycle, theme, statusColor(vm.status)));

  if (vm.legacy) {
    lines.push(renderBodyLine(width, theme.fg("warning", "Legacy charter · read-only"), theme));
  }
  if (vm.currentPhase) {
    lines.push(renderBodyLine(width, theme.fg("accent", `Phase ${vm.currentPhase.number}: ${vm.currentPhase.title}`), theme));
  } else {
    lines.push(renderBodyLine(width, theme.fg("dim", vm.position.total === 0 ? "No phases yet" : "No current phase"), theme));
  }
  if (vm.guardPaused) lines.push(renderBodyLine(width, theme.fg("warning", "Execution paused by Ralph guard; use /charter resume"), theme));
  else if (vm.guardWarning) lines.push(renderBodyLine(width, theme.fg("warning", "Ralph guard warning"), theme));
  if (vm.status === "active" && (vm.ralphRemainingMs ?? 0) > 0) {
    const seconds = Math.max(1, Math.ceil(vm.ralphRemainingMs! / 1_000));
    lines.push(renderBodyLine(width, theme.fg("warning", `Ralph continues in ${seconds}s`), theme));
  }
  lines.push(renderFooter(width, theme));
  return lines.map((line) => truncateToWidth(line, width));
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

/** Stateful wrapper retained for hosts that use the widget directly. */
export class CharterWidget {
  private ui?: UiLike;
  private vm?: CharterWidgetVM;
  private tui?: TuiLike;
  private registered = false;
  private elapsedInterval?: ReturnType<typeof setInterval>;

  setUi(ui: UiLike): void { this.ui = ui; }

  update(vm: CharterWidgetVM): void {
    this.vm = vm;
    if (!this.ui) return;
    if (!this.registered) {
      this.ui.setWidget(BOX_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: () => renderCharterWidget({ width: tui.terminal?.columns ?? 100, theme, vm: this.vm! }),
          invalidate: () => {},
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender?.();
    }
    this.elapsedInterval ??= setInterval(() => this.tui?.requestRender?.(), ELAPSED_TICK_MS);
  }

  dispose(): void {
    if (this.elapsedInterval) clearInterval(this.elapsedInterval);
    this.elapsedInterval = undefined;
    this.ui?.setWidget(BOX_KEY, undefined);
    this.registered = false;
    this.vm = undefined;
    this.tui = undefined;
  }
}
