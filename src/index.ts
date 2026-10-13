import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerCharterCommands,
  registerCharterRalphLoop,
  registerCharterRalphMessageRenderer,
  registerCharterTools,
  registerCharterWidget,
} from "./application/registration.ts";

export { CharterToolError } from "./application/errors.ts";
export { getPackageVersion } from "./application/version.ts";
export * from "./domain/charter-file.ts";
export * from "./domain/ids.ts";

export default function charterExtension(pi: ExtensionAPI): void {
  registerCharterTools(pi);
  registerCharterCommands(pi);
  registerCharterWidget(pi);
  registerCharterRalphLoop(pi);
  registerCharterRalphMessageRenderer(pi);
}
