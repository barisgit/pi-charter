/**
 * Pure view-model reducer for the charter widget.
 *
 * Preserves the old widget VM/visual contract while reading ADR-0014 charter
 * status projections: pass Evidence fills the pass segment, fail Evidence fills
 * the old running/accent segment, and none Evidence remains pending/dim.
 */

import type { CharterStatus } from "../domain/types";
import type { CriterionStatusView } from "../application/service";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set([
  "completed",
  "abandoned",
]);

export type ValState = "pass" | "running" | "pending";

export interface CharterWidgetVM {
  charterId: string;
  /** Short header label: ADR-0014 slug/objective label, else id prefix. */
  displayName: string;
  status: CharterStatus;
  isTerminal: boolean;
  /** Planning UI is retained for old visuals, but ADR-0014 has no planning phase. */
  isPlanning: boolean;
  elapsedMs: number;
  bar: { pass: number; running: number; total: number };
  nextCriterion?: { id: string; title: string; evidence: CriterionStatusLike["evidence"] };
  ralphRemainingMs?: number;
  /** Only set when isPlanning is true. */
  planning?: PlanningVM;
}

/** Retained for the old renderer's planning visual branch. */
export interface PlanningVM {
  steps: PlanningStep[];
  criteriaCount: number;
  featuresCount: number;
  uncoveredCriteria: string[];
  nextHint: string;
}

export type PlanningStepState = "done" | "partial" | "pending";

export interface PlanningStep {
  id: "create" | "criteria" | "features" | "critique" | "lock";
  state: PlanningStepState;
  label: string;
  detail?: string;
}

export interface RunningSubagent {
  runId: string;
  charterId: string;
  agentName?: string;
  featureId?: string;
  criterionId?: string;
  startedAt: string;
}

export interface ReducerInput {
  charterId: string;
  name?: string;
  status: CharterStatus;
  createdAt: string;
  criteria: CriterionStatusLike[];
  runningSubagents?: RunningSubagent[];
  now?: number;
}

export type CriterionStatusLike = Pick<CriterionStatusView, "id" | "title" | "evidence">;

export function buildViewModel(input: ReducerInput): CharterWidgetVM {
  const now = input.now ?? Date.now();
  const createdMs = parseIsoOrFallback(input.createdAt, now);
  const isTerminal = TERMINAL_STATUSES.has(input.status);

  let pass = 0;
  let running = 0;
  for (const criterion of input.criteria) {
    if (criterion.evidence === "pass") pass++;
    else if (criterion.evidence === "fail") running++;
  }

  return {
    charterId: input.charterId,
    displayName: resolveDisplayName(input.charterId, input.name),
    status: input.status,
    isTerminal,
    isPlanning: false,
    elapsedMs: Math.max(0, now - createdMs),
    bar: { pass, running, total: input.criteria.length },
    nextCriterion: toNextCriterion(input.criteria.find((criterion) => criterion.evidence !== "pass")),
  };
}

function toNextCriterion(criterion: CriterionStatusLike | undefined): CharterWidgetVM["nextCriterion"] {
  return criterion ? { id: criterion.id, title: criterion.title, evidence: criterion.evidence } : undefined;
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
