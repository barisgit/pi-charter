import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Tri-value selection state shared by the `/charters` slash command verbs
 * (`select <id>`, `select none`, picker confirm).
 *
 * Why a module-level singleton: the picker spec keeps selection
 * "in an extension closure variable; persists across turns within the
 * session; cleared on session end". Both `registerCharterCommands` and
 * `registerCharterWidget` need read+write access; a tiny module-scoped store
 * is the simplest path that lets the command surface trigger an immediate
 * widget refresh without reaching into the widget host.
 *
 * Refresh: the widget host registers a `requestRefresh` callback at session
 * start; commands invoke it via `requestSelectionRefresh(ctx)` after they
 * mutate selection so the widgets re-render before the next turn.
 */

export type CharterSelection =
  | { kind: "unset" }
  | { kind: "explicit-clear" }
  | { kind: "explicit"; charterId: string };

let current: CharterSelection = { kind: "unset" };

export function getCharterSelection(): CharterSelection {
  return current;
}

export function setCharterSelection(next: CharterSelection): void {
  current = next;
}

/**
 * Reset to the initial `unset` state. Called by `registerCharterWidget` on
 * session_shutdown so a fresh process keeps the documented "cleared on
 * session end" contract; tests also use it to isolate cases.
 */
export function resetCharterSelection(): void {
  current = { kind: "unset" };
}

export type SelectionRefreshCtx = Pick<ExtensionContext, "hasUI" | "cwd" | "ui" | "sessionManager">;

type RefreshFn = (ctx: SelectionRefreshCtx) => Promise<void> | void;

let refresher: RefreshFn | undefined;

/**
 * Widget host calls this once at registration time. The command surface
 * invokes the stored fn (when present) so `/charters select foo` immediately
 * refreshes the session-bound detail widget instead of waiting for the next
 * `turn_end`.
 */
export function registerSelectionRefresher(fn: RefreshFn): void {
  refresher = fn;
}

export function clearSelectionRefresher(): void {
  refresher = undefined;
}

export async function requestSelectionRefresh(ctx: SelectionRefreshCtx): Promise<void> {
  if (!refresher) return;
  await refresher(ctx);
}
