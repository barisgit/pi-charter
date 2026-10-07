/**
 * One-line above-editor status for the session-bound charter: short name and
 * lifecycle, plus Ralph guard state or the imminent Ralph countdown when relevant.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CharterStatusResult } from "../application/service";
import { charterSlugFromId } from "../domain/ids";
import type { CharterStatus } from "../domain/types";

interface ThemeLike {
  fg(color: string, text: string): string;
}

/**
 * Everything the widget displays, at displayed granularity. Hosts may compare
 * serialized views to skip republishing an identical line.
 */
export interface CharterWidgetView {
  name: string;
  status: CharterStatus;
  guard?: "warning" | "paused";
  /** Whole seconds until the pending Ralph continuation; set only while active. */
  countdownSeconds?: number;
}

const LABEL = "charter ";
const SEPARATOR = " · ";
/** Narrowest truncated name, ellipsis included, worth keeping before dropping the name. */
const MIN_NAME_WIDTH = 4;

/** Project the bound charter status, and the remaining Ralph warning time, into a widget view. */
export function buildCharterWidgetView(status: CharterStatusResult | undefined, ralphRemainingMs = 0): CharterWidgetView | undefined {
  if (!status) return undefined;
  const view: CharterWidgetView = { name: charterSlugFromId(status.charterId), status: status.status };
  if (status.ralph?.pausedByGuard) view.guard = "paused";
  else if (status.ralph?.warnedAt !== undefined) view.guard = "warning";
  if (status.status === "active" && ralphRemainingMs > 0) view.countdownSeconds = Math.ceil(ralphRemainingMs / 1_000);
  return view;
}

/**
 * Render the view as a single line no wider than `width`. When space is short
 * the name is truncated first, then dropped, so lifecycle and Ralph state stay visible.
 */
export function renderCharterWidget(view: CharterWidgetView, width: number, theme: ThemeLike): string[] {
  if (width <= 0) return [];
  const segments = statusSegments(view);
  const plainTail = segments.map((segment) => SEPARATOR + segment.text).join("");
  const tail = segments.map((segment) => theme.fg("dim", SEPARATOR) + theme.fg(segment.color, segment.text)).join("");
  const nameWidth = width - visibleWidth(LABEL) - visibleWidth(plainTail);
  if (nameWidth < MIN_NAME_WIDTH) {
    const statusOnly = segments.map((segment) => theme.fg(segment.color, segment.text)).join(theme.fg("dim", SEPARATOR));
    return [truncateToWidth(statusOnly, width)];
  }
  const name = truncateToWidth(view.name, nameWidth, "…");
  return [theme.fg("dim", LABEL) + theme.fg("text", name) + tail];
}

interface Segment {
  text: string;
  color: string;
}

function statusSegments(view: CharterWidgetView): Segment[] {
  if (view.guard === "paused") return [{ text: "paused by Ralph guard", color: "warning" }, { text: "/charter resume", color: "muted" }];
  const segments: Segment[] = [{ text: view.status, color: view.status === "active" ? "accent" : "warning" }];
  if (view.countdownSeconds !== undefined) segments.push({ text: `Ralph continues in ${view.countdownSeconds}s`, color: "warning" });
  else if (view.guard === "warning") segments.push({ text: "Ralph guard warning", color: "warning" });
  return segments;
}
