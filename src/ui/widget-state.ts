/**
 * Pure view-model reducer for the charter widget.
 *
 * Consumes already-loaded charter snapshots (state.json, charter.md criteria,
 * plan features, criterion-state, feature-state, running subagents) and
 * produces the structured ViewModel that `widget.ts` renders. No I/O, no
 * timers, no UI imports — so the test suite can pin behavior against
 * hand-rolled fixtures.
 *
 * Render rules live in `widget.ts`. This file decides WHAT to show; render
 * decides HOW.
 */

import type { CharterCriterion, CharterStatus } from "../domain/types";
import type { FeatureDefinition } from "../domain/feature-md";

export const MAX_ROWS = 6; // total feature-list rows including the overflow line
export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set([
  "completed",
  "abandoned",
  "paused",
  "budget_limited",
]);

export type ValState = "pass" | "running" | "pending";

export interface FeatureRowVM {
  id: string;
  state: "running" | "idle_ready" | "idle_blocked";
  fulfills: string[];        // criterion ids declared in fulfills[]
  valStates: ValState[];     // one per fulfills[] entry, declaration order
  subagentName?: string;     // only set when state === "running"
  elapsedMs?: number;        // only set when state === "running"
}

export interface CharterWidgetVM {
  charterId: string;
  /** Short header label: name when set, else first 8 chars of UUID. */
  displayName: string;
  status: CharterStatus;
  isTerminal: boolean;
  /** True while status==="planning" — renderer switches to the pipeline view. */
  isPlanning: boolean;
  elapsedMs: number;          // since state.createdAt
  bar: { pass: number; running: number; total: number };
  rows: FeatureRowVM[];
  overflow: { hidden: number; done: number };
  /** Only set when isPlanning is true. */
  planning?: PlanningVM;
}

/**
 * Planning-phase view model. Captures the 5 step pipeline + headline counts
 * + a concrete next-action hint. The reducer computes this entirely from the
 * same inputs as the active view; no extra disk reads needed.
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
  agentName?: string;
  featureId?: string;
  criterionId?: string;       // for charter-verifier subagents pinned to a single VAL
  startedAt: string;          // ISO timestamp
}

export interface ReducerInput {
  charterId: string;
  /** Optional short label set at charter creation; reducer falls back to UUID prefix. */
  name?: string;
  status: CharterStatus;
  createdAt: string;          // ISO
  criteria: CharterCriterion[];
  features: FeatureDefinition[];
  criterionOutcomes: Record<string, { outcome?: string } | undefined>;
  featureStates: Record<string, { status?: string } | undefined>;
  runningSubagents: RunningSubagent[];
  now?: number;               // injectable for tests; defaults to Date.now()
}

export function buildViewModel(input: ReducerInput): CharterWidgetVM {
  const now = input.now ?? Date.now();
  const createdMs = parseIsoOrFallback(input.createdAt, now);
  const isTerminal = TERMINAL_STATUSES.has(input.status);

  // VAL-level running set: any criterion with an in-flight charter-verifier.
  const verifyingCriteria = new Set<string>();
  for (const sub of input.runningSubagents) {
    if (sub.criterionId) verifyingCriteria.add(sub.criterionId);
  }

  // Charter-wide bar counters. Source of truth = criterion-state.json outcome.
  let pass = 0;
  let running = 0;
  for (const criterion of input.criteria) {
    const outcome = input.criterionOutcomes[criterion.id]?.outcome;
    if (outcome === "pass") pass++;
    else if (verifyingCriteria.has(criterion.id)) running++;
  }
  const bar = { pass, running, total: input.criteria.length };

  const displayName = resolveDisplayName(input.charterId, input.name);

  if (isTerminal) {
    // Collapsed view: skip feature rows entirely.
    return { charterId: input.charterId, displayName, status: input.status, isTerminal: true, isPlanning: false, elapsedMs: Math.max(0, now - createdMs), bar, rows: [], overflow: { hidden: 0, done: 0 } };
  }

  if (input.status === "planning") {
    const planning = buildPlanningVM(input.criteria, input.features);
    return {
      charterId: input.charterId,
      displayName,
      status: input.status,
      isTerminal: false,
      isPlanning: true,
      elapsedMs: Math.max(0, now - createdMs),
      bar,
      rows: [],
      overflow: { hidden: 0, done: 0 },
      planning,
    };
  }

  // Per-feature running subagents (excludes pure VAL-level verifier pins —
  // those still attach to a feature via metadata.featureId).
  const runningByFeature = new Map<string, RunningSubagent[]>();
  for (const sub of input.runningSubagents) {
    if (!sub.featureId) continue;
    const list = runningByFeature.get(sub.featureId) ?? [];
    list.push(sub);
    runningByFeature.set(sub.featureId, list);
  }

  // Feature completion lookup: feature-state.status === "done" treats as done.
  const isFeatureDone = (id: string) => {
    const status = input.featureStates[id]?.status;
    return status === "done" || status === "completed";
  };

  // Precondition resolution: a feature is ready iff every precondition feature
  // is done. Empty preconditions[] means ready by definition.
  const isReady = (feature: FeatureDefinition) => {
    if (!feature.preconditions || feature.preconditions.length === 0) return true;
    return feature.preconditions.every((pre) => isFeatureDone(pre));
  };

  // Bucket features into the four selection priorities.
  const running_: FeatureRowVM[] = [];
  const idleReady: FeatureRowVM[] = [];
  const idleBlocked: FeatureRowVM[] = [];
  let doneCount = 0;

  // Sort by plan order first so idle buckets land in plan-order.
  const ordered = [...input.features].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  for (const feature of ordered) {
    if (isFeatureDone(feature.id)) {
      doneCount++;
      continue;
    }
    const subs = runningByFeature.get(feature.id);
    if (subs && subs.length > 0) {
      // Pick the oldest-started subagent as the row's representative.
      const rep = pickRepresentative(subs);
      running_.push(buildRow({
        feature,
        state: "running",
        verifyingCriteria,
        criterionOutcomes: input.criterionOutcomes,
        subagentName: rep.agentName,
        startedMs: parseIsoOrFallback(rep.startedAt, now),
        now,
      }));
      continue;
    }
    const state: "idle_ready" | "idle_blocked" = isReady(feature) ? "idle_ready" : "idle_blocked";
    (state === "idle_ready" ? idleReady : idleBlocked).push(buildRow({
      feature,
      state,
      verifyingCriteria,
      criterionOutcomes: input.criterionOutcomes,
      now,
    }));
  }

  // Running rows sorted by start time ascending (oldest first); oldest =
  // largest elapsedMs.
  running_.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));

  const ordered_rows = [...running_, ...idleReady, ...idleBlocked];
  const visibleSlotCount = MAX_ROWS - 1; // last slot reserved for overflow line
  let rows: FeatureRowVM[];
  let hidden = 0;
  if (ordered_rows.length <= MAX_ROWS && doneCount === 0) {
    rows = ordered_rows;
    hidden = 0;
  } else {
    rows = ordered_rows.slice(0, visibleSlotCount);
    hidden = Math.max(0, ordered_rows.length - rows.length);
  }

  return {
    charterId: input.charterId,
    displayName,
    status: input.status,
    isTerminal: false,
    isPlanning: false,
    elapsedMs: Math.max(0, now - createdMs),
    bar,
    rows,
    overflow: { hidden, done: doneCount },
  };
}

function buildRow(opts: {
  feature: FeatureDefinition;
  state: FeatureRowVM["state"];
  verifyingCriteria: Set<string>;
  criterionOutcomes: Record<string, { outcome?: string } | undefined>;
  subagentName?: string;
  startedMs?: number;
  now: number;
}): FeatureRowVM {
  const valStates = opts.feature.fulfills.map<ValState>((criterionId) => {
    const outcome = opts.criterionOutcomes[criterionId]?.outcome;
    if (outcome === "pass") return "pass";
    if (opts.verifyingCriteria.has(criterionId)) return "running";
    return "pending";
  });
  const row: FeatureRowVM = {
    id: opts.feature.id,
    state: opts.state,
    fulfills: opts.feature.fulfills,
    valStates,
  };
  if (opts.state === "running") {
    row.subagentName = opts.subagentName;
    if (opts.startedMs !== undefined) row.elapsedMs = Math.max(0, opts.now - opts.startedMs);
  }
  return row;
}

function pickRepresentative(subs: RunningSubagent[]): RunningSubagent {
  // Oldest subagent wins (smallest startedAt). If no parsable ts, first entry.
  let best = subs[0]!;
  let bestMs = parseIsoOrFallback(best.startedAt, Number.POSITIVE_INFINITY);
  for (let i = 1; i < subs.length; i++) {
    const sub = subs[i]!;
    const ms = parseIsoOrFallback(sub.startedAt, Number.POSITIVE_INFINITY);
    if (ms < bestMs) {
      best = sub;
      bestMs = ms;
    }
  }
  return best;
}

function parseIsoOrFallback(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Pick a short header label. Explicit name wins; otherwise we slice the
 * UUID-shaped charter id to its first 8 hex chars (the user-recognizable
 * prefix shown in `charter_status` output).
 */
function resolveDisplayName(charterId: string, name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return charterId.slice(0, 8);
}

/**
 * Build the 5-step planning pipeline VM. We can derive everything from the
 * already-loaded criteria + features arrays; no extra I/O. The 'critique'
 * step is intentionally always pending during planning — there's no first-
 * class signal that a planner-critic ran, so we don't try to fake one.
 */
function buildPlanningVM(criteria: CharterCriterion[], features: FeatureDefinition[]): PlanningVM {
  const fulfilledIds = new Set<string>();
  for (const f of features) for (const id of f.fulfills) fulfilledIds.add(id);
  const uncovered = criteria.filter((c) => !fulfilledIds.has(c.id)).map((c) => c.id);

  const criteriaDone = criteria.length > 0;
  const featuresDone = features.length > 0 && uncovered.length === 0;
  const featuresPartial = features.length > 0 && !featuresDone;

  const steps: PlanningStep[] = [
    { id: "create", state: "done", label: "Create charter" },
    {
      id: "criteria",
      state: criteriaDone ? "done" : "pending",
      label: "Define VAL criteria",
      detail: criteriaDone ? `${criteria.length} in charter.md` : undefined,
    },
    {
      id: "features",
      state: featuresDone ? "done" : featuresPartial ? "partial" : "pending",
      label: "Seed features",
      detail: features.length > 0
        ? `${features.length} features${uncovered.length > 0 ? ` · ${uncovered.length} uncovered` : ""}`
        : undefined,
    },
    { id: "critique", state: "pending", label: "Run charter-planner-critic" },
    { id: "lock", state: "pending", label: "charter_plan action=lock_plan" },
  ];

  return {
    steps,
    criteriaCount: criteria.length,
    featuresCount: features.length,
    uncoveredCriteria: uncovered,
    nextHint: planningNextHint(criteria, features, uncovered),
  };
}

function planningNextHint(
  criteria: CharterCriterion[],
  features: FeatureDefinition[],
  uncovered: string[],
): string {
  if (criteria.length === 0) {
    return "edit .pi/charters/<id>/charter.md to add VAL-* criteria";
  }
  if (features.length === 0) {
    return "charter_plan action=add_feature to seed features (fulfills[] → VAL ids)";
  }
  if (uncovered.length > 0) {
    const preview = uncovered.slice(0, 3).join(", ");
    const more = uncovered.length > 3 ? `, +${uncovered.length - 3} more` : "";
    return `charter_plan action=add_feature covering ${preview}${more}`;
  }
  return "subagent({agent:'charter-planner-critic'}) then charter_plan action=lock_plan";
}
