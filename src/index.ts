import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterCommands,
  registerCharterFlags,
  registerCharterRalphLoop,
  registerCharterRalphMessageRenderer,
  registerCharterStalenessHooks,
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
  registerCharterStalenessHooks(pi);
  registerCharterWidget(pi);
  registerCharterRalphLoop(pi);
  registerCharterRalphMessageRenderer(pi);
}
