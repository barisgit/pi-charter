import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import type { CharterCriterion, CharterStatus } from "../domain/types";
import { parseFeatureMarkdown, type FeatureDefinition } from "../domain/feature-md";
import { appendEvent, charterDir, loadCharterState, writeCharterState, writeJsonAtomic } from "../infrastructure/store";
import { nextActionsForStatus, type NextAction } from "./service";

export interface PlanView {
  charterId: string;
  criteria: CharterCriterion[];
  features: FeatureDefinition[];
  drift: {
    uncovered: CharterCriterion[];
    orphanFeatures: FeatureDefinition[];
    unknownFulfilledCriteria: Array<{ featureId: string; criterionId: string }>;
  };
  nextActions: NextAction[];
}

export async function viewPlan(projectDir: string, input: { charterId: string }): Promise<PlanView> {
  const dir = charterDir(projectDir, input.charterId);
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const features = await readFeatures(join(dir, "plan"));
  const criteriaById = new Map(charter.criteria.map((criterion) => [criterion.id, criterion]));
  const fulfilled = new Set(features.flatMap((feature) => feature.fulfills));
  const uncovered = charter.criteria.filter((criterion) => !fulfilled.has(criterion.id));
  const orphanFeatures = features.filter((feature) => feature.fulfills.length === 0);
  const unknownFulfilledCriteria = features.flatMap((feature) =>
    feature.fulfills
      .filter((criterionId) => !criteriaById.has(criterionId))
      .map((criterionId) => ({ featureId: feature.id, criterionId })),
  );

  const view: PlanView = {
    charterId: input.charterId,
    criteria: charter.criteria,
    features,
    drift: { uncovered, orphanFeatures, unknownFulfilledCriteria },
    nextActions: nextActionsForPlan({ uncovered, orphanFeatures, unknownFulfilledCriteria }),
  };
  await writeJsonAtomic(join(dir, "plan.json"), {
    charterId: input.charterId,
    features: features.map(({ body: _body, ...feature }) => feature),
    drift: {
      uncovered: uncovered.map((criterion) => criterion.id),
      orphanFeatures: orphanFeatures.map((feature) => feature.id),
      unknownFulfilledCriteria,
    },
  });
  return view;
}

async function readFeatures(planDir: string): Promise<FeatureDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(planDir);
  } catch {
    return [];
  }
  const features: FeatureDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    features.push(parseFeatureMarkdown(await readFile(join(planDir, entry), "utf8")));
  }
  return features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function nextActionsForPlan(drift: PlanView["drift"]): NextAction[] {
  const actions: NextAction[] = [{ tool: "charter_plan", action: "view", hint: "Re-read plan coverage after edits." }];
  if (drift.uncovered.length || drift.orphanFeatures.length || drift.unknownFulfilledCriteria.length) {
    actions.push({ tool: "charter_plan", action: "update_feature", hint: "Fix uncovered criteria, orphan features, or unknown fulfills links before locking." });
  } else {
    actions.push({ tool: "charter_plan", action: "lock_plan", hint: "Run planner checks and transition to active if hooks allow." });
  }
  actions.push({ tool: "charter_status", hint: "Inspect full charter status and legal lifecycle moves." });
  return actions;
}

export interface LockPlanResult {
  charterId: string;
  status: CharterStatus;
  planDigest: string;
  featureCount: number;
  message: string;
  nextActions: NextAction[];
}

export async function lockPlan(
  projectDir: string,
  input: { charterId: string; now?: string },
): Promise<LockPlanResult> {
  const state = await loadCharterState(projectDir, input.charterId);
  if (state.status !== "planning") throw new Error(`Cannot lock_plan from status ${state.status}; only planning is eligible.`);
  const plan = await viewPlan(projectDir, { charterId: input.charterId });
  const failures: string[] = [];
  if (plan.criteria.length === 0) failures.push("charter.md has no VAL-* criteria");
  if (plan.features.length === 0) failures.push("plan/ has no feature files");
  if (plan.drift.uncovered.length) failures.push(`uncovered criteria: ${plan.drift.uncovered.map((c) => c.id).join(", ")}`);
  if (plan.drift.orphanFeatures.length) failures.push(`orphan features (empty fulfills): ${plan.drift.orphanFeatures.map((f) => f.id).join(", ")}`);
  if (plan.drift.unknownFulfilledCriteria.length) {
    const refs = plan.drift.unknownFulfilledCriteria.map((row) => `${row.featureId}->${row.criterionId}`).join(", ");
    failures.push(`features fulfill unknown criteria: ${refs}`);
  }
  const cycle = detectPreconditionCycle(plan.features);
  if (cycle) failures.push(`precondition cycle: ${cycle.join(" -> ")}`);
  if (failures.length) throw new Error(`Cannot lock plan because of drift:\n - ${failures.join("\n - ")}`);

  const planDigest = digestFeatures(plan.features);
  const now = input.now ?? new Date().toISOString();
  const dir = charterDir(projectDir, input.charterId);
  state.status = "active";
  state.planDigest = planDigest;
  state.updatedAt = now;
  await writeCharterState(dir, state);
  await appendEvent(dir, {
    type: "plan_locked",
    ts: now,
    charterId: state.charterId,
    planDigest,
    featureCount: plan.features.length,
  });
  return {
    charterId: state.charterId,
    status: state.status,
    planDigest,
    featureCount: plan.features.length,
    message: `Locked plan for ${state.charterId} with ${plan.features.length} feature(s); status -> active.`,
    nextActions: nextActionsForStatus(state.status),
  };
}

function detectPreconditionCycle(features: FeatureDefinition[]): string[] | undefined {
  const ids = new Set(features.map((f) => f.id));
  const graph = new Map(features.map((f) => [f.id, f.preconditions.filter((p) => ids.has(p))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of graph.keys()) color.set(id, WHITE);
  const stack: string[] = [];
  function dfs(node: string): string[] | undefined {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (color.get(next) === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return undefined;
  }
  for (const id of graph.keys()) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return undefined;
}

function digestFeatures(features: FeatureDefinition[]): string {
  const canonical = JSON.stringify(
    features.map((feature) => ({
      id: feature.id,
      milestone: feature.milestone,
      order: feature.order,
      fulfills: [...feature.fulfills].sort(),
      preconditions: [...feature.preconditions].sort(),
    })),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
