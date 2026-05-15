/**
 * pi-subagents bridge: surface 3.
 *
 * Subscribes to `subagent:async-started` and `subagent:async-complete` events
 * and, when the payload metadata carries the `pi-charter.*` keys, appends a
 * MissionEvent into the appropriate charter's `events.jsonl`.
 *
 * The bridge is intentionally narrow: it only attributes async runs the host
 * agent itself tagged with the canonical metadata keys. Runs without
 * `pi-charter.projectDir` + `pi-charter.charterId` are ignored silently.
 */

import { appendEvent, charterDir } from "../infrastructure/store";
import {
  PI_CHARTER_METADATA_KEYS,
  type SubagentAsyncCompletePayload,
  type SubagentAsyncStartedPayload,
} from "../infrastructure/subagent-bridge";

export interface AsyncBridgeAttribution {
  projectDir: string;
  charterId: string;
  featureId?: string;
  criterionId?: string;
}

/**
 * Extract pi-charter attribution from a subagent async event payload.
 *
 * Returns `null` when required keys (`pi-charter.projectDir`,
 * `pi-charter.charterId`) are missing or non-string. Optional keys are
 * surfaced verbatim when present.
 */
export function attributionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): AsyncBridgeAttribution | null {
  if (!metadata) return null;
  const projectDir = metadata[PI_CHARTER_METADATA_KEYS.projectDir];
  const charterId = metadata[PI_CHARTER_METADATA_KEYS.charterId];
  if (typeof projectDir !== "string" || !projectDir) return null;
  if (typeof charterId !== "string" || !charterId) return null;
  const featureId = metadata[PI_CHARTER_METADATA_KEYS.featureId];
  const criterionId = metadata[PI_CHARTER_METADATA_KEYS.criterionId];
  return {
    projectDir,
    charterId,
    featureId: typeof featureId === "string" && featureId ? featureId : undefined,
    criterionId: typeof criterionId === "string" && criterionId ? criterionId : undefined,
  };
}

export interface HandleAsyncStartedInput {
  payload: SubagentAsyncStartedPayload;
  now?: string;
}

export async function handleAsyncStarted(input: HandleAsyncStartedInput): Promise<boolean> {
  const attribution = attributionFromMetadata(input.payload.metadata);
  if (!attribution) return false;
  const dir = charterDir(attribution.projectDir, attribution.charterId);
  await appendEvent(dir, {
    type: "feature_started",
    ts: input.now ?? new Date().toISOString(),
    charterId: attribution.charterId,
    featureId: attribution.featureId,
    criterionId: attribution.criterionId,
    runId: input.payload.runId,
    agent: input.payload.agent,
    source: "subagent:async-started",
  });
  return true;
}

export interface HandleAsyncCompleteInput {
  payload: SubagentAsyncCompletePayload;
  now?: string;
}

export async function handleAsyncComplete(input: HandleAsyncCompleteInput): Promise<boolean> {
  const attribution = attributionFromMetadata(input.payload.metadata);
  if (!attribution) return false;
  const dir = charterDir(attribution.projectDir, attribution.charterId);
  const failed = input.payload.exitCode !== 0;
  await appendEvent(dir, {
    type: failed ? "feature_failed" : "feature_completed",
    ts: input.now ?? new Date().toISOString(),
    charterId: attribution.charterId,
    featureId: attribution.featureId,
    criterionId: attribution.criterionId,
    runId: input.payload.runId,
    agent: input.payload.agent,
    exitCode: input.payload.exitCode,
    durationMs: input.payload.durationMs,
    summary: input.payload.summary,
    source: "subagent:async-complete",
  });
  return true;
}
