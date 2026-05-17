import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent, charterDir, createCharterWorkspace, loadCharterIndex, loadCharterState, writeCharterState } from "../infrastructure/store";
import { loadCriterionState, loadFeatureState, type CriterionStateFile, type CriterionStateRecord, type FeatureStateFile } from "./record-service";
import { parseFeatureMarkdown } from "../domain/feature-md";
import { computeDrift } from "./drift-service";
import { dispatchHook } from "./hooks";
import { parseCharterMarkdown } from "../domain/charter-md";
import { trustRank } from "../domain/trust-rank";
import type { Budget, CharterCriterion, CharterState, CharterStatus, EvidenceSource } from "../domain/types";

export interface NextAction {
  tool: "charter_manage" | "charter_plan" | "charter_record" | "charter_status" | "subagent";
  action?: string;
  hint: string;
  /**
   * Optional structured metadata for tool-specific routing. Currently used by
   * milestone-review next actions ({ milestoneId, criterionIds }) so the
   * agent can spawn a charter-verifier subagent with the right scope without
   * re-parsing the hint string.
   */
  metadata?: Record<string, unknown>;
}

export interface CharterServiceResult<T = unknown> {
  charterId: string;
  status: CharterStatus;
  message: string;
  data?: T;
  nextActions: NextAction[];
}

export interface BlockingForCompleteEntry {
  criterionId: string;
  /** Short human-readable reason consumed by `formatCharterStatusText`. */
  reason: string;
}

export interface CharterStatusDetails {
  /**
   * Per-criterion view of pass evidence the completion gate considers too
   * low-trust to accept. A criterion only appears here when it HAS pass
   * evidence but that evidence fails the trust rule (manual+because from
   * a non-charter-verifier writer). Missing-evidence gaps are still surfaced
   * by completeCharter's existing "no pass evidence yet" error and by drift.
   */
  blockingForComplete: BlockingForCompleteEntry[];
}

export interface CharterStatusResult {
  charterId: string;
  name?: string;
  status: CharterStatus;
  phase: "planning" | "active" | "review" | "terminal";
  objective: string;
  budget?: Budget;
  evaluator: { lastVerdict?: string; lastReason?: string; lastTs?: string };
  drift: {
    uncovered: { criterionId: string; reason: string }[];
    stuck: { featureId: string; status: string; startedAt?: string }[];
    stale: { criterionId: string; ageMs: number; lastTs: string }[];
    readyNext: { featureId: string; fulfills: string[] }[];
  };
  guidelines: string[];
  nextActions: NextAction[];
  details?: CharterStatusDetails;
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; name?: string; budget?: Budget; idempotencyKey?: string; charterId?: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const objective = input.objective.trim();
  if (!objective) throw new Error("objective is required");
  const now = input.now ?? new Date().toISOString();
  const charterId = input.charterId ?? randomUUID();
  const name = sanitizeCharterName(input.name);
  const created = await createCharterWorkspace(projectDir, { charterId, name, objective, budget: input.budget, now, sessionId: input.sessionId });
  return {
    charterId,
    status: created.state.status,
    message: `Created charter ${charterId} in planning state.`,
    data: created.state,
    nextActions: nextActionsForStatus(created.state.status),
  };
}

export async function getCharterStatus(
  projectDir: string,
  input: { charterId?: string } = {},
): Promise<CharterStatusResult> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const drift = await computeDrift(projectDir, { charterId });
  const blockingForComplete = await computeBlockingForCompleteSafely(dir, charterId);
  const milestoneReviewActions = await computeMilestoneReviewNextActionsSafely(dir);
  return {
    charterId: state.charterId,
    name: state.name,
    status: state.status,
    phase: phaseForStatus(state.status),
    objective: state.objective,
    budget: state.budget,
    evaluator: {},
    drift,
    guidelines: guidelinesForStatus(state.status),
    nextActions: [...nextActionsForStatus(state.status), ...milestoneReviewActions],
    details: { blockingForComplete },
  };
}

/**
 * Scan events.jsonl for `milestone_ready_for_review` events whose criterionIds
 * have not yet been fully covered by a later charter-verifier evidence record.
 * Append one nextAction per unreviewed milestone.
 */
async function computeMilestoneReviewNextActionsSafely(dir: string): Promise<NextAction[]> {
  try {
    return await computeMilestoneReviewNextActions(dir);
  } catch {
    return [];
  }
}

export interface UnreviewedMilestone {
  milestoneId: string;
  planDigest: string;
  criterionIds: string[];
  /** Timestamp of the originating milestone_ready_for_review event. */
  readyTs: string;
}

/**
 * Pure helper consumed by both `getCharterStatus` and the evaluator. Reads
 * `events.jsonl` and `criterion-state.json`, returns the set of
 * milestone_ready_for_review events whose criterionIds are not yet fully
 * covered by charter-verifier-attributed pass evidence.
 *
 * Coverage is decided by `criterion-state.recordedBy` starting with
 * `subagent:charter-verifier:` (the authoritative identity prefix written by
 * applyHandoff), not by event payloads. This keeps the surface honest when
 * other persona subagents also write evidence.
 */
export async function listUnreviewedMilestones(dir: string): Promise<UnreviewedMilestone[]> {
  const eventsPath = join(dir, "events.jsonl");
  let raw = "";
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch {
    return [];
  }
  // Keep only the latest milestone_ready_for_review per milestoneId. Re-
  // completion under a new planDigest emits a fresh event, so the latest
  // event always reflects the current `(milestoneId, planDigest)` tuple.
  const readyByMilestone = new Map<string, { ts: string; planDigest: string; criterionIds: string[] }>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "milestone_ready_for_review") continue;
    const milestoneId = typeof event.milestoneId === "string" ? event.milestoneId : undefined;
    const planDigest = typeof event.planDigest === "string" ? event.planDigest : "";
    const ts = typeof event.ts === "string" ? event.ts : "";
    const criterionIds = Array.isArray(event.criterionIds)
      ? event.criterionIds.filter((id): id is string => typeof id === "string")
      : [];
    if (!milestoneId) continue;
    const prev = readyByMilestone.get(milestoneId);
    if (!prev || ts >= prev.ts) {
      readyByMilestone.set(milestoneId, { ts, planDigest, criterionIds });
    }
  }
  if (readyByMilestone.size === 0) return [];

  // VAL-11 contract: a milestone counts as reviewed iff every criterionId has
  // AT LEAST ONE evidence record where `recordedBy` starts with
  // `subagent:charter-verifier:` and `ts >= milestone_ready_for_review.ts`.
  // Latest-record-in-criterion-state is not enough; a later agent:root
  // record would otherwise clobber a valid charter-verifier review.
  const verifierReviewsByCriterion = await loadCharterVerifierReviewsByCriterion(dir);
  const unreviewed: UnreviewedMilestone[] = [];
  for (const [milestoneId, ready] of readyByMilestone) {
    const missing = ready.criterionIds.filter((id) => {
      const reviews = verifierReviewsByCriterion.get(id) ?? [];
      return !reviews.some((review) => review.ts >= ready.ts);
    });
    if (missing.length === 0) continue;
    unreviewed.push({
      milestoneId,
      planDigest: ready.planDigest,
      criterionIds: ready.criterionIds,
      readyTs: ready.ts,
    });
  }
  return unreviewed;
}

/**
 * Walk work/<featureId>/evidence/*.json and collect every pass evidence record
 * whose `recordedBy` is `subagent:charter-verifier:*`, keyed by criterionId,
 * with the record `ts`. VAL-11 uses this to compare against milestone_ready_for_review.ts.
 */
async function loadCharterVerifierReviewsByCriterion(dir: string): Promise<Map<string, { ts: string }[]>> {
  const out = new Map<string, { ts: string }[]>();
  const workDir = join(dir, "work");
  let featureDirs: string[];
  try {
    featureDirs = await readdir(workDir);
  } catch {
    return out;
  }
  for (const featureSegment of featureDirs) {
    const evidenceDir = join(workDir, featureSegment, "evidence");
    let evidenceFiles: string[];
    try {
      evidenceFiles = await readdir(evidenceDir);
    } catch {
      continue;
    }
    for (const file of evidenceFiles) {
      if (!file.endsWith(".json")) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await readFile(join(evidenceDir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.outcome !== "pass") continue;
      const criterionId = typeof parsed.criterionId === "string" ? parsed.criterionId : undefined;
      const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : undefined;
      const ts = typeof parsed.ts === "string" ? parsed.ts : undefined;
      if (!criterionId || !recordedBy || !ts) continue;
      if (!recordedBy.startsWith("subagent:charter-verifier:")) continue;
      const list = out.get(criterionId) ?? [];
      list.push({ ts });
      out.set(criterionId, list);
    }
  }
  return out;
}

async function computeMilestoneReviewNextActions(dir: string): Promise<NextAction[]> {
  const unreviewed = await listUnreviewedMilestones(dir);
  return unreviewed.map((entry) => ({
    tool: "subagent" as const,
    hint: `Delegate to charter-verifier for milestone ${entry.milestoneId} (criteria: ${entry.criterionIds.join(", ")}).`,
    metadata: { milestoneId: entry.milestoneId, criterionIds: entry.criterionIds },
  }));
}

async function computeBlockingForCompleteSafely(dir: string, charterId: string): Promise<BlockingForCompleteEntry[]> {
  try {
    const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
    const criterionState = await loadCriterionState(dir, charterId);
    const context = await loadBlockingContext(dir, charterId);
    return computeBlockingForComplete(charter.criteria, criterionState, context);
  } catch {
    return [];
  }
}

export async function pauseCharter(
  projectDir: string,
  input: { charterId?: string; now?: string; reason?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (isTerminal(state.status)) throw new Error(`Cannot pause terminal charter in status ${state.status}`);
  if (state.status !== "paused") {
    state.previousStatus = state.status;
    state.status = "paused";
    state.updatedAt = input.now ?? new Date().toISOString();
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_paused", ts: state.updatedAt, charterId: state.charterId, reason: input.reason });
  }
  return {
    charterId: state.charterId,
    status: state.status,
    message: `Paused charter ${state.charterId}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

export async function completeCharter(
  projectDir: string,
  input: { charterId?: string; completionNote?: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active" && state.status !== "review") {
    throw new Error(`Cannot complete charter in status ${state.status}; resume or amend first.`);
  }
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterionState = await loadCriterionState(dir, charterId);
  const context = await loadBlockingContext(dir, charterId);
  const failures = checkCompletionGate(charter.criteria, criterionState, state, context);
  const blocking = computeBlockingForComplete(charter.criteria, criterionState, context);
  if (blocking.length > 0) {
    // Render `<id>(<reason>)` per VAL so identity-disjoint and
    // requires-charter-verifier rejections are distinguishable from generic
    // low-trust evidence in the user-facing error string. The summary line
    // keeps the legacy `low-trust evidence for N VAL(s): ...` phrasing so
    // existing tests grepping for VAL ids continue to match.
    const idsWithReasons = blocking.map((entry) => `${entry.criterionId}(${entry.reason})`).join(", ");
    failures.push(`low-trust evidence for ${blocking.length} VAL(s): ${idsWithReasons}`);
  }
  if (failures.length > 0) {
    const message = [
      `Cannot complete charter:`,
      ` - ${failures.join("\n - ")}`,
      ...(blocking.length > 0
        ? ["Fix: add Because: rationale and run charter-verifier (subagent({agent:'charter-verifier'})) for the listed VALs."]
        : []),
    ].join("\n");
    throw new Error(message);
  }
  const now = input.now ?? new Date().toISOString();
  await dispatchHook("charter:before_complete", {
    type: "charter:before_complete",
    charterId,
    ts: now,
    criteriaCount: charter.criteria.length,
    completionNote: input.completionNote?.trim() || undefined,
  });
  state.status = "completed";
  state.previousStatus = undefined;
  state.completedAt = now;
  state.updatedAt = now;
  state.completionReason = input.completionNote?.trim() || undefined;
  // Note: we intentionally keep state.sessionId + reverse pointer here so the
  // widget can render its single-line terminal strip for the rest of the
  // current session. The binding is released on the NEXT session_start
  // (see registerCharterFlags) when a fresh session boots and the bound
  // charter is already terminal.
  await writeCharterState(dir, state);
  await appendEvent(dir, {
    type: "charter_completed",
    ts: now,
    charterId,
    completionNote: state.completionReason,
    criteriaCount: charter.criteria.length,
  });
  return {
    charterId,
    status: state.status,
    message: `Completed charter ${charterId}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

export async function forceCompleteCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; target?: "completed" | "abandoned" | "budget_limited"; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const reason = input.reason?.trim();
  if (!reason) throw new Error("force_complete requires a non-empty reason.");
  const target = input.target ?? "abandoned";
  if (!isTerminal(target)) throw new Error(`force_complete target must be terminal; got ${target}.`);
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (isTerminal(state.status)) throw new Error(`Charter ${charterId} is already terminal (${state.status}).`);
  const now = input.now ?? new Date().toISOString();
  await dispatchHook("charter:before_force_complete", {
    type: "charter:before_force_complete",
    charterId,
    ts: now,
    target,
    reason,
  });
  state.previousStatus = state.status;
  state.status = target;
  state.updatedAt = now;
  state.completionReason = reason;
  if (target === "completed") state.completedAt = now;
  else state.terminatedAt = now;
  // Binding release deferred to next session_start (see completeCharter).
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_force_completed", ts: now, charterId, target, reason });
  return {
    charterId,
    status: state.status,
    message: `Force-completed charter ${charterId} as ${target}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

export async function amendCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; target?: "planning" | "review"; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const reason = input.reason?.trim();
  if (!reason) throw new Error("amend_charter requires a non-empty reason.");
  const target = input.target ?? "review";
  if (target !== "planning" && target !== "review") throw new Error(`amend_charter target must be planning or review; got ${target}.`);
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (!isTerminal(state.status)) {
    throw new Error(`amend_charter only re-opens terminal charters; current status is ${state.status}.`);
  }
  const now = input.now ?? new Date().toISOString();
  await dispatchHook("charter:before_amend_charter", {
    type: "charter:before_amend_charter",
    charterId,
    ts: now,
    target,
    reason,
  });
  state.previousStatus = state.status;
  state.status = target;
  state.updatedAt = now;
  state.completedAt = undefined;
  state.terminatedAt = undefined;
  state.completionReason = undefined;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_amended", ts: now, charterId, target, reason });
  return {
    charterId,
    status: state.status,
    message: `Amended charter ${charterId} back into ${target}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

/**
 * Extra inputs used by `computeBlockingForComplete` to evaluate the
 * `requireReviewSubagent` auto-default (VAL-12) and the identity-disjoint
 * predicate (VAL-13). When omitted, the function behaves as it did before
 * m4: only the trust gate applies and `requireReviewSubagent` defaults to
 * the criterion's declared (or undefined-as-false) value.
 */
export interface BlockingContext {
  /** Union of criterionIds across every milestone_ready_for_review event. */
  milestoneCriterionIds: Set<string>;
  /** Map criterionId -> implementer session id pulled from feature-state.lastWorkerSessionId. */
  implementerSessionByCriterion: Map<string, string>;
  /** Map criterionId -> every pass evidence record's recordedBy on disk. */
  passRecordedByCriterion: Map<string, string[]>;
}

/**
 * Resolve the effective `requireReviewSubagent` flag for a criterion.
 *
 * Tri-state rule (VAL-12):
 *   - explicit `true`  → true (declared by author)
 *   - explicit `false` → false (author opted out; honored even when the
 *     criterion is covered by a milestone_ready_for_review event)
 *   - omitted (undefined) → auto-default to true when the criterion id is
 *     in any milestone_ready_for_review event's criterionIds; otherwise
 *     false.
 */
export function effectiveRequireReviewSubagent(
  criterion: CharterCriterion,
  milestoneCriterionIds: ReadonlySet<string>,
): boolean {
  if (criterion.requireReviewSubagent === true) return true;
  if (criterion.requireReviewSubagent === false) return false;
  return milestoneCriterionIds.has(criterion.id);
}

/**
 * Shared trust-gate computation used by both `completeCharter` (to block) and
 * `getCharterStatus` (to surface). A criterion shows up here when:
 *   - it has pass evidence AND that evidence is low-trust (manual or
 *     manual+because) AND the writer isn't a charter-verifier subagent; OR
 *   - effective `requireReviewSubagent` is true and no pass evidence has a
 *     `subagent:charter-verifier:` writer; OR
 *   - effective `requireReviewSubagent` is true and every pass evidence
 *     shares its session id with the implementing feature
 *     (`implementer-only-reviewer`).
 *
 * Criteria with no pass evidence are surfaced separately by
 * `checkCompletionGate`.
 */
export function computeBlockingForComplete(
  criteria: CharterCriterion[],
  criterionState: CriterionStateFile,
  context?: BlockingContext,
): BlockingForCompleteEntry[] {
  const blocking: BlockingForCompleteEntry[] = [];
  const milestoneIds = context?.milestoneCriterionIds ?? new Set<string>();
  for (const criterion of criteria) {
    const record = criterionState.criteria[criterion.id];
    if (!record || record.outcome !== "pass") continue;
    const trustReason = blockingReason(record);
    const effectiveReview = effectiveRequireReviewSubagent(criterion, milestoneIds);
    if (effectiveReview && context) {
      const allPass = context.passRecordedByCriterion.get(criterion.id) ?? [];
      const reviewerRecords = allPass.filter((rb) => rb.startsWith("subagent:charter-verifier:"));
      if (reviewerRecords.length === 0) {
        blocking.push({ criterionId: criterion.id, reason: "requires-charter-verifier" });
        continue;
      }
      const implementerSession = context.implementerSessionByCriterion.get(criterion.id);
      if (implementerSession) {
        const allShareImplementer = reviewerRecords.every((rb) =>
          extractSessionId(rb) === implementerSession,
        );
        if (allShareImplementer) {
          blocking.push({ criterionId: criterion.id, reason: "implementer-only-reviewer" });
          continue;
        }
      }
      // Charter-verifier evidence present and at least one reviewer is
      // session-disjoint from the implementer; the review gate is satisfied,
      // so the trust reason (if any) is also satisfied for this criterion.
      continue;
    }
    if (trustReason) blocking.push({ criterionId: criterion.id, reason: trustReason });
  }
  return blocking;
}

/**
 * Extract the trailing `<sessionId>` segment from a recordedBy string of the
 * form `subagent:<persona>:<sessionId>`. Returns undefined when the input
 * does not match the subagent shape.
 */
function extractSessionId(recordedBy: string): string | undefined {
  if (!recordedBy.startsWith("subagent:")) return undefined;
  const parts = recordedBy.split(":");
  if (parts.length < 3) return undefined;
  return parts.slice(2).join(":");
}

function blockingReason(record: CriterionStateRecord): string | undefined {
  const recordedBy = record.recordedBy ?? "agent:root";
  // A charter-verifier subagent always clears the trust gate, regardless of
  // declared source. The string-prefix match keeps the persona name authoritative.
  if (recordedBy.startsWith("subagent:charter-verifier:")) return undefined;
  const source: EvidenceSource = record.source ?? "manual";
  const hasBecause = Boolean(record.because && record.because.trim());
  const rank = trustRank({ recordedBy, source, hasBecause });
  if (rank > 1) return undefined;
  if (source !== "manual") {
    // High-trust source (verifier/hook/subagent) recorded by a non-charter-verifier
    // writer is rare but still passes the gate; only manual lands here.
    return undefined;
  }
  return hasBecause ? "manual+because" : "manual";
}

function checkCompletionGate(
  criteria: CharterCriterion[],
  criterionState: { criteria: Record<string, { outcome: string; lastTs: string; source?: string; lastFeatureId?: string }> },
  state: CharterState,
  context?: BlockingContext,
): string[] {
  const failures: string[] = [];
  const freshnessWindowMs = 24 * 60 * 60 * 1000;
  const lockTs = state.updatedAt;
  const milestoneIds = context?.milestoneCriterionIds ?? new Set<string>();
  for (const criterion of criteria) {
    const record = criterionState.criteria[criterion.id];
    if (!record || record.outcome !== "pass") {
      failures.push(`${criterion.id}: no pass evidence yet`);
      continue;
    }
    if (criterion.requireFreshEvidence) {
      const ageMs = Date.now() - Date.parse(record.lastTs);
      const lockedAgeMs = Date.parse(record.lastTs) - Date.parse(lockTs);
      if (lockedAgeMs < 0) {
        failures.push(`${criterion.id}: evidence predates plan lock`);
        continue;
      }
      if (Number.isFinite(ageMs) && ageMs > freshnessWindowMs) {
        failures.push(`${criterion.id}: evidence older than ${Math.round(freshnessWindowMs / 3600000)}h freshness window`);
        continue;
      }
    }
    if (effectiveRequireReviewSubagent(criterion, milestoneIds)) {
      const source = (record as { source?: string }).source;
      if (source !== "verifier" && source !== "subagent") {
        failures.push(`${criterion.id}: requires review subagent evidence (got ${source ?? "manual"})`);
      }
    }
  }
  return failures;
}

/**
 * Read events.jsonl, feature-state.json, plan/*.md, and the work/ evidence
 * tree to assemble the inputs `computeBlockingForComplete` needs to evaluate
 * the requireReviewSubagent auto-default (VAL-12) and identity-disjoint
 * predicate (VAL-13). Returns empty maps on missing/unreadable inputs so
 * callers can safely fall back to the trust-gate-only behaviour.
 */
export async function loadBlockingContext(dir: string, charterId: string): Promise<BlockingContext> {
  const milestoneCriterionIds = await loadMilestoneReadyCriterionIds(dir);
  const featureForCriterion = await loadFeatureForCriterion(dir);
  const featureState = await loadFeatureStateSafe(dir, charterId);
  const implementerSessionByCriterion = new Map<string, string>();
  for (const [criterionId, featureId] of featureForCriterion) {
    const sessionId = featureState.features[featureId]?.lastWorkerSessionId;
    if (sessionId) implementerSessionByCriterion.set(criterionId, sessionId);
  }
  const passRecordedByCriterion = await loadPassRecordedByCriterion(dir);
  return { milestoneCriterionIds, implementerSessionByCriterion, passRecordedByCriterion };
}

async function loadMilestoneReadyCriterionIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let raw = "";
  try {
    raw = await readFile(join(dir, "events.jsonl"), "utf8");
  } catch {
    return ids;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type !== "milestone_ready_for_review") continue;
    const criterionIds = Array.isArray(event.criterionIds) ? event.criterionIds : [];
    for (const id of criterionIds) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

async function loadFeatureForCriterion(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(join(dir, "plan"));
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const feature = parseFeatureMarkdown(await readFile(join(dir, "plan", entry), "utf8"));
      for (const criterionId of feature.fulfills) {
        // First feature that claims a criterion wins. Multi-feature
        // coverage is rare; identity-disjoint check only fires when a
        // single implementer covers every reviewer record, so picking one
        // representative implementer is sufficient for the predicate.
        if (!map.has(criterionId)) map.set(criterionId, feature.id);
      }
    } catch {
      // ignore malformed feature files
    }
  }
  return map;
}

async function loadFeatureStateSafe(dir: string, charterId: string): Promise<FeatureStateFile> {
  try {
    return await loadFeatureState(dir, charterId);
  } catch {
    return { charterId, features: {} };
  }
}

/**
 * Walk work/<featureId>/evidence/<criterionId>__<stamp>.json and collect every
 * pass evidence record's `recordedBy` keyed by criterionId. We need every
 * record (not just the latest in criterion-state) so the identity-disjoint
 * predicate can demand at least one session-disjoint reviewer.
 */
async function loadPassRecordedByCriterion(dir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const workDir = join(dir, "work");
  let featureDirs: string[];
  try {
    featureDirs = await readdir(workDir);
  } catch {
    return out;
  }
  for (const featureSegment of featureDirs) {
    const evidenceDir = join(workDir, featureSegment, "evidence");
    let evidenceFiles: string[];
    try {
      evidenceFiles = await readdir(evidenceDir);
    } catch {
      continue;
    }
    for (const file of evidenceFiles) {
      if (!file.endsWith(".json")) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await readFile(join(evidenceDir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.outcome !== "pass") continue;
      const criterionId = typeof parsed.criterionId === "string" ? parsed.criterionId : undefined;
      const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : undefined;
      if (!criterionId || !recordedBy) continue;
      const list = out.get(criterionId) ?? [];
      list.push(recordedBy);
      out.set(criterionId, list);
    }
  }
  return out;
}

export async function resumeCharter(
  projectDir: string,
  input: { charterId?: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "paused") throw new Error(`Cannot resume charter in status ${state.status}`);
  state.status = state.previousStatus && !isTerminal(state.previousStatus) ? state.previousStatus : "active";
  state.previousStatus = undefined;
  state.updatedAt = input.now ?? new Date().toISOString();
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_resumed", ts: state.updatedAt, charterId: state.charterId });
  return {
    charterId: state.charterId,
    status: state.status,
    message: `Resumed charter ${state.charterId}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

export function nextActionsForStatus(status: CharterStatus): NextAction[] {
  switch (status) {
    case "planning":
      return [
        { tool: "charter_plan", action: "view", hint: "Inspect charter coverage and draft feature DAG." },
        { tool: "charter_plan", action: "lock_plan", hint: "Run planner checks and lock the plan when charter.md and plan/*.md are ready." },
        { tool: "charter_manage", action: "pause", hint: "Pause if planning is blocked." },
      ];
    case "active":
      return [
        { tool: "charter_status", hint: "Read drift views before choosing the next move." },
        { tool: "charter_record", action: "evidence", hint: "Record evidence after running a check." },
        { tool: "charter_record", action: "verify", hint: "Run configured verifiers for criteria or a feature." },
        { tool: "charter_manage", action: "pause", hint: "Pause if blocked or waiting on user input." },
      ];
    case "review":
      return [
        { tool: "charter_status", hint: "Inspect evidence summary before final completion." },
        { tool: "charter_manage", action: "complete", hint: "Complete only if evidence and hooks pass." },
        { tool: "charter_manage", action: "amend_charter", hint: "Amend if review reveals missing criteria." },
      ];
    case "paused":
      return [
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter." },
        { tool: "charter_status", hint: "Inspect current charter state." },
      ];
    default:
      return [
        { tool: "charter_status", hint: "Inspect terminal charter result." },
        { tool: "charter_manage", action: "amend_charter", hint: "Amend if the charter must be re-opened." },
      ];
  }
}

async function resolveCharterId(projectDir: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const rows = await loadCharterIndex(projectDir);
  const active = rows.filter((row) => !isTerminal(row.status));
  if (active.length === 1) return active[0].charterId;
  if (active.length === 0) throw new Error("No active charter found. Pass charterId or create a charter first.");
  throw new Error(`Multiple active charters found: ${active.map((row) => row.charterId).join(", ")}. Pass charterId explicitly.`);
}

function phaseForStatus(status: CharterStatus): CharterStatusResult["phase"] {
  if (status === "planning") return "planning";
  if (status === "active" || status === "paused") return "active";
  if (status === "review") return "review";
  return "terminal";
}

function guidelinesForStatus(status: CharterStatus): string[] {
  if (status === "planning") return [
    "Edit charter.md inside .pi/charters/<id>/ to add VAL-* criteria; the initial template includes a worked example. Format is `### VAL-<ID> <title>` H3 headings with `Verifier:`/`Description:` field lines beneath — bullet lists are ignored. Do NOT create a repo-root charter.md.",
    "Use charter_plan action=add_feature for each feature; do NOT write plan/<featureId>.md at the repo root — the tool writes to .pi/charters/<id>/plan/.",
    "Run subagent({agent:'charter-planner-critic'}) before charter_plan action=lock_plan; resolve every BLOCK finding it returns. After lock_plan you implement end-to-end.",
  ];
  if (status === "active") return [
    "Charter is locked: implement every feature end to end without stopping. Do not ask 'should I keep going?' — the locked plan is your authorization.",
    "MAIN AGENT CONTEXT IS PRECIOUS. Delegate verification to subagent({agent:'charter-verifier', metadata:{'pi-charter.charterId':<id>,'pi-charter.featureId':<id>,'pi-charter.criterionId':'VAL-...','pi-charter.projectDir':<cwd>}}); delegate read-only recon to subagent({agent:'explorer', ...}).",
    "Choose one next move from charter_status nextActions; do not guess transitions.",
  ];
  if (status === "review") return ["Inspect evidence before completing; evaluator done is not a gate."];
  if (status === "paused") return ["Resume before recording new evidence or changing plan state."];
  return ["Terminal charters are read-only except explicit follow-up/new charter actions."];
}

function isTerminal(status: CharterStatus): boolean {
  return status === "completed" || status === "budget_limited" || status === "abandoned";
}

/**
 * Coerce a user-supplied charter name into a short slug suitable for header
 * display. Trims, lowercases, replaces whitespace with hyphens, strips
 * non-slug chars, and clamps to 32 chars. Returns undefined when the input is
 * empty/blank so callers fall back to the short UUID.
 */
function sanitizeCharterName(name?: string): string | undefined {
  if (typeof name !== "string") return undefined;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 32);
  return slug || undefined;
}
