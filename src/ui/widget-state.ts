/**
 * Pure view-model reducer for the charter widget (v3).
 *
 * Consumes charter state, criteria, criterion-state, and running subagents.
 * No feature DAG, no feature-state sidecar. No I/O, no timers, no UI imports.
 */

import type { CharterCriterion, CharterStatus } from "../domain/types";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set([
  "completed",
  "abandoned",
]);

export type ValState = "pass" | "running" | "pending";

export interface CharterWidgetVM {
  charterId: string;
  /** Short header label: name when set, else first 8 chars of UUID. */
  displayName: string;
  status: CharterStatus;
  isTerminal: boolean;
  /** @deprecated v3 removed planning; always false. */
  isPlanning: boolean;
  elapsedMs: number;
  bar: { pass: number; running: number; total: number };
  /** Only set when isPlanning is true. */
  planning?: PlanningVM;
}

/**
 * Planning-phase view model (kept for type-compat; planning state no longer
 * exists in v3 — isPlanning is always false).
 */
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
  criteria: CharterCriterion[];
  criterionOutcomes: Record<string, { outcome?: string } | undefined>;
  runningSubagents: RunningSubagent[];
  now?: number;
}

export function buildViewModel(input: ReducerInput): CharterWidgetVM {
  const now = input.now ?? Date.now();
  const createdMs = parseIsoOrFallback(input.createdAt, now);
  const isTerminal = TERMINAL_STATUSES.has(input.status);

  const verifyingCriteria = new Set<string>();
  for (const sub of input.runningSubagents) {
    if (sub.criterionId) verifyingCriteria.add(sub.criterionId);
  }

  let pass = 0;
  let running = 0;
  for (const criterion of input.criteria) {
    const outcome = input.criterionOutcomes[criterion.id]?.outcome;
    if (outcome === "pass") pass++;
    else if (verifyingCriteria.has(criterion.id)) running++;
  }
  const bar = { pass, running, total: input.criteria.length };

  const displayName = resolveDisplayName(input.charterId, input.name);

  return {
    charterId: input.charterId,
    displayName,
    status: input.status,
    isTerminal,
    isPlanning: false,
    elapsedMs: Math.max(0, now - createdMs),
    bar,
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
  return charterId.slice(0, 8);
}
