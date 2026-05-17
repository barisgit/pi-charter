import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterAsyncBridge,
  registerCharterCommands,
  registerCharterEvaluator,
  registerCharterFlags,
  registerCharterPersonas,
  registerCharterSubagentBridge,
  registerCharterTools,
  registerCharterWidget,
} from "./application/registration";
import { registerCharterRemindersBridge } from "./application/reminders-bridge";

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
  registerCharterRemindersBridge(pi);
  registerCharterEvaluator(pi);
  registerCharterPersonas(pi);
}
