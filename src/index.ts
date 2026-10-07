import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterCommands,
  registerCharterRalphLoop,
  registerCharterRalphMessageRenderer,
  registerCharterFileHooks,
  registerCharterTools,
  registerCharterWidget,
} from "./application/registration";

export { CharterToolError } from "./application/errors";
export { getPackageVersion } from "./application/version";
export * from "./domain/charter-file";
export * from "./domain/ids";

export default function charterExtension(pi: ExtensionAPI): void {
  registerCharterTools(pi);
  registerCharterCommands(pi);
  registerCharterFileHooks(pi);
  registerCharterWidget(pi);
  registerCharterRalphLoop(pi);
  registerCharterRalphMessageRenderer(pi);
}
