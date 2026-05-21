import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import type { CharterCriterion, CharterStatus, ParseWarning } from "../domain/types";
import { parseFeatureMarkdown, type FeatureDefinition } from "../domain/feature-md";
import { appendEvent, charterDir, loadCharterState, writeCharterState, writeJsonAtomic } from "../infrastructure/store";
import { assertNotV1NeedsReplan, nextActionsForStatus, type NextAction } from "./service";
import { CharterToolError } from "./errors";
import { dispatchHook } from "./hooks";
import { inspectArchitectureGate } from "./architecture-gate";
import { listBlockingReadinessFeatures } from "./readiness-service";

const FEATURE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface PlanView {
  charterId: string;
  criteria: CharterCriterion[];
  features: FeatureDefinition[];
  warnings: ParseWarning[];
  drift: {
    uncovered: CharterCriterion[];
    orphanFeatures: FeatureDefinition[];
    unknownFulfilledCriteria: Array<{ featureId: string; criterionId: string }>;
  };
  nextActions: NextAction[];
}

export async function viewPlan(projectDir: string, input: { charterId: string }): Promise<PlanView> {
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(projectDir, input.charterId);
  assertNotV1NeedsReplan(state);
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
    warnings: charter.warnings,
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
  input: { charterId: string; now?: string; legacy?: boolean },
): Promise<LockPlanResult> {
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(projectDir, input.charterId);
  assertNotV1NeedsReplan(state);
  if (state.status === "awaiting-clarification") {
    throw new CharterToolError("Cannot lock_plan while awaiting clarification.", {
      code: "lock_plan.awaiting_clarification",
      nextActions: [
        { tool: "charter_manage", action: "resume", hint: "Resume after the user provides clarification." },
        { tool: "charter_status", hint: "Inspect current status before retrying lock_plan." },
      ],
    });
  }
  if (state.status !== "planning") {
    throw new CharterToolError(`Cannot lock_plan from status ${state.status}; only planning is eligible.`, {
      code: "lock_plan.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; lock_plan is only legal in `planning`." },
        { tool: "charter_plan", action: "view", hint: "Inspect the existing plan without mutating state." },
      ],
    });
  }
  if (state.unansweredClarification === true) {
    throw new CharterToolError("Cannot lock_plan while a clarification remains unanswered.", {
      code: "lock_plan.unanswered_clarification",
      nextActions: [
        { tool: "charter_manage", action: "resume", hint: "Resume with acknowledgeClarification: true after the user provides clarification." },
        { tool: "charter_status", hint: "Inspect current status before retrying lock_plan." },
      ],
    });
  }
  const plan = await viewPlan(projectDir, { charterId: input.charterId });
  const failures: string[] = [];
  const hasCoverageDrift = plan.drift.uncovered.length > 0 || plan.drift.orphanFeatures.length > 0 || plan.drift.unknownFulfilledCriteria.length > 0;
  if (plan.criteria.length === 0) failures.push("charter.md has no VAL-* criteria");
  if (plan.features.length === 0) failures.push("plan/ has no feature files");
  if (plan.drift.uncovered.length) failures.push(`uncovered criteria: ${plan.drift.uncovered.map((c) => c.id).join(", ")}`);
  if (plan.drift.orphanFeatures.length) failures.push(`orphan features (empty fulfills): ${plan.drift.orphanFeatures.map((f) => f.id).join(", ")}`);
  if (plan.drift.unknownFulfilledCriteria.length) {
    const refs = plan.drift.unknownFulfilledCriteria.map((row) => `${row.featureId}->${row.criterionId}`).join(", ");
    failures.push(`features fulfill unknown criteria: ${refs}`);
  }
  const validationShapeFailures = implValidationShapeFailures(plan.features);
  if (validationShapeFailures.length) {
    const refs = validationShapeFailures.map((row) => `${row.featureId} missing ${row.missing.join(" and ")}`).join(", ");
    failures.push(`impl features missing validation checks: ${refs}`);
  }
  const readinessBlocking = await listBlockingReadinessFeatures(dir);
  if (readinessBlocking.length) {
    failures.push(`readiness blocking features: ${readinessBlocking.map((feature) => feature.featureId).join(", ")}`);
  }
  const architectureGate = await inspectArchitectureGate(projectDir, input.charterId, plan.features);
  if (architectureGate.required && !architectureGate.present) {
    failures.push(`missing architecture.md: ${architectureGate.expectedPath}`);
  }
  const cycle = detectPreconditionCycle(plan.features);
  if (cycle) failures.push(`precondition cycle: ${cycle.join(" -> ")}`);
  // Weak verifier BLOCKs (non-legacy only). Legacy charters defer both BLOCKs
  // to completeCharter so existing in-flight work keeps loading. Two distinct
  // failures so the error message stays specific:
  //  - missing Verifier line entirely (VAL-1)
  //  - manual verifier with no criterion-level Because (VAL-6)
  if (!input.legacy) {
    const missingVerifier = plan.warnings
      .filter((w) => w.reason === "missing-verifier")
      .map((w) => w.criterionId);
    if (missingVerifier.length) {
      failures.push(`missing Verifier: line: ${missingVerifier.join(", ")}`);
    }
    const weak = plan.criteria.filter((criterion) => criterion.verifier === "manual" && !criterion.because);
    if (weak.length) {
      failures.push(`weak verifier (manual + no Because): ${weak.map((c) => c.id).join(", ")}`);
    }
  }
  if (failures.length) {
    // Distinguish empty-criteria/empty-features from drift/cycle/weak-verifier
    // failure modes via code, but the nextActions[] pattern is the same:
    // re-view the plan and patch features until coverage is clean.
    let code = "lock_plan.drift";
    if (plan.criteria.length === 0) code = "lock_plan.empty_criteria";
    else if (plan.features.length === 0) code = "lock_plan.empty_features";
    else if (readinessBlocking.length) code = "lock_plan.readiness_blocking";
    else if (cycle) code = "lock_plan.cycle";
    else if (architectureGate.required && !architectureGate.present) code = "lock_plan.missing_architecture";
    else if (!input.legacy) {
      const missing = plan.warnings.filter((w) => w.reason === "missing-verifier");
      const weak = plan.criteria.filter((c) => c.verifier === "manual" && !c.because);
      if (missing.length) code = "lock_plan.missing_verifier";
      else if (weak.length) code = "lock_plan.weak_verifier";
    }
    if (code === "lock_plan.drift" && validationShapeFailures.length && !hasCoverageDrift) code = "lock_plan.validation_shape";
    const nextActions: NextAction[] = [
      { tool: "charter_plan", action: "view", hint: "Re-read plan coverage to see uncovered criteria, orphan features, and unknown fulfills links." },
      { tool: "charter_plan", action: "update_feature", hint: "Patch fulfills/preconditions on existing features to resolve drift before retrying lock_plan." },
      { tool: "charter_plan", action: "add_feature", hint: "Add a missing feature to cover an uncovered VAL-* criterion." },
      { tool: "charter_status", hint: "Inspect the full charter; lock_plan only transitions from planning." },
    ];
    throw new CharterToolError(`Cannot lock plan because of drift:\n - ${failures.join("\n - ")}`, {
      code,
      nextActions,
    });
  }

  const planDigest = digestFeatures(plan.features);
  const now = input.now ?? new Date().toISOString();
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
  assertNotV1NeedsReplan(state);
  if (state.status !== "planning") {
    throw new CharterToolError(`Cannot add_feature from status ${state.status}; only planning is eligible.`, {
      code: "add_feature.bad_status",
      nextActions: [
        { tool: "charter_plan", action: "view", hint: "Inspect current plan; add_feature is only legal in `planning`." },
        { tool: "charter_status", hint: "Inspect current status before retrying." },
      ],
    });
  }
  const dir = charterDir(projectDir, input.charterId);
  const planDir = join(dir, "plan");
  await mkdir(planDir, { recursive: true });
  const filePath = join(planDir, `${input.id}.md`);
  if (await fileExists(filePath)) {
    throw new CharterToolError(`Feature ${input.id} already exists; use charter_plan action=update_feature instead.`, {
      code: "add_feature.id_collision",
      nextActions: [
        { tool: "charter_plan", action: "update_feature", hint: `Use charter_plan action=update_feature with id='${input.id}' to modify the existing feature.` },
        { tool: "charter_plan", action: "view", hint: "Re-read the plan to pick a non-colliding feature id." },
      ],
    });
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

export interface FeatureEntry {
  id: string;
  milestone: string;
  order: number;
  fulfills: string[];
  preconditions?: string[];
  body: string;
}

export interface AddFeatureBatchInput {
  charterId: string;
  features: FeatureEntry[];
  now?: string;
}

export interface AddFeatureBatchResult {
  charterId: string;
  features: Array<{ featureId: string; order: number; path: string }>;
  message: string;
  nextActions: NextAction[];
}

/**
 * Atomic, order-preserving batch add_feature.
 *
 * Validates every entry up front, scans `plan/` once for id collisions, then
 * stages each `plan/<id>.md` to a temp path (`<final>.<pid>.<now>.<rand>.tmp`)
 * and commits via rename in request order. On any commit failure we unlink the
 * files we already renamed plus any leftover temps and re-throw. Events are
 * appended one `feature_added` per entry (matches the single-add tooling) only
 * after every rename succeeds; a failed batch leaves no events behind.
 *
 * VAL-6 carve-out applies symmetrically: this only proves within-call
 * atomicity. Concurrent-writer race elimination is out of scope.
 */
export async function addFeatureBatch(
  projectDir: string,
  input: AddFeatureBatchInput,
): Promise<AddFeatureBatchResult> {
  if (!Array.isArray(input.features) || input.features.length === 0) {
    throw new CharterToolError("addFeatureBatch requires a non-empty features array", {
      code: "add_feature.empty_batch",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `features: [{id, milestone, order, fulfills, body}, ...]` with at least one entry." },
      ],
    });
  }

  // 1. Validate every entry up front. Collect per-index failures so the
  //    aggregate error tells the caller which slot(s) were malformed.
  const failures: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < input.features.length; i++) {
    const entry = input.features[i];
    try {
      validateFeatureInput({
        charterId: input.charterId,
        id: entry?.id,
        milestone: entry?.milestone,
        order: entry?.order,
        fulfills: entry?.fulfills,
        preconditions: entry?.preconditions,
        body: entry?.body,
      } as AddFeatureInput);
    } catch (err) {
      failures.push({ index: i, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  // Duplicate ids within the same batch would silently overwrite each other
  // during the rename phase; treat as a validation failure on the duplicate.
  const seen = new Map<string, number>();
  for (let i = 0; i < input.features.length; i++) {
    const id = input.features[i]?.id;
    if (typeof id !== "string" || !id) continue;
    if (seen.has(id)) {
      failures.push({ index: i, reason: `duplicate id "${id}" in batch (first seen at index ${seen.get(id)})` });
    } else {
      seen.set(id, i);
    }
  }
  if (failures.length > 0) {
    const detail = failures.map((f) => `index ${f.index}: ${f.reason}`).join("; ");
    throw new CharterToolError(`add_feature batch validation failed: ${detail}`, {
      code: "add_feature.validation_failed",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Fix the indexed entry/entries (id must match /^[a-z0-9][a-z0-9_-]*$/i, non-empty milestone, finite order, non-empty fulfills, non-empty body) and retry the batch." },
        { tool: "charter_plan", action: "view", hint: "Inspect existing plan coverage before retrying." },
      ],
    });
  }

  const state = await loadCharterState(projectDir, input.charterId);
  assertNotV1NeedsReplan(state);
  if (state.status !== "planning") {
    throw new CharterToolError(`Cannot add_feature from status ${state.status}; only planning is eligible.`, {
      code: "add_feature.bad_status",
      nextActions: [
        { tool: "charter_plan", action: "view", hint: "Inspect current plan; add_feature is only legal in `planning`." },
        { tool: "charter_status", hint: "Inspect current status before retrying." },
      ],
    });
  }

  const dir = charterDir(projectDir, input.charterId);
  const planDir = join(dir, "plan");
  await mkdir(planDir, { recursive: true });

  // 2. Single scan of plan/ for id collisions; report ALL of them in one error.
  const existing = new Set<string>();
  try {
    for (const entry of await readdir(planDir)) {
      if (entry.endsWith(".md")) existing.add(entry.slice(0, -3));
    }
  } catch {
    // planDir was just mkdir'd; readdir failure means empty plan/.
  }
  const collisions = input.features
    .map((e, i) => ({ index: i, id: e.id }))
    .filter((row) => existing.has(row.id));
  if (collisions.length > 0) {
    const detail = collisions.map((c) => `index ${c.index}: feature ${c.id} already exists`).join("; ");
    const ids = collisions.map((c) => c.id);
    throw new CharterToolError(`add_feature batch id collision(s): ${detail}; use charter_plan action=update_feature instead.`, {
      code: "add_feature.id_collision",
      nextActions: [
        { tool: "charter_plan", action: "update_feature", hint: `Use charter_plan action=update_feature for the colliding id(s): ${ids.join(", ")}.` },
        { tool: "charter_plan", action: "view", hint: "Re-read the plan to pick non-colliding feature ids before retrying the batch." },
      ],
    });
  }

  // 3. Stage every write to a temp path so the visible plan/ stays untouched
  //    until we commit.
  const staged: Array<{ tempPath: string; finalPath: string; entry: FeatureEntry }> = [];
  try {
    for (const entry of input.features) {
      const finalPath = join(planDir, `${entry.id}.md`);
      const tempPath = `${finalPath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
      const markdown = renderFeatureMarkdown({
        charterId: input.charterId,
        id: entry.id,
        milestone: entry.milestone,
        order: entry.order,
        fulfills: entry.fulfills,
        preconditions: entry.preconditions,
        body: entry.body,
      });
      await writeFile(tempPath, markdown, "utf8");
      staged.push({ tempPath, finalPath, entry });
    }
  } catch (err) {
    // Staging failure (e.g. ENOSPC): best-effort unlink whatever temps landed,
    // then re-throw. No final files exist yet so plan.json is unaffected.
    for (const s of staged) {
      try { await unlink(s.tempPath); } catch { /* ignore */ }
    }
    throw err;
  }

  // 4. Commit phase: rename each temp -> final in REQUEST ORDER. On any
  //    failure roll back the renames we already did plus the leftover temps.
  const committed: Array<{ finalPath: string }> = [];
  try {
    for (const s of staged) {
      await rename(s.tempPath, s.finalPath);
      committed.push({ finalPath: s.finalPath });
    }
  } catch (err) {
    for (const c of committed) {
      try { await unlink(c.finalPath); } catch { /* ignore */ }
    }
    for (const s of staged) {
      try { await unlink(s.tempPath); } catch { /* ignore */ }
    }
    throw err;
  }

  // 5. Append events only after commit succeeds. One feature_added per entry
  //    keeps parity with the single-add path so log consumers (audit, widget)
  //    don't need to learn a batch shape.
  const now = input.now ?? new Date().toISOString();
  for (const entry of input.features) {
    await appendEvent(dir, {
      type: "feature_added",
      ts: now,
      charterId: input.charterId,
      featureId: entry.id,
      milestone: entry.milestone,
      fulfills: entry.fulfills,
    });
  }

  const ids = input.features.map((entry) => entry.id);
  return {
    charterId: input.charterId,
    features: input.features.map((entry) => ({
      featureId: entry.id,
      order: entry.order,
      path: join(planDir, `${entry.id}.md`),
    })),
    message: `Added ${input.features.length} feature(s): ${ids.join(", ")}.`,
    nextActions: [
      { tool: "charter_plan", action: "view", hint: "Re-read plan coverage after adding the features." },
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
  if (!FEATURE_ID_RE.test(input.id)) {
    throw new CharterToolError(`feature id must match ${FEATURE_ID_RE}; got "${input.id}"`, {
      code: "update_feature.bad_id",
      nextActions: [
        { tool: "charter_plan", action: "update_feature", hint: "Pass `id` matching /^[a-z0-9][a-z0-9_-]*$/i (slug-style, no spaces)." },
        { tool: "charter_plan", action: "view", hint: "List feature ids before retrying." },
      ],
    });
  }
  const state = await loadCharterState(projectDir, input.charterId);
  assertNotV1NeedsReplan(state);
  if (state.status !== "planning") {
    throw new CharterToolError(`Cannot update_feature from status ${state.status}; only planning is eligible.`, {
      code: "update_feature.bad_status",
      nextActions: [
        { tool: "charter_plan", action: "view", hint: "Inspect the plan; update_feature is only legal in `planning`." },
        { tool: "charter_status", hint: "Inspect current status before retrying." },
      ],
    });
  }
  const dir = charterDir(projectDir, input.charterId);
  const filePath = join(dir, "plan", `${input.id}.md`);
  let existing: FeatureDefinition;
  try {
    existing = parseFeatureMarkdown(await readFile(filePath, "utf8"));
  } catch {
    throw new CharterToolError(`Feature ${input.id} not found; use charter_plan action=add_feature to create it.`, {
      code: "update_feature.not_found",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: `Create feature '${input.id}' via charter_plan action=add_feature.` },
        { tool: "charter_plan", action: "view", hint: "List existing feature ids before retrying." },
      ],
    });
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
  if (!FEATURE_ID_RE.test(input.id)) {
    throw new CharterToolError(`feature id must match ${FEATURE_ID_RE}; got "${input.id}"`, {
      code: "add_feature.bad_id",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `id` matching /^[a-z0-9][a-z0-9_-]*$/i (slug-style, no spaces)." },
      ],
    });
  }
  if (!input.milestone?.trim?.()) {
    throw new CharterToolError("feature milestone is required", {
      code: "add_feature.missing_milestone",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `milestone: '<milestone-id>'` (e.g. 'm1-bootstrap')." },
      ],
    });
  }
  if (!Number.isFinite(input.order)) {
    throw new CharterToolError("feature order must be a finite number", {
      code: "add_feature.missing_order",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `order: <number>` (lower runs first within the milestone)." },
      ],
    });
  }
  if (!Array.isArray(input.fulfills) || input.fulfills.length === 0) {
    throw new CharterToolError("feature fulfills must list at least one VAL-* criterion id", {
      code: "add_feature.missing_fulfills",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `fulfills: ['VAL-...', ...]` with at least one criterion id." },
        { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying." },
      ],
    });
  }
  if (!input.body?.trim?.()) {
    throw new CharterToolError("feature body markdown is required", {
      code: "add_feature.missing_body",
      nextActions: [
        { tool: "charter_plan", action: "add_feature", hint: "Pass `body: '<feature markdown prose>'` (non-empty)." },
      ],
    });
  }
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

function implValidationShapeFailures(features: FeatureDefinition[]): Array<{ featureId: string; missing: string[] }> {
  return features
    .filter((feature) => feature.kind === "impl")
    .map((feature) => ({
      featureId: feature.id,
      missing: [
        feature.checks.happy.length === 0 ? "happy" : undefined,
        feature.checks.edge.length === 0 ? "edge" : undefined,
      ].filter((side): side is string => side !== undefined),
    }))
    .filter((failure) => failure.missing.length > 0);
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
