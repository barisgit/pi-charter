/**
 * pi-subagents bridge: local redeclarations of event constants and payload
 * shapes published by pi-subagents.
 *
 * We never import from pi-subagents directly; the two extensions communicate
 * over the shared `pi.events` bus. This mirrors the pi-prune-router /
 * pi-prune-swe-pruner-provider pattern (each side redeclares the constants).
 *
 * Source of truth lives in:
 *   ~/Programming_local/Projects/pi-extensions/pi-subagents/types.ts
 * Keep these constants in sync if pi-subagents renames an event.
 */

// ---------------------------------------------------------------------------
// Event constants
// ---------------------------------------------------------------------------

export const SUBAGENT_EXPOSE_API_EVENT = "subagent:expose-api";
export const SUBAGENT_REGISTER_PERSONA_DIR_EVENT = "subagent:register-persona-dir";
export const SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT = "subagent:unregister-persona-dir";
export const SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT = "subagent:register-persona-dir-error";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

// ---------------------------------------------------------------------------
// Bridge identity / metadata key prefix
// ---------------------------------------------------------------------------

export const PI_CHARTER_EXTENSION_ID = "pi-charter";

/** Prefix for keys placed into the opaque `metadata` bag on subagent spawns. */
export const PI_CHARTER_METADATA_PREFIX = "pi-charter.";

/**
 * Keys the host agent embeds in the opaque `metadata` bag when delegating to
 * a charter persona via `subagent({...})`. pi-subagents copies the bag
 * verbatim into `subagent:async-*` event payloads; the bridge reads these
 * keys back to attribute the run to a charter feature.
 *
 * `projectDir` is required because `pi.events.on()` has no `ctx` (no `cwd`),
 * so the bridge has no other way to locate the per-project charter directory.
 */
export const PI_CHARTER_METADATA_KEYS = {
  projectDir: "pi-charter.projectDir",
  charterId: "pi-charter.charterId",
  featureId: "pi-charter.featureId",
  criterionId: "pi-charter.criterionId",
} as const;

// ---------------------------------------------------------------------------
// Payload shapes (locally redeclared, must match pi-subagents/types.ts)
// ---------------------------------------------------------------------------

export type SubagentMetadata = Record<string, unknown>;

export interface RegisterPersonaDirPayload {
  extensionId: string;
  path: string;
  scope: "internal";
}

export interface UnregisterPersonaDirPayload {
  extensionId: string;
}

export interface PersonaDirErrorPayload {
  extensionId: string;
  conflictingExtensionId: string;
  personaName: string;
  message: string;
}

export interface SpawnRawInput {
  systemPrompt: string;
  prompt: string;
  tools?: string[];
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean | string[];
  defaultReads?: string[];
  defaultProgress?: boolean;
  metadata?: SubagentMetadata;
  async?: boolean;
  cwd?: string;
}

export interface SpawnRawResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface SubagentPersonaInfo {
  name: string;
  description: string;
  source?: string;
}

export interface SubagentExposedAPI {
  spawnRaw(input: SpawnRawInput): Promise<SpawnRawResult>;
  list(options?: { includeInternal?: boolean }): SubagentPersonaInfo[];
}

// ---------------------------------------------------------------------------
// Async lifecycle payload shapes (subagent:async-* event bodies)
// ---------------------------------------------------------------------------

export interface SubagentAsyncStartedPayload {
  runId: string;
  agent?: string;
  metadata?: SubagentMetadata;
  startedAt?: number;
}

export interface SubagentAsyncCompletePayload {
  runId: string;
  agent?: string;
  exitCode: number;
  durationMs?: number;
  summary?: string;
  metadata?: SubagentMetadata;
  endedAt?: number;
}
