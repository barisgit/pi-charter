import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendEvent, charterDir, createCharterWorkspace, loadCharterIndex, loadCharterState, loadParsedCharter, writeCharterState } from "../infrastructure/store";
import { loadCriterionState, loadFeatureState, type CriterionStateFile, type CriterionStateRecord, type FeatureStateFile } from "./record-service";
import { parseFeatureMarkdown } from "../domain/feature-md";
import { computeDrift } from "./drift-service";
import { dispatchHook } from "./hooks";
import { trustRank } from "../domain/trust-rank";
import { TERMINAL_STATUSES, type Budget, type CharterCommands, type CharterCriterion, type CharterState, type CharterStatus, type CharterTriageEntry, type EvidenceSource, type NextAction } from "../domain/types";
import { loadCharterConfig } from "../persistence/charter-config";
import { CharterToolError } from "./errors";
import { architectureMarkdownPath, hasNonTrivialArchitecture } from "./architecture-gate";
import { listBlockingReadinessFeatures, type ReadinessProbeResult } from "./readiness-service";
import { logger } from "../infrastructure/logger";
import { groupFeaturesByMilestone, readPlanFeatures, type PlanFeatureRef } from "./plan-tree";
import { listUntriagedHandoffItems, type HandoffTriageItem } from "./handoff-query";

export type { NextAction };

export interface CharterServiceResult<T = unknown> {
  charterId: string;
  status: CharterStatus;
  message: string;
  data?: T;
  nextActions: NextAction[];
}

export interface BlockingForCompleteEntry {
  criterionId?: string;
  /** Short human-readable reason consumed by `formatCharterStatusText`. */
  reason: string;
  featureId?: string;
  outcome?: string;
  lastEvidencePath?: string;
  probeResult?: ReadinessProbeResult;
  handoffPath?: string;
  itemId?: string;
  description?: string;
  severity?: string;
  kind?: string;
}

export interface CharterStatusDetails {
  /**
   * Per-criterion view of evidence the completion gate considers blocking:
   * latest evidence that is not pass, or pass evidence that is too low-trust
   * to accept. Missing-evidence gaps are still surfaced by completeCharter's
   * existing "no pass evidence yet" error and by drift.
   */
  blockingForComplete: BlockingForCompleteEntry[];
}

export interface MilestoneStatusSummary {
  milestoneId: string;
  featureCount: number;
  fulfilledValCount: number;
  valPassCount: number;
  qaEvidenceCount: number;
  featureIds: string[];
}

export interface CharterStatusResult {
  charterId: string;
  name?: string;
  schemaVersion?: CharterState["schemaVersion"];
  status: CharterStatus;
  phase: "planning" | "active" | "review" | "terminal";
  objective: string;
  migrationHint?: string;
  budget?: Budget;
  clarificationNote?: string;
  architecturePresent: boolean;
  drift: {
    uncovered: { criterionId: string; reason: string }[];
    stuck: { featureId: string; status: string; startedAt?: string }[];
    stale: { criterionId: string; ageMs: number; lastTs: string }[];
    readyNext: { featureId: string; fulfills: string[]; probeResult?: ReadinessProbeResult }[];
  };
  milestones: MilestoneStatusSummary[];
  guidelines: string[];
  nextActions: NextAction[];
  details?: CharterStatusDetails;
  qaBriefs: string[];
  commands: CharterCommands;
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; name?: string; budget?: Budget; idempotencyKey?: string; charterId?: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const objective = input.objective.trim();
  if (!objective) {
    throw new CharterToolError("objective is required for charter_manage action=create; pass a non-empty objective describing the desired outcome.", {
      code: "create.empty_objective",
      nextActions: [
        { tool: "charter_manage", action: "create", hint: "Retry with `objective: '<one-sentence desired outcome>'`." },
        { tool: "charter_status", hint: "List active charters; resume one instead of creating a new empty charter." },
      ],
    });
  }
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

export interface AmendCharterTriageEntry {
  handoffPath: string;
  itemId: string;
  decision: "cut";
  reason: string;
}

function normalizeAmendCharterTriage(entries: AmendCharterTriageEntry[] | undefined, now: string): CharterTriageEntry[] {
  if (!entries) return [];
  if (!Array.isArray(entries)) {
    throw new CharterToolError("amend_charter triage must be an array.", {
      code: "amend.bad_triage",
      nextActions: [
        { tool: "charter_manage", action: "amend_charter", hint: "Pass triage:[{handoffPath,itemId,decision:'cut',reason:'...'}] or omit triage." },
      ],
    });
  }
  return entries.map((entry) => {
    const handoffPath = entry.handoffPath?.trim();
    const itemId = entry.itemId?.trim();
    const reason = entry.reason?.trim();
    if (!handoffPath || !itemId || entry.decision !== "cut" || !reason) {
      throw new CharterToolError("amend_charter triage entries require non-empty handoffPath, itemId, decision:'cut', and reason.", {
        code: "amend.bad_triage",
        nextActions: [
          { tool: "charter_manage", action: "amend_charter", hint: "Retry with triage:[{handoffPath:'work/<feature>/handoffs/<session>.handoff.json', itemId:'...', decision:'cut', reason:'why it is out of scope'}]." },
        ],
      });
    }
    return { handoffPath, itemId, decision: "cut", reason, decidedAt: now };
  });
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
  const milestoneQAActions = await computeMilestoneQANextActionsSafely(dir);
  const milestones = await computeMilestoneStatusSummariesSafely(dir, charterId);
  const qaBriefs = await listQaBriefs(dir);
  const commands = await loadCharterCommands(dir);
  const architecturePresent = await hasNonTrivialArchitecture(architectureMarkdownPath(projectDir, charterId));
  const migrationHint = migrationHintForState(state);
  return {
    charterId: state.charterId,
    name: state.name,
    schemaVersion: state.schemaVersion,
    status: state.status,
    phase: phaseForStatus(state.status),
    objective: state.objective,
    migrationHint,
    budget: state.budget,
    clarificationNote: state.clarificationNote,
    architecturePresent,
    drift,
    milestones,
    guidelines: migrationHint ? [migrationHint, ...guidelinesForStatus(state.status)] : guidelinesForStatus(state.status),
    nextActions: migrationHint ? migrationReplanNextActions() : state.status === "awaiting-clarification" ? nextActionsForStatus(state.status) : [...nextActionsForStatus(state.status), ...milestoneReviewActions, ...milestoneQAActions],
    details: { blockingForComplete },
    qaBriefs,
    commands,
  };
}

export const V1_REPLAN_REQUIRED_HINT = "This charter has the pi-charter v1 disk shape (charter.md ## Criteria + criterion-state.json). v2 will not auto-migrate it; initiate a replan with charter_manage action=amend_charter and manually port checks using docs/v1-to-v2-migration.md, or force_complete/abandon it if it should not continue.";
const QA_BRIEFS_DIR = "qa-briefs";
const LEGACY_QA_BRIEFS_DIR = "qa";

async function loadCharterCommands(dir: string): Promise<CharterCommands> {
  try {
    return (await loadParsedCharter(dir)).commands;
  } catch {
    return {};
  }
}

function migrationHintForState(state: CharterState): string | undefined {
  return state.schemaVersion === "v1-needs-replan" ? V1_REPLAN_REQUIRED_HINT : undefined;
}

export function migrationReplanNextActions(): NextAction[] {
  return [
    { tool: "charter_manage", action: "amend_charter", hint: "Start the required v2 replan. Rewrite charter.md/plan entries manually using docs/v1-to-v2-migration.md; no automatic data migration will run." },
    { tool: "charter_manage", action: "force_complete", hint: "Abandon or terminally close this v1-shaped charter if it should not be replanned." },
    { tool: "charter_status", hint: "Re-read migration guidance before choosing the replan or force-complete path." },
  ];
}

export function assertNotV1NeedsReplan(state: CharterState): void {
  if (state.schemaVersion !== "v1-needs-replan") return;
  throw new CharterToolError("migration.replan_required: this v1-shaped charter must be replanned before mutating records, plan, or completion state.", {
    code: "migration.replan_required",
    nextActions: migrationReplanNextActions(),
  });
}

async function listQaBriefs(dir: string): Promise<string[]> {
  const entries = await readQaBriefEntries(join(dir, QA_BRIEFS_DIR));
  if (entries) return qaBriefNames(entries);
  const legacyDir = join(dir, LEGACY_QA_BRIEFS_DIR);
  const legacyEntries = await readQaBriefEntries(legacyDir);
  if (!legacyEntries) return [];
  logger.warn(`legacy qa/ briefs dir is deprecated; rename ${legacyDir} to ${join(dir, QA_BRIEFS_DIR)}.`);
  return qaBriefNames(legacyEntries);
}

async function readQaBriefEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function qaBriefNames(entries: Awaited<ReturnType<typeof readQaBriefEntries>>): string[] {
  if (!entries) return [];
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => basename(entry.name, ".md"))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Scan events.jsonl for `milestone_ready_for_review` events whose criterionIds
 * have not yet been fully covered by a later charter-reviewer evidence record.
 * Append one nextAction per unreviewed milestone.
 */
async function computeMilestoneReviewNextActionsSafely(dir: string): Promise<NextAction[]> {
  try {
    return await computeMilestoneReviewNextActions(dir);
  } catch {
    return [];
  }
}

async function computeMilestoneQANextActionsSafely(dir: string): Promise<NextAction[]> {
  try {
    return await computeMilestoneQANextActions(dir);
  } catch {
    return [];
  }
}

async function computeMilestoneStatusSummariesSafely(dir: string, charterId: string): Promise<MilestoneStatusSummary[]> {
  try {
    return await computeMilestoneStatusSummaries(dir, charterId);
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

export interface UnQAedMilestone {
  milestoneId: string;
  planDigest: string;
  criterionIds: string[];
  /** Timestamp of the originating milestone_ready_for_review event. */
  readyTs: string;
}

interface LatestMilestoneReadyEvent {
  milestoneId: string;
  planDigest: string;
  criterionIds: string[];
  ts: string;
}

async function listLatestMilestoneReadyEvents(dir: string): Promise<LatestMilestoneReadyEvent[]> {
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

  return [...readyByMilestone.entries()].map(([milestoneId, ready]) => ({
    milestoneId,
    planDigest: ready.planDigest,
    criterionIds: ready.criterionIds,
    ts: ready.ts,
  }));
}

/**
 * Pure helper consumed by `getCharterStatus`. Reads
 * `events.jsonl` and feature evidence records, returns the set of
 * milestone_ready_for_review events whose criterionIds are not yet fully
 * covered by charter-reviewer-attributed pass evidence.
 *
 * Coverage is decided by persisted evidence records whose `recordedBy` starts
 * with `subagent:charter-reviewer:` (the authoritative identity prefix written
 * by applyHandoff), not by event payloads. This keeps the surface honest when
 * other persona subagents also write evidence.
 */
export async function listUnreviewedMilestones(dir: string): Promise<UnreviewedMilestone[]> {
  const readyEvents = await listLatestMilestoneReadyEvents(dir);
  if (readyEvents.length === 0) return [];

  // VAL-11 contract: a milestone counts as reviewed iff every criterionId has
  // AT LEAST ONE evidence record where `recordedBy` starts with
  // `subagent:charter-reviewer:` and `ts >= milestone_ready_for_review.ts`.
  // Latest-record-in-criterion-state is not enough; a later agent:root
  // record would otherwise clobber a valid charter-reviewer review.
  const verifierReviewsByCriterion = await loadCharterVerifierReviewsByCriterion(dir);
  const unreviewed: UnreviewedMilestone[] = [];
  for (const ready of readyEvents) {
    const missing = ready.criterionIds.filter((id) => {
      const reviews = verifierReviewsByCriterion.get(id) ?? [];
      return !reviews.some((review) => review.ts >= ready.ts);
    });
    if (missing.length === 0) continue;
    unreviewed.push({
      milestoneId: ready.milestoneId,
      planDigest: ready.planDigest,
      criterionIds: ready.criterionIds,
      readyTs: ready.ts,
    });
  }
  return unreviewed;
}

export interface LoadedFeatureEvidenceRecord {
  path: string;
  ts: string;
  record: Record<string, unknown>;
}

/**
 * Walk both evidence layouts for one feature and return parseable JSON evidence
 * records sorted by their record timestamp:
 *   - legacy flat: work/<featureId>/evidence/<criterionId>__<stamp>.json
 *   - v2.1 run dir: work/<featureId>/evidence/<stamp>/evidence.json
 * Malformed JSON and non-JSON artifacts are ignored so old/partial evidence
 * directories never crash status/readiness computations.
 */
export async function loadFeatureEvidence(dir: string, featureSegment: string): Promise<LoadedFeatureEvidenceRecord[]> {
  const evidenceDir = join(dir, "work", featureSegment, "evidence");
  let entries: string[];
  try {
    entries = await readdir(evidenceDir);
  } catch {
    return [];
  }

  const records: LoadedFeatureEvidenceRecord[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".json")) {
      const loaded = await loadEvidenceJson(join(evidenceDir, entry), join("work", featureSegment, "evidence", entry));
      if (loaded) records.push(loaded);
      continue;
    }

    let runEntries: string[];
    try {
      runEntries = await readdir(join(evidenceDir, entry));
    } catch {
      continue;
    }
    if (!runEntries.includes("evidence.json")) continue;
    const loaded = await loadEvidenceJson(
      join(evidenceDir, entry, "evidence.json"),
      join("work", featureSegment, "evidence", entry, "evidence.json"),
    );
    if (loaded) records.push(loaded);
  }

  records.sort((a, b) => a.ts.localeCompare(b.ts) || a.path.localeCompare(b.path));
  return records;
}

async function loadEvidenceJson(absolutePath: string, relativePath: string): Promise<LoadedFeatureEvidenceRecord | undefined> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const ts = typeof parsed.ts === "string" ? parsed.ts : undefined;
  if (!ts) return undefined;
  return { path: relativePath, ts, record: parsed };
}

/**
 * Walk work/<featureId>/evidence records and collect every pass evidence record
 * whose `recordedBy` is `subagent:charter-reviewer:*`, keyed by criterionId,
 * with the record `ts`. VAL-11 uses this to compare against milestone_ready_for_review.ts.
 */
async function loadCharterVerifierReviewsByCriterion(dir: string): Promise<Map<string, { ts: string }[]>> {
  return loadSubagentPassEvidenceByCriterion(dir, "subagent:charter-reviewer:");
}

async function loadSubagentPassEvidenceByCriterion(dir: string, recordedByPrefix: string): Promise<Map<string, { ts: string }[]>> {
  const out = new Map<string, { ts: string }[]>();
  const workDir = join(dir, "work");
  let featureDirs: string[];
  try {
    featureDirs = await readdir(workDir);
  } catch {
    return out;
  }
  for (const featureSegment of featureDirs) {
    for (const { record: parsed } of await loadFeatureEvidence(dir, featureSegment)) {
      if (parsed.outcome !== "pass") continue;
      const criterionId = typeof parsed.criterionId === "string" ? parsed.criterionId : undefined;
      const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : undefined;
      const ts = typeof parsed.ts === "string" ? parsed.ts : undefined;
      if (!criterionId || !recordedBy || !ts) continue;
      if (!recordedBy.startsWith(recordedByPrefix)) continue;
      const list = out.get(criterionId) ?? [];
      list.push({ ts });
      out.set(criterionId, list);
    }
  }
  return out;
}

async function computeMilestoneStatusSummaries(dir: string, charterId: string): Promise<MilestoneStatusSummary[]> {
  const groups = groupFeaturesByMilestone(await readPlanFeatures(dir));
  if (groups.length === 0) return [];
  const criterionState = await loadCriterionState(dir, charterId);
  const qaEvidenceByCriterion = await loadSubagentPassEvidenceByCriterion(dir, "subagent:charter-qa:");

  return groups.map((group) => {
    const criterionIds = milestoneCriterionIds(group.features);
    return {
      milestoneId: group.milestoneId,
      featureCount: group.features.length,
      fulfilledValCount: criterionIds.length,
      valPassCount: criterionIds.filter((criterionId) => criterionState.criteria[criterionId]?.outcome === "pass").length,
      qaEvidenceCount: criterionIds.filter((criterionId) => (qaEvidenceByCriterion.get(criterionId) ?? []).length > 0).length,
      featureIds: group.features.map((feature) => feature.id),
    };
  });
}

function milestoneCriterionIds(features: PlanFeatureRef[]): string[] {
  return Array.from(new Set(features.flatMap((feature) => feature.fulfills))).sort();
}

export async function listUnQAedMilestones(dir: string): Promise<UnQAedMilestone[]> {
  const readyEvents = await listLatestMilestoneReadyEvents(dir);
  if (readyEvents.length === 0) return [];

  const groups = groupFeaturesByMilestone(await readPlanFeatures(dir));
  const groupsById = new Map(groups.map((group) => [group.milestoneId, group]));
  const qaEvidenceByCriterion = await loadSubagentPassEvidenceByCriterion(dir, "subagent:charter-qa:");
  const out: UnQAedMilestone[] = [];

  for (const ready of readyEvents) {
    if (ready.criterionIds.length === 0) continue;
    const group = groupsById.get(ready.milestoneId);
    if (!group) continue;
    if (!(await milestoneHasImplementationEvidence(dir, group.features))) continue;

    const qaCovered = ready.criterionIds.filter((criterionId) => {
      const records = qaEvidenceByCriterion.get(criterionId) ?? [];
      return records.some((record) => record.ts >= ready.ts);
    });
    if (qaCovered.length === ready.criterionIds.length) continue;

    out.push({
      milestoneId: ready.milestoneId,
      planDigest: ready.planDigest,
      criterionIds: ready.criterionIds,
      readyTs: ready.ts,
    });
  }

  return out;
}

async function milestoneHasImplementationEvidence(dir: string, features: PlanFeatureRef[]): Promise<boolean> {
  for (const feature of features) {
    const evidence = await loadFeatureEvidence(dir, feature.id);
    for (const criterionId of feature.fulfills) {
      if (!evidence.some(({ record }) => isImplementationEvidenceForCriterion(record, criterionId))) {
        return false;
      }
    }
  }
  return true;
}

function isImplementationEvidenceForCriterion(record: Record<string, unknown>, criterionId: string): boolean {
  if (record.outcome !== "pass") return false;
  if (record.criterionId !== criterionId) return false;
  const recordedBy = typeof record.recordedBy === "string" ? record.recordedBy : "";
  if (recordedBy.startsWith("subagent:charter-reviewer:")) return true;
  const kind = evidenceKindFromRecord(record);
  return kind === "command" || kind === "qa" || kind === "review";
}

function evidenceKindFromRecord(record: Record<string, unknown>): string | undefined {
  if (typeof record.kind === "string") return record.kind;
  const details = record.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const detailRecord = details as Record<string, unknown>;
  if (typeof detailRecord.kind === "string") return detailRecord.kind;
  const typedEvidence = detailRecord.typedEvidence;
  if (typedEvidence && typeof typedEvidence === "object" && !Array.isArray(typedEvidence)) {
    const typedRecord = typedEvidence as Record<string, unknown>;
    if (typeof typedRecord.kind === "string") return typedRecord.kind;
  }
  return undefined;
}

async function computeMilestoneReviewNextActions(dir: string): Promise<NextAction[]> {
  const unreviewed = await listUnreviewedMilestones(dir);
  return unreviewed.map((entry) => ({
    tool: "subagent" as const,
    hint: `Delegate to charter-reviewer for milestone ${entry.milestoneId} (criteria: ${entry.criterionIds.join(", ")}).`,
    metadata: { milestoneId: entry.milestoneId, criterionIds: entry.criterionIds },
  }));
}

async function computeMilestoneQANextActions(dir: string): Promise<NextAction[]> {
  const unqaed = await listUnQAedMilestones(dir);
  return unqaed.map((entry) => ({
    tool: "subagent" as const,
    hint: `Run milestone QA with charter-qa for milestone ${entry.milestoneId} (criteria: ${entry.criterionIds.join(", ")}).`,
    metadata: { milestoneId: entry.milestoneId, criterionIds: entry.criterionIds, agent: "charter-qa" },
  }));
}

async function computeBlockingForCompleteSafely(dir: string, charterId: string): Promise<BlockingForCompleteEntry[]> {
  try {
    const charter = await loadParsedCharter(dir);
    const criterionState = await loadCriterionState(dir, charterId);
    const state = await loadCharterState(dir);
    const context = await loadBlockingContext(dir, charterId, state);
    const readinessBlocking = await listBlockingReadinessFeatures(dir);
    return [
      ...computeBlockingForComplete(charter.criteria, criterionState, context),
      ...readinessBlocking.map((feature) => ({
        criterionId: feature.fulfills[0] ?? feature.featureId,
        featureId: feature.featureId,
        probeResult: feature.probeResult,
        reason: "readiness-blocking",
      })),
    ];
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
  if (isTerminal(state.status)) {
    throw new CharterToolError(`Cannot pause terminal charter in status ${state.status}`, {
      code: "lifecycle.wrong_state",
      nextActions: [
        { tool: "charter_status", hint: "Inspect the terminal charter's status; pause is only legal on non-terminal charters." },
        { tool: "charter_manage", action: "amend_charter", hint: "Use amend_charter to re-open the terminal charter before pausing." },
      ],
    });
  }
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

export async function askCharter(
  projectDir: string,
  input: { charterId?: string; now?: string; note?: string },
): Promise<CharterServiceResult<CharterState>> {
  if (loadCharterConfig().policy === "autonomous") {
    throw new CharterToolError("Cannot ask for clarification when charter policy is autonomous.", {
      code: "ask.policy_autonomous",
      nextActions: [
        { tool: "charter_status", hint: "Inspect the charter and continue autonomously, or change policy before asking the user." },
      ],
    });
  }

  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "planning") {
    throw new CharterToolError(`Cannot ask for clarification in status ${state.status}; ask is only legal from planning.`, {
      code: "ask.not_planning",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; ask is only legal while planning." },
        { tool: "charter_manage", action: "pause", hint: "Pause instead if an active charter is blocked or waiting on user input." },
      ],
    });
  }

  const now = input.now ?? new Date().toISOString();
  const note = input.note?.trim().replace(/\s+/g, " ") || undefined;
  state.status = "awaiting-clarification";
  state.clarificationNote = note;
  state.unansweredClarification = true;
  state.updatedAt = now;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_asked", ts: now, charterId: state.charterId, note });
  return {
    charterId: state.charterId,
    status: state.status,
    message: `Charter ${state.charterId} is awaiting clarification.`,
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
  assertNotV1NeedsReplan(state);
  if (state.status !== "active" && state.status !== "review") {
    throw new CharterToolError(`Cannot complete charter in status ${state.status}; resume or amend first.`, {
      code: "complete.wrong_state",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status before retrying complete." },
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter before completing." },
        { tool: "charter_manage", action: "amend_charter", hint: "Amend the charter if it is terminal but needs re-opening." },
      ],
    });
  }
  const charter = await loadParsedCharter(dir);
  const criterionState = await loadCriterionState(dir, charterId);
  const context = await loadBlockingContext(dir, charterId, state);
  const failures = checkCompletionGate(charter.criteria, criterionState, state, context);
  const readinessBlocking = await listBlockingReadinessFeatures(dir);
  const blocking: BlockingForCompleteEntry[] = [
    ...computeBlockingForComplete(charter.criteria, criterionState, context),
    ...readinessBlocking.map((feature) => ({
      criterionId: feature.fulfills[0] ?? feature.featureId,
      featureId: feature.featureId,
      probeResult: feature.probeResult,
      reason: "readiness-blocking",
    })),
  ];
  const readinessBlocks = blocking.filter((entry) => entry.reason === "readiness-blocking");
  const triageBlocks = blocking.filter((entry) => entry.reason === "untriaged-handoff-items");
  const trustBlocks = blocking.filter((entry) => entry.reason !== "readiness-blocking" && entry.reason !== "val-not-pass" && entry.reason !== "untriaged-handoff-items");
  if (blocking.length > 0) {
    // Render `<id>(<reason>)` per VAL so identity-disjoint and
    // requires-charter-reviewer rejections are distinguishable from generic
    // low-trust evidence in the user-facing error string. The summary line
    // keeps the legacy `low-trust evidence for N VAL(s): ...` phrasing so
    // existing tests grepping for VAL ids continue to match.
    if (trustBlocks.length > 0) {
      const idsWithReasons = trustBlocks.map((entry) => `${entry.criterionId}(${entry.reason})`).join(", ");
      failures.push(`low-trust evidence for ${trustBlocks.length} VAL(s): ${idsWithReasons}`);
    }
    if (readinessBlocks.length > 0) {
      const idsWithReasons = readinessBlocks.map((entry) => `${entry.featureId ?? entry.criterionId}(${entry.reason})`).join(", ");
      failures.push(`readiness blocking feature(s): ${idsWithReasons}`);
    }
    if (triageBlocks.length > 0) {
      failures.push(formatUntriagedHandoffFailure(triageBlocks));
    }
  }
  if (failures.length > 0) {
    const message = [
      `Cannot complete charter:`,
      ` - ${failures.join("\n - ")}`,
      ...(trustBlocks.length > 0
        ? ["Fix: add Because: rationale and run charter-reviewer (subagent({agent:'charter-reviewer'})) for the listed VALs."]
        : []),
    ].join("\n");
    // Collect every failing criterion id so nextActions can name them in
    // hint strings; the test spot-check requires at least one nextAction
    // mentions a failing criterion id literally.
    const failingIds = new Set<string>();
    for (const f of failures) {
      const m = f.match(/^(VAL-[A-Za-z0-9_-]+):/);
      if (m) failingIds.add(m[1]!);
    }
    for (const b of blocking) if (b.reason !== "readiness-blocking" && b.reason !== "untriaged-handoff-items" && b.criterionId) failingIds.add(b.criterionId);
    const idList = Array.from(failingIds);
    const nextActions: NextAction[] = [];
    for (const id of idList.slice(0, 5)) {
      nextActions.push({
        tool: "charter_record",
        action: "verify",
        hint: `Run the configured verifier for ${id} to produce machine-trusted evidence.`,
      });
      nextActions.push({
        tool: "charter_record",
        action: "evidence",
        hint: `Record charter-reviewer-attributed pass evidence for ${id} (set recordedBy='subagent:charter-reviewer:<sessionId>').`,
      });
    }
    const reviewerBlocking = blocking.filter((entry) => entry.reason !== "readiness-blocking" && entry.reason !== "val-not-pass" && entry.reason !== "untriaged-handoff-items");
    if (reviewerBlocking.length > 0) {
      nextActions.push({
        tool: "subagent",
        hint: `Delegate to charter-reviewer subagent for: ${reviewerBlocking.map((b) => b.criterionId).filter(Boolean).join(", ")}.`,
      });
    }
    if (triageBlocks.length > 0) {
      nextActions.push({
        tool: "charter_plan",
        action: "add_feature",
        hint: "Add a follow-up feature whose body references the handoff filename or sessionId for each untriaged handoff item.",
      });
      nextActions.push({
        tool: "charter_plan",
        action: "update_feature",
        hint: "Update the affected feature description to mention the handoff sessionId when the item is already absorbed by existing scope.",
      });
      nextActions.push({
        tool: "charter_manage",
        action: "amend_charter",
        hint: "If the handoff item is intentionally cut, pass target:'planning' and triage:[{handoffPath,itemId,decision:'cut',reason:'...'}].",
      });
    }
    nextActions.push({ tool: "charter_status", hint: "Re-read drift and the blockingForComplete view after recording new evidence." });
    throw new CharterToolError(message, {
      code: "complete.gate_blocked",
      nextActions,
    });
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

function formatUntriagedHandoffFailure(entries: BlockingForCompleteEntry[]): string {
  const details = entries.map((entry) => {
    const path = entry.handoffPath ?? "unknown handoff";
    const item = entry.itemId ? `#${entry.itemId}` : "";
    const description = entry.description?.trim() || "handoff item needs triage";
    return `${path}${item}: ${description}`;
  }).join("; ");
  return `untriaged-handoff-items: ${details}`;
}

export async function forceCompleteCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; target?: "completed" | "abandoned" | "budget_limited"; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new CharterToolError("force_complete requires a non-empty reason.", {
      code: "force_complete.empty_reason",
      nextActions: [
        { tool: "charter_manage", action: "force_complete", hint: "Retry with `reason: '<why the charter is being terminated>'`." },
        { tool: "charter_status", hint: "Inspect the charter before forcing completion." },
      ],
    });
  }
  const target = input.target ?? "abandoned";
  if (!isTerminal(target)) {
    throw new CharterToolError(`force_complete target must be terminal; got ${target}.`, {
      code: "force_complete.non_terminal_target",
      nextActions: [
        { tool: "charter_manage", action: "force_complete", hint: "Pass `target: 'completed' | 'abandoned' | 'budget_limited'`; planning/review/paused are not legal force-complete targets." },
      ],
    });
  }
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (isTerminal(state.status)) {
    throw new CharterToolError(`Charter ${charterId} is already terminal (${state.status}).`, {
      code: "force_complete.already_terminal",
      nextActions: [
        { tool: "charter_status", hint: "Inspect the terminal charter; force_complete is only legal on non-terminal charters." },
        { tool: "charter_manage", action: "amend_charter", hint: "Use amend_charter to re-open the terminal charter if it needs more work." },
      ],
    });
  }
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
  input: { charterId?: string; reason: string; target?: "planning" | "review"; now?: string; triage?: AmendCharterTriageEntry[] },
): Promise<CharterServiceResult<CharterState>> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new CharterToolError("amend_charter requires a non-empty reason.", {
      code: "amend.empty_reason",
      nextActions: [
        { tool: "charter_manage", action: "amend_charter", hint: "Retry with `reason: '<why the terminal charter is being re-opened>'`." },
      ],
    });
  }
  const target = input.target ?? "review";
  if (target !== "planning" && target !== "review") {
    throw new CharterToolError(`amend_charter target must be planning or review; got ${target}.`, {
      code: "amend.bad_target",
      nextActions: [
        { tool: "charter_manage", action: "amend_charter", hint: "Pass `target: 'planning' | 'review'`; terminal/active/paused are not legal amend targets." },
      ],
    });
  }
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const from = state.status;
  const allowedForPlanning: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
    ...TERMINAL_STATUSES,
    "active",
    "review",
  ]);
  const allowedForReview = TERMINAL_STATUSES;
  const allowed = target === "planning" ? allowedForPlanning : allowedForReview;
  if (!allowed.has(from)) {
    const legalSources = Array.from(allowed).join(", ");
    throw new CharterToolError(
      `Cannot amend charter from ${from} to ${target}; legal source states for target ${target} are: ${legalSources}.`,
      {
        code: "amend.invalid_source_state",
        nextActions: [
          { tool: "charter_status", hint: "Inspect current status before retrying amend_charter." },
          { tool: "charter_manage", action: "amend_charter", hint: `Retry only from one of these source states for target ${target}: ${legalSources}.` },
          { tool: "charter_plan", action: "view", hint: "If the charter is already in planning, inspect the current plan instead of amending again." },
        ],
      },
    );
  }
  const now = input.now ?? new Date().toISOString();
  await dispatchHook("charter:before_amend_charter", {
    type: "charter:before_amend_charter",
    charterId,
    ts: now,
    target,
    reason,
  });
  state.previousStatus = from;
  state.status = target;
  state.updatedAt = now;
  if (isTerminal(from)) {
    state.completedAt = undefined;
    state.terminatedAt = undefined;
    state.completionReason = undefined;
  }
  if (state.schemaVersion === "v1-needs-replan") state.schemaVersion = "v2";
  const triageEntries = normalizeAmendCharterTriage(input.triage, now);
  if (triageEntries.length > 0) {
    const existing = state.triage ?? [];
    const next = [...existing];
    for (const entry of triageEntries) {
      if (next.some((current) => current.handoffPath === entry.handoffPath && current.itemId === entry.itemId && current.decision === entry.decision)) continue;
      next.push(entry);
    }
    state.triage = next;
  }
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_amended", ts: now, charterId, from, to: target, reason, triageCount: triageEntries.length });
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
  /** Handoff output items that still need an explicit keep/cut/follow-up decision. */
  untriagedHandoffItems: HandoffTriageItem[];
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
 *     manual+because) AND the writer isn't a charter-reviewer subagent; OR
 *   - effective `requireReviewSubagent` is true and no pass evidence has a
 *     `subagent:charter-reviewer:` writer; OR
 *   - effective `requireReviewSubagent` is true and every pass evidence
 *     shares its session id with the implementing feature
 *     (`implementer-only-reviewer`).
 *
 * Criteria with missing evidence are surfaced separately by
 * `checkCompletionGate`; criteria whose latest evidence is partial/fail are
 * also surfaced here as `val-not-pass` so status views can name the blocker.
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
    if (!record) continue;
    if (record.outcome !== "pass") {
      blocking.push({
        criterionId: criterion.id,
        reason: "val-not-pass",
        featureId: record.lastFeatureId,
        outcome: record.outcome,
        lastEvidencePath: record.lastEvidencePath,
      });
      continue;
    }
    const trustReason = blockingReason(record);
    const effectiveReview = effectiveRequireReviewSubagent(criterion, milestoneIds);
    if (effectiveReview && context) {
      const allPass = context.passRecordedByCriterion.get(criterion.id) ?? [];
      const reviewerRecords = allPass.filter((rb) => rb.startsWith("subagent:charter-reviewer:"));
      if (reviewerRecords.length === 0) {
        blocking.push({ criterionId: criterion.id, reason: "requires-charter-reviewer" });
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
  for (const item of context?.untriagedHandoffItems ?? []) {
    blocking.push({
      reason: "untriaged-handoff-items",
      featureId: item.featureId,
      handoffPath: item.handoffPath,
      itemId: item.itemId,
      description: item.description,
      severity: item.severity,
      kind: item.kind,
    });
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
  // A charter-reviewer subagent always clears the trust gate, regardless of
  // declared source. The string-prefix match keeps the persona name authoritative.
  if (recordedBy.startsWith("subagent:charter-reviewer:")) return undefined;
  const source: EvidenceSource = record.source ?? "manual";
  const hasBecause = Boolean(record.because && record.because.trim());
  const rank = trustRank({ recordedBy, source, hasBecause });
  if (rank > 1) return undefined;
  if (source !== "manual") {
    // High-trust source (verifier/hook/subagent) recorded by a non-charter-reviewer
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
    if (!record) {
      failures.push(`${criterion.id}: no pass evidence yet`);
      continue;
    }
    if (record.outcome !== "pass") {
      failures.push(`${criterion.id}: val-not-pass (latest outcome=${record.outcome}; record pass evidence before completing)`);
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
export async function loadBlockingContext(dir: string, charterId: string, state?: CharterState): Promise<BlockingContext> {
  const milestoneCriterionIds = await loadMilestoneReadyCriterionIds(dir);
  const featureForCriterion = await loadFeatureForCriterion(dir);
  const featureState = await loadFeatureStateSafe(dir, charterId);
  const implementerSessionByCriterion = new Map<string, string>();
  for (const [criterionId, featureId] of featureForCriterion) {
    const sessionId = featureState.features[featureId]?.lastWorkerSessionId;
    if (sessionId) implementerSessionByCriterion.set(criterionId, sessionId);
  }
  const passRecordedByCriterion = await loadPassRecordedByCriterion(dir);
  const charterState = state ?? await loadCharterState(dir);
  const untriagedHandoffItems = await listUntriagedHandoffItems(dir, charterState.triage);
  return { milestoneCriterionIds, implementerSessionByCriterion, passRecordedByCriterion, untriagedHandoffItems };
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
 * Walk work/<featureId>/evidence records (legacy flat and v2.1 dir-per-run)
 * and collect every pass evidence record's `recordedBy` keyed by criterionId.
 * We need every record (not just the latest in criterion-state) so the
 * identity-disjoint predicate can demand at least one session-disjoint reviewer.
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
    for (const { record: parsed } of await loadFeatureEvidence(dir, featureSegment)) {
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
  input: { charterId?: string; now?: string; acknowledgeClarification?: boolean },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const resumeTo = state.status === "awaiting-clarification"
    ? "planning"
    : state.status === "planning"
      ? "planning"
    : state.previousStatus && !isTerminal(state.previousStatus) ? state.previousStatus : "active";
  const acknowledgingInPlanning = state.status === "planning" && state.unansweredClarification === true && input.acknowledgeClarification === true;
  if (state.status !== "paused" && state.status !== "awaiting-clarification" && !acknowledgingInPlanning) {
    throw new CharterToolError(`Cannot resume charter in status ${state.status}`, {
      code: "lifecycle.wrong_state",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; resume is only legal from `paused` or `awaiting-clarification`." },
        { tool: "charter_manage", action: "pause", hint: "Pause the charter first if you want to later resume it." },
      ],
    });
  }
  state.status = resumeTo;
  state.previousStatus = undefined;
  if (input.acknowledgeClarification) {
    state.clarificationNote = undefined;
    state.unansweredClarification = false;
  }
  state.updatedAt = input.now ?? new Date().toISOString();
  await writeCharterState(dir, state);
  await appendEvent(dir, {
    type: "charter_resumed",
    ts: state.updatedAt,
    charterId: state.charterId,
    acknowledgeClarification: input.acknowledgeClarification === true,
  });
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
    case "awaiting-clarification":
      return [
        { tool: "charter_manage", action: "resume", hint: "Resume after the user provides clarification." },
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
  if (status === "planning" || status === "awaiting-clarification") return "planning";
  if (status === "active" || status === "paused") return "active";
  if (status === "review") return "review";
  return "terminal";
}

function guidelinesForStatus(status: CharterStatus): string[] {
  if (status === "planning") return [
    "Edit criteria.md inside .pi/charters/<id>/ to add VAL-* criteria; the initial template includes a worked example. Format is `## VAL-<ID> <title>` headings with `Verifier:`/`Command:` field lines beneath — bullet lists are ignored. Do NOT create a repo-root charter.md.",
    "Use charter_plan action=add_feature for each feature; do NOT write plan/<featureId>.md at the repo root — the tool writes to .pi/charters/<id>/plan/.",
    "Run subagent({agent:'charter-planner-critic'}) before charter_plan action=lock_plan; resolve every BLOCK finding it returns. After lock_plan you implement end-to-end.",
    "Bundled charter personas (charter-planner-critic, charter-reviewer, charter-qa, charter-readiness-probe) are scope:internal and will NOT appear in subagent({action:'list'}) — invoke them by name directly; the call works. Full workflow in skill: skills/pi-charter/SKILL.md.",
  ];
  if (status === "active") return [
    "Charter is locked: implement every feature end to end without stopping. Do not ask 'should I keep going?' — the locked plan is your authorization.",
    "MAIN AGENT CONTEXT IS PRECIOUS. Delegate verification to subagent({agent:'charter-reviewer', metadata:{'pi-charter.charterId':<id>,'pi-charter.featureId':<id>,'pi-charter.criterionId':'VAL-...','pi-charter.projectDir':<cwd>}}); delegate read-only recon to subagent({agent:'explorer', ...}).",
    "PREFER ASYNC: spawn implementation and verification with subagent({async:true, ...}) wherever the next step does not depend on the result. While async runs, main stays free so the user can prompt fixes — the charter progresses itself. Only stay sync when you must read the subagent's output to choose the next move.",
    "Bundled charter personas (charter-planner-critic, charter-reviewer, charter-qa, charter-readiness-probe) are scope:internal and will NOT appear in subagent({action:'list'}) — invoke them by name directly; the call works. Full workflow in skill: skills/pi-charter/SKILL.md.",
    "Choose one next move from charter_status nextActions; do not guess transitions.",
  ];
  if (status === "review") return ["Inspect evidence before completing."];
  if (status === "paused") return ["Resume before recording new evidence or changing plan state."];
  if (status === "awaiting-clarification") return ["Awaiting user clarification. Do not take further charter action until the user responds, then call charter_manage action=resume."];
  return ["Terminal charters are read-only except explicit follow-up/new charter actions."];
}

function isTerminal(status: CharterStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Coerce a user-supplied charter name into a short slug suitable for header
 * display. Trims, lowercases, replaces whitespace with hyphens, strips
 * non-slug chars, and clamps to 32 chars. Returns undefined when the input is
 * empty/blank so callers fall back to the short UUID.
 */
/**
 * One row per non-terminal charter for the multi-charter widget and the
 * `/charters` picker. `name` already falls back to a slice of the charter id
 * so callers can render it verbatim. `passCount`/`totalCount` summarize VAL
 * progress at a glance (pass evidence count over criteria total).
 */
export interface CharterListEntry {
  charterId: string;
  /** Human-friendly label; falls back to `charterId.slice(0, 8)` when state.name is unset. */
  name: string;
  objective: string;
  status: CharterStatus;
  createdAt: string;
  passCount: number;
  totalCount: number;
}

const NON_TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "planning",
  "active",
  "review",
  "paused",
  "awaiting-clarification",
]);

/**
 * Enumerate every non-terminal charter in the project.
 *
 * The on-disk index (.pi/charters/index.json) is treated as a list of ids ONLY
 * because lifecycle transitions write `state.json` but never call updateIndex
 * (see store.ts:writeCharterState vs. updateIndex, only invoked from
 * createCharterWorkspace). Filtering by state.status is what makes the listing
 * accurate for paused/completed charters created before the rewrite.
 *
 * Charters whose state.json or charter.md fail to load are silently dropped
 * — a corrupt entry must not take down the whole picker. Empty projects (no
 * index.json) return [].
 */
export async function listActiveCharters(projectDir: string): Promise<CharterListEntry[]> {
  const index = await loadCharterIndex(projectDir);
  const entries = await Promise.all(
    index.map((row) => loadCharterListEntry(projectDir, row.charterId)),
  );
  return entries.filter((entry): entry is CharterListEntry => entry !== null);
}

async function loadCharterListEntry(
  projectDir: string,
  charterId: string,
): Promise<CharterListEntry | null> {
  try {
    const dir = charterDir(projectDir, charterId);
    const [state, criterionState, parsed] = await Promise.all([
      loadCharterState(dir),
      loadCriterionState(dir, charterId),
      loadParsedCharter(dir),
    ]);
    if (!NON_TERMINAL_STATUSES.has(state.status)) return null;
    const passCount = Object.values(criterionState.criteria).filter(
      (record) => record?.outcome === "pass",
    ).length;
    return {
      charterId,
      name: state.name?.trim() ? state.name : charterId.slice(0, 8),
      objective: state.objective,
      status: state.status,
      createdAt: state.createdAt,
      passCount,
      totalCount: parsed.criteria.length,
    };
  } catch {
    return null;
  }
}

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
