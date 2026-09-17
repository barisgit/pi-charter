import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterCommands,
  registerCharterFlags,
  registerCharterRalphLoop,
  registerCharterRalphMessageRenderer,
  registerCharterFileHooks,
  registerCharterObjectiveReminder,
  registerCharterTools,
  registerCharterWidget,
} from "./application/registration";

export { CharterToolError } from "./application/errors";
export { getPackageVersion } from "./application/version";
export * from "./domain/charter-file";
export * from "./domain/ids";

export default function charterExtension(pi: ExtensionAPI): void {
  registerCharterFlags(pi);
  registerCharterTools(pi);
  registerCharterCommands(pi);
  registerCharterFileHooks(pi);
  registerCharterObjectiveReminder(pi);
  registerCharterWidget(pi);
  registerCharterRalphLoop(pi);
  registerCharterRalphMessageRenderer(pi);
}
