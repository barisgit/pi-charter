import type { SubagentExposedAPI } from "../infrastructure/subagent-bridge";

/**
 * Captured pi-subagents `SubagentExposedAPI` (cached after the
 * `subagent:expose-api` event fires). `undefined` until pi-subagents emits;
 * stays `undefined` if pi-subagents is not loaded.
 */
let subagentApi: SubagentExposedAPI | undefined;

export function getSubagentApi(): SubagentExposedAPI | undefined {
  return subagentApi;
}

export function setSubagentApiForBridge(api: SubagentExposedAPI | undefined): void {
  subagentApi = api;
}

/** Test-only: reset the cached API handle. */
export function __resetSubagentApiForTests(): void {
  subagentApi = undefined;
}
