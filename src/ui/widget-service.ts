/**
 * Bridge between ADR-0014 status projections and the old charter widget VM.
 */

import { getBoundCharterStatus, getCharterStatus, type CharterStatusResult } from "../application/service";
import { listCharters } from "../infrastructure/store";
import { buildViewModel, type CharterWidgetVM, type ReducerInput } from "./widget-state";

export interface SnapshotInput {
  projectDir: string;
  charterId: string;
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
    objective: dated.objective,
    phases: dated.phases,
    reportExists: dated.reportExists,
    legacy: dated.legacy,
    ralph: dated.ralph,
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
