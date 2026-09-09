/** Pure view-model reducer for the compact charter widget. */

import type { Phase } from "../domain/charter-file";
import type { CharterStatus } from "../domain/types";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set([
  "completed",
  "abandoned",
]);

export interface CharterWidgetVM {
  charterId: string;
  displayName: string;
  status: CharterStatus;
  isTerminal: boolean;
  elapsedMs: number;
  objective: string;
  position: { done: number; total: number };
  currentPhase?: Pick<Phase, "number" | "title" | "body">;
  reportExists: boolean;
  legacy: boolean;
  guardWarning: boolean;
  guardPaused: boolean;
  ralphRemainingMs?: number;
}


export interface ReducerInput {
  charterId: string;
  name?: string;
  status: CharterStatus;
  createdAt: string;
  objective?: string;
  phases: Phase[];
  reportExists?: boolean;
  legacy?: boolean;
  ralph?: { warnedAt?: number; pausedByGuard?: boolean };
  now?: number;
}

export function buildViewModel(input: ReducerInput): CharterWidgetVM {
  const now = input.now ?? Date.now();
  const createdMs = parseIsoOrFallback(input.createdAt, now);
  const current = input.phases.find((phase) => phase.status === "current");

  return {
    charterId: input.charterId,
    displayName: resolveDisplayName(input.charterId, input.name),
    status: input.status,
    isTerminal: TERMINAL_STATUSES.has(input.status),
    elapsedMs: Math.max(0, now - createdMs),
    objective: input.objective?.trim() ?? "",
    position: {
      done: input.phases.filter((phase) => phase.status === "done").length,
      total: input.phases.length,
    },
    currentPhase: current
      ? { number: current.number, title: current.title, body: current.body }
      : undefined,
    reportExists: input.reportExists ?? false,
    legacy: input.legacy ?? false,
    guardWarning: input.ralph?.warnedAt !== undefined,
    guardPaused: input.ralph?.pausedByGuard === true,
  };
}

function parseIsoOrFallback(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDisplayName(charterId: string, name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return slugFromId(charterId) || charterId.slice(0, 8);
}

function slugFromId(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? "";
}
