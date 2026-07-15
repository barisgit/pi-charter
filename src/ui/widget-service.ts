/**
 * Bridge between ADR-0014 status projections and the old charter widget VM.
 */

import { getBoundCharterStatus, getCharterStatus, type CharterStatusResult } from "../application/service";
import { listCharters } from "../infrastructure/store";
import { buildViewModel, type CharterWidgetVM, type ReducerInput, type RunningSubagent } from "./widget-state";

export interface SnapshotInput {
  projectDir: string;
  charterId: string;
  runningSubagents?: RunningSubagent[];
  now?: number;
}

export type CharterWidgetStatusWithDates = CharterStatusResult & { createdAt?: string; updatedAt?: string };

export async function loadCharterWidgetStatus(
  projectDir: string,
  input: { sessionId?: string } = {},
): Promise<CharterWidgetStatusWithDates | undefined> {
  const status = await getBoundCharterStatus(projectDir, input.sessionId);
  if (!status) return undefined;
  return withListDates(projectDir, status);
}

export async function loadCharterSnapshot(input: SnapshotInput): Promise<CharterWidgetVM> {
  const status = await getCharterStatus(input.projectDir, { charterId: input.charterId });
  const dated = await withListDates(input.projectDir, status);
  const reducerInput: ReducerInput = {
    charterId: dated.charterId,
    name: slugFromId(dated.charterId),
    status: dated.status,
    createdAt: dated.createdAt ?? new Date().toISOString(),
    criteria: dated.criteria,
    runningSubagents: input.runningSubagents ?? [],
    now: input.now,
  };
  return buildViewModel(reducerInput);
}

async function withListDates(projectDir: string, status: CharterStatusResult): Promise<CharterWidgetStatusWithDates> {
  const row = (await listCharters(projectDir)).find((entry) => entry.charterId === status.charterId);
  return { ...status, createdAt: row?.createdAt ?? status.createdAt, updatedAt: row?.updatedAt };
}

function slugFromId(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? charterId.slice(0, 8);
}

/**
 * In-memory tracker kept for compatibility with the old widget host API. The
 * ADR-0014 runtime does not currently bind subagent runs to criteria, so the
 * unified status projection uses the accent/running segment for active or failed work.
 */
export class RunningSubagentRegistry {
  private subs = new Map<string, RunningSubagent>();

  start(payload: { runId: string; charterId: string; agent?: string; metadata?: Record<string, unknown>; startedAt?: string }): void {
    const featureId = readMetaString(payload.metadata, "pi-charter.featureId");
    const criterionId = readMetaString(payload.metadata, "pi-charter.criterionId");
    this.subs.set(payload.runId, {
      runId: payload.runId,
      charterId: payload.charterId,
      agentName: payload.agent,
      featureId,
      criterionId,
      startedAt: payload.startedAt ?? new Date().toISOString(),
    });
  }

  complete(runId: string): void {
    this.subs.delete(runId);
  }

  forCharter(charterId: string): RunningSubagent[] {
    return Array.from(this.subs.values()).filter((r) => r.charterId === charterId);
  }

  size(): number {
    return this.subs.size;
  }
}

function readMetaString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = metadata?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
