import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCharterCommands, registerCharterFlags, registerCharterTools } from "./application/registration";

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
}
