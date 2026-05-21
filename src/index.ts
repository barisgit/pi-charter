import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterAsyncBridge,
  registerCharterCommands,
  registerCharterFlags,
  registerCharterPersonas,
  registerCharterRalphLoop,
  registerCharterRalphMessageRenderer,
  registerCharterSubagentBridge,
  registerCharterTools,
  registerCharterWidget,
} from "./application/registration";
import { registerCharterRemindersBridge } from "./application/reminders-bridge";

export { CharterToolError } from "./application/errors";

/**
 * pi-charter extension entrypoint.
 *
 * Runtime code is intentionally small at the entrypoint; domain, store, and
 * tool contracts live under src/domain, src/infrastructure, and
 * src/application.
 */
export default function charterExtension(pi: ExtensionAPI): void {
  registerCharterFlags(pi);
  registerCharterTools(pi);
  registerCharterCommands(pi);
  // Bridge surface 2 must register the SUBAGENT_EXPOSE_API_EVENT subscriber
  // before pi-subagents emits at startup; do it ahead of persona-dir
  // registration so the captured API handle is available to anything that
  // wants to call `spawnRaw` once persona resolution is wired.
  registerCharterSubagentBridge(pi);
  registerCharterAsyncBridge(pi);
  // Widget listener registered AFTER the async bridge so its event handlers
  // fire after the bridge has written feature_started/feature_completed
  // events to disk; the widget then reads the updated state.
  registerCharterWidget(pi);
  // Temporarily disabled: the ambient pi-reminders channel re-emits a
  // charter status line every idle, which looks like (and competes with) the
  // Ralph steer in scrollback. Ralph is now the sole reprompt path. Leave
  // the bridge module in place so it can be re-enabled once we decide on the
  // long-term split between ambient reminders and active reprompting.
  // registerCharterRemindersBridge(pi);
  // Deterministic Ralph reprompt loop. Replaces the per-turn model evaluator:
  // fires on subagent:all-idle (main + every async child done) and reprompts
  // unconditionally while the bound charter is non-terminal.
  registerCharterRalphLoop(pi);
  registerCharterRalphMessageRenderer(pi);
  registerCharterPersonas(pi);
}
