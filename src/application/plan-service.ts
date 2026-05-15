import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import type { CharterCriterion, CharterStatus } from "../domain/types";
import { parseFeatureMarkdown, type FeatureDefinition } from "../domain/feature-md";
import { appendEvent, charterDir, loadCharterState, writeCharterState, writeJsonAtomic } from "../infrastructure/store";
import { nextActionsForStatus, type NextAction } from "./service";
import { dispatchHook } from "./hooks";

const FEATURE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

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
  await dispatchHook("charter:before_lock_plan", {
    type: "charter:before_lock_plan",
    charterId: state.charterId,
    ts: now,
    planDigest,
    featureCount: plan.features.length,
  });
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

export interface AddFeatureInput {
  charterId: string;
  id: string;
  milestone: string;
  order: number;
  fulfills: string[];
  preconditions?: string[];
  body: string;
  now?: string;
}

export interface FeatureWriteResult {
  charterId: string;
  featureId: string;
  path: string;
  message: string;
  nextActions: NextAction[];
}

export async function addFeature(projectDir: string, input: AddFeatureInput): Promise<FeatureWriteResult> {
  validateFeatureInput(input);
  const state = await loadCharterState(projectDir, input.charterId);
  if (state.status !== "planning") {
    throw new Error(`Cannot add_feature from status ${state.status}; only planning is eligible.`);
  }
  const dir = charterDir(projectDir, input.charterId);
  const planDir = join(dir, "plan");
  await mkdir(planDir, { recursive: true });
  const filePath = join(planDir, `${input.id}.md`);
  if (await fileExists(filePath)) {
    throw new Error(`Feature ${input.id} already exists; use charter_plan action=update_feature instead.`);
  }
  const markdown = renderFeatureMarkdown(input);
  await writeFile(filePath, markdown, "utf8");
  const now = input.now ?? new Date().toISOString();
  await appendEvent(dir, {
    type: "feature_added",
    ts: now,
    charterId: input.charterId,
    featureId: input.id,
    milestone: input.milestone,
    fulfills: input.fulfills,
  });
  return {
    charterId: input.charterId,
    featureId: input.id,
    path: filePath,
    message: `Added feature ${input.id} (milestone=${input.milestone}, fulfills=[${input.fulfills.join(", ")}]).`,
    nextActions: [
      { tool: "charter_plan", action: "view", hint: "Re-read plan coverage after adding the feature." },
      { tool: "charter_plan", action: "add_feature", hint: "Add the next feature, or move to lock_plan when coverage is complete." },
      { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan once every criterion has a fulfilling feature." },
    ],
  };
}

export interface UpdateFeatureInput {
  charterId: string;
  id: string;
  milestone?: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  body?: string;
  now?: string;
}

export async function updateFeature(projectDir: string, input: UpdateFeatureInput): Promise<FeatureWriteResult> {
  if (!FEATURE_ID_RE.test(input.id)) throw new Error(`feature id must match ${FEATURE_ID_RE}; got "${input.id}"`);
  const state = await loadCharterState(projectDir, input.charterId);
  if (state.status !== "planning") {
    throw new Error(`Cannot update_feature from status ${state.status}; only planning is eligible.`);
  }
  const dir = charterDir(projectDir, input.charterId);
  const filePath = join(dir, "plan", `${input.id}.md`);
  let existing: FeatureDefinition;
  try {
    existing = parseFeatureMarkdown(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`Feature ${input.id} not found; use charter_plan action=add_feature to create it.`);
  }
  const merged: AddFeatureInput = {
    charterId: input.charterId,
    id: existing.id,
    milestone: input.milestone ?? existing.milestone,
    order: input.order ?? existing.order,
    fulfills: input.fulfills ?? existing.fulfills,
    preconditions: input.preconditions ?? existing.preconditions,
    body: input.body ?? existing.body,
  };
  validateFeatureInput(merged);
  await writeFile(filePath, renderFeatureMarkdown(merged), "utf8");
  const now = input.now ?? new Date().toISOString();
  await appendEvent(dir, {
    type: "feature_updated",
    ts: now,
    charterId: input.charterId,
    featureId: input.id,
    milestone: merged.milestone,
    fulfills: merged.fulfills,
  });
  return {
    charterId: input.charterId,
    featureId: input.id,
    path: filePath,
    message: `Updated feature ${input.id} (milestone=${merged.milestone}, fulfills=[${merged.fulfills.join(", ")}]).`,
    nextActions: [
      { tool: "charter_plan", action: "view", hint: "Re-read plan coverage after the update." },
      { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan once every criterion has a fulfilling feature." },
    ],
  };
}

function validateFeatureInput(input: AddFeatureInput): void {
  if (!FEATURE_ID_RE.test(input.id)) throw new Error(`feature id must match ${FEATURE_ID_RE}; got "${input.id}"`);
  if (!input.milestone.trim()) throw new Error("feature milestone is required");
  if (!Number.isFinite(input.order)) throw new Error("feature order must be a finite number");
  if (!Array.isArray(input.fulfills) || input.fulfills.length === 0) {
    throw new Error("feature fulfills must list at least one VAL-* criterion id");
  }
  if (!input.body.trim()) throw new Error("feature body markdown is required");
}

function renderFeatureMarkdown(input: AddFeatureInput): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${input.id}`);
  lines.push(`milestone: ${input.milestone}`);
  lines.push(`order: ${input.order}`);
  if (input.fulfills.length === 0) {
    lines.push("fulfills: []");
  } else {
    lines.push("fulfills:");
    for (const value of input.fulfills) lines.push(`  - ${value}`);
  }
  const preconditions = input.preconditions ?? [];
  if (preconditions.length === 0) {
    lines.push("preconditions: []");
  } else {
    lines.push("preconditions:");
    for (const value of preconditions) lines.push(`  - ${value}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(input.body.trim());
  lines.push("");
  return lines.join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
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
