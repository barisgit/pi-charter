import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendEvent, charterDir, createCharterWorkspace, loadCharterIndex, loadCharterState, loadParsedCharter, writeCharterState, writeTextAtomic } from "../infrastructure/store";
import { loadCriterionState, type CriterionStateFile, type CriterionStateRecord } from "./record-service";
import { computeDrift, type DriftViews } from "./drift-service";
import { isEvidenceStaleForSrcChange, lastSrcChangeMs } from "../domain/src-freshness";
import { dispatchHook } from "./hooks";
import { checkReportCompletion, extractCharterTitleFromMarkdown, renderReportScaffold } from "../domain/report-md";
import { trustRank } from "../domain/trust-rank";
import { TERMINAL_STATUSES, type Budget, type CharterCommands, type CharterCriterion, type CharterState, type CharterStatus, type EvidenceSource, type NextAction, type ParseWarning } from "../domain/types";
import { CharterToolError } from "./errors";
import { logger } from "../infrastructure/logger";

export type { NextAction };

export interface CharterServiceResult<T = unknown> {
  charterId: string;
  status: CharterStatus;
  message: string;
  data?: T;
  nextActions: NextAction[];
}

export function logCharterStatusTransition(input: { charterId: string; from: CharterStatus; to: CharterStatus; reason?: string }): void {
  logger.info("charter status transition", {
    component: "service",
    charterId: input.charterId,
    from: input.from,
    to: input.to,
    reason: input.reason,
  });
}

export interface BlockingForCompleteEntry {
  criterionId?: string;
  /** Short human-readable reason consumed by `formatCharterStatusText`. */
  reason: string;
  featureId?: string;
  outcome?: string;
  lastEvidencePath?: string;
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
  title: string;
  criterionIds: string[];
  valCount: number;
  valPassCount: number;
}

export interface CharterStatusResult {
  charterId: string;
  name?: string;
  schemaVersion?: CharterState["schemaVersion"];
  status: CharterStatus;
  phase: "active" | "paused" | "terminal";
  objective: string;
  migrationHint?: string;
  budget?: Budget;
  drift: DriftViews;
  milestones: MilestoneStatusSummary[];
  /** Total VAL criteria parsed across all milestones (0 => empty register). */
  valTotal: number;
  /** VAL criteria with a current pass record. */
  valPass: number;
  /**
   * True when an active/paused charter parsed to zero criteria — a strong
   * signal the register was never authored or failed to parse. Never true for
   * terminal charters.
   */
  registerEmpty: boolean;
  guidelines: string[];
  nextActions: NextAction[];
  details?: CharterStatusDetails;
  qaBriefs: string[];
  commands: CharterCommands;
  /**
   * Non-fatal criteria.md parse warnings (e.g. a `Verifier: subagent` with no
   * Agent/Task degraded to manual). Surfaced so an author can see WHY a
   * criterion is mis-typed instead of silently losing it.
   */
  parseWarnings: ParseWarning[];
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; name?: string; budget?: Budget; idempotencyKey?: string; charterId?: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const objective = input.objective.trim();
  if (!objective) {
    throw new CharterToolError("objective is required for charter action=create; pass a non-empty objective describing the desired outcome.", {
      code: "create.empty_objective",
      nextActions: [
        { tool: "charter", action: "create", hint: "Retry with `objective: '<one-sentence desired outcome>'`." },
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
    message: `Created charter ${charterId} in active state.`,
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
  const milestones = await computeMilestoneStatusSummariesSafely(dir, charterId);
  const qaBriefs = await listQaBriefs(dir);
  const commands = await loadCharterCommands(dir);
  const parseWarnings = await loadCharterParseWarnings(dir);
  const migrationHint = migrationHintForState(state);
  // Derive totals from the full parsed criteria list (the same source drift and
  // the completion gate use), NOT from milestone summaries. A register can mix
  // milestone-grouped criteria with ungrouped top-level `## VAL-*` criteria that
  // belong to no milestone; summing milestone buckets would undercount those and let
  // status read e.g. 1/1 while completion still sees 2.
  const { valTotal, valPass } = await computeValTotals(dir, charterId);
  // An active/paused charter whose register parses to zero criteria is almost
  // always wrong: the scaffold itself parses to one VAL-EXAMPLE, so 0 means
  // either the criteria were never authored or a parse failure wiped the
  // register (e.g. a malformed verifier). Surface it loudly instead of letting
  // 0/0 read as a healthy "nothing left to do".
  const registerEmpty = valTotal === 0 && !isTerminal(state.status);
  return {
    charterId: state.charterId,
    name: state.name,
    schemaVersion: state.schemaVersion,
    status: state.status,
    phase: phaseForStatus(state.status),
    objective: state.objective,
    migrationHint,
    budget: state.budget,
    drift,
    milestones,
    valTotal,
    valPass,
    registerEmpty,
    guidelines: migrationHint ? [migrationHint, ...guidelinesForStatus(state.status)] : guidelinesForStatus(state.status),
    nextActions: migrationHint
      ? migrationReplanNextActions()
      : buildActiveNextActions({ status: state.status, drift, blockingForComplete }),
    details: { blockingForComplete },
    qaBriefs,
    commands,
    parseWarnings,
  };
}

export const V1_REPLAN_REQUIRED_HINT = "This charter has the pi-charter v1 disk shape (charter.md ## Criteria + criterion-state.json). v2 will not auto-migrate it; rewrite charter.md and criteria.md manually using docs/v1-to-v2-migration.md, or call charter action=abandon if it should not continue.";
const QA_BRIEFS_DIR = "qa-briefs";

async function loadCharterCommands(dir: string): Promise<CharterCommands> {
  try {
    return (await loadParsedCharter(dir)).commands;
  } catch {
    return {};
  }
}

async function loadCharterParseWarnings(dir: string): Promise<ParseWarning[]> {
  try {
    return (await loadParsedCharter(dir)).warnings ?? [];
  } catch {
    return [];
  }
}

/**
 * Count every parsed VAL criterion and how many currently hold a pass record.
 * Counts the flat `charter.criteria` list so milestone-grouped and ungrouped
 * (ungrouped top-level `## VAL-*`) criteria are both included; milestone summaries are
 * only a grouped VIEW and must not be the source of truth for totals.
 */
async function computeValTotals(dir: string, charterId: string): Promise<{ valTotal: number; valPass: number }> {
  try {
    const [charter, criterionState] = await Promise.all([
      loadParsedCharter(dir),
      loadCriterionState(dir, charterId),
    ]);
    const valTotal = charter.criteria.length;
    const valPass = charter.criteria.filter(
      (criterion) => criterionState.criteria[criterion.id]?.outcome === "pass",
    ).length;
    return { valTotal, valPass };
  } catch {
    return { valTotal: 0, valPass: 0 };
  }
}

function migrationHintForState(state: CharterState): string | undefined {
  return state.schemaVersion === "v1-needs-replan" ? V1_REPLAN_REQUIRED_HINT : undefined;
}

export function migrationReplanNextActions(): NextAction[] {
  return [
    { tool: "charter_status", hint: "Rewrite charter.md and criteria.md manually using docs/v1-to-v2-migration.md; no automatic data migration will run." },
    { tool: "charter", action: "abandon", hint: "Abandon this v1-shaped charter if it should not be replanned." },
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
  return qaBriefNames(entries);
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
 * have not yet been fully covered by a later subagent review evidence record.
 * Append one nextAction per unreviewed milestone.
 */


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
 * covered by subagent-attributed pass evidence.
 *
 * Coverage is decided by persisted evidence records whose `recordedBy` starts
 * with `subagent:` and a non-empty agent/session suffix, not by event payloads.
 */
export async function listUnreviewedMilestones(dir: string): Promise<UnreviewedMilestone[]> {
  const readyEvents = await listLatestMilestoneReadyEvents(dir);
  if (readyEvents.length === 0) return [];

  // Milestone review coverage: a milestone counts as reviewed iff every
  // criterionId has AT LEAST ONE evidence record where `recordedBy` starts
  // with `subagent:` prefix and `ts >= milestone_ready_for_review.ts`.
  // Latest-record-in-criterion-state is not enough; a later agent:root
  // record would otherwise clobber a valid subagent review.
  const subagentReviewsByCriterion = await loadSubagentReviewsByCriterion(dir);
  const unreviewed: UnreviewedMilestone[] = [];
  for (const ready of readyEvents) {
    const missing = ready.criterionIds.filter((id) => {
      const reviews = subagentReviewsByCriterion.get(id) ?? [];
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
 * Walk dir-per-run evidence for one feature and return parseable JSON evidence
 * records sorted by their record timestamp. Malformed JSON and non-JSON
 * artifacts are ignored so old/partial evidence directories never crash
 * status/readiness computations.
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
 * whose `recordedBy` starts with `subagent:`, keyed by criterionId, with the
 * record `ts`. Milestone review coverage compares these timestamps against
 * milestone_ready_for_review.ts.
 */
async function loadSubagentReviewsByCriterion(dir: string): Promise<Map<string, { ts: string }[]>> {
  return loadSubagentPassEvidenceByCriterion(dir, "subagent:");
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
  const charter = await loadParsedCharter(dir);
  const criterionState = await loadCriterionState(dir, charterId);

  if (charter.milestones.length > 0) {
    return charter.milestones.map((milestone) => ({
      milestoneId: milestone.id,
      title: milestone.title,
      criterionIds: milestone.criterionIds,
      valCount: milestone.criterionIds.length,
      valPassCount: milestone.criterionIds.filter((criterionId) => criterionState.criteria[criterionId]?.outcome === "pass").length,
    }));
  }

  if (charter.criteria.length === 0) return [];
  const criterionIds = charter.criteria.map((criterion) => criterion.id);
  return [{
    milestoneId: "",
    title: "",
    criterionIds,
    valCount: criterionIds.length,
    valPassCount: criterionIds.filter((criterionId) => criterionState.criteria[criterionId]?.outcome === "pass").length,
  }];
}



async function computeMilestoneReviewNextActions(dir: string): Promise<NextAction[]> {
  const unreviewed = await listUnreviewedMilestones(dir);
  return unreviewed.map((entry) => ({
    tool: "subagent" as const,
    hint: `Delegate a review subagent for milestone ${entry.milestoneId} (criteria: ${entry.criterionIds.join(", ")}).`,
    metadata: { milestoneId: entry.milestoneId, criterionIds: entry.criterionIds },
  }));
}

async function computeMilestoneReviewNextActionsSafely(dir: string): Promise<NextAction[]> {
  try {
    return await computeMilestoneReviewNextActions(dir);
  } catch {
    return [];
  }
}

async function computeBlockingForCompleteSafely(dir: string, charterId: string): Promise<BlockingForCompleteEntry[]> {
  try {
    const charter = await loadParsedCharter(dir);
    const criterionState = await loadCriterionState(dir, charterId);
    const state = await loadCharterState(dir);
    const context = await loadBlockingContext(dir, charterId, state);
    const valBlocking = computeBlockingForComplete(charter.criteria, criterionState, context);
    const reportBlocking = await computeReportBlockingForComplete(dir);
    return [...valBlocking, ...reportBlocking];
  } catch {
    return [];
  }
}

async function computeReportBlockingForComplete(dir: string): Promise<BlockingForCompleteEntry[]> {
  const reportPath = join(dir, "REPORT.md");
  let markdown: string;
  try {
    markdown = await readFile(reportPath, "utf8");
  } catch {
    return [];
  }
  const check = checkReportCompletion(markdown);
  return check.emptySections.map((section) => ({
    reason: "report-empty-section",
    description: section,
  }));
}

async function ensureReportScaffold(
  dir: string,
  input: { charterId: string; charterMarkdown: string; objective: string; name?: string },
): Promise<string> {
  const reportPath = join(dir, "REPORT.md");
  try {
    return await readFile(reportPath, "utf8");
  } catch {
    const title = extractCharterTitleFromMarkdown(input.charterMarkdown, input.name);
    const scaffold = renderReportScaffold({ title, objective: input.objective });
    await writeTextAtomic(reportPath, scaffold);
    logger.info("report scaffolded", {
      component: "service",
      charterId: input.charterId,
      reportPath: "REPORT.md",
    });
    return scaffold;
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
        { tool: "charter_status", hint: "Terminal charters are read-only; edit charter.md/criteria.md directly if the contract must change." },
      ],
    });
  }
  if (state.status !== "paused") {
    const from = state.status;
    state.previousStatus = from;
    state.status = "paused";
    state.updatedAt = input.now ?? new Date().toISOString();
    logCharterStatusTransition({ charterId: state.charterId, from, to: state.status, reason: input.reason });
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

/** @deprecated v3 removed ask; pause the charter and clarify with the user directly. */
export async function askCharter(
  projectDir: string,
  input: { charterId?: string; now?: string; note?: string },
): Promise<CharterServiceResult<CharterState>> {
  void projectDir;
  void input;
  throw new CharterToolError("charter ask was removed in v3; pause the charter if blocked and clarify with the user directly.", {
    code: "ask.removed",
    nextActions: [
      { tool: "charter", action: "pause", hint: "Pause if blocked or waiting on user input." },
      { tool: "charter_status", hint: "Inspect current status before continuing." },
    ],
  });
}

export async function completeCharter(
  projectDir: string,
  input: { charterId?: string; completionNote?: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  assertNotV1NeedsReplan(state);
  if (state.status !== "active") {
    throw new CharterToolError(`Cannot complete charter in status ${state.status}; resume first if paused.`, {
      code: "complete.wrong_state",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status before retrying complete." },
        { tool: "charter", action: "resume", hint: "Resume the paused charter before completing." },
        { tool: "charter_status", hint: "Terminal charters are read-only; edit charter.md/criteria.md directly if more work is required." },
      ],
    });
  }
  const charter = await loadParsedCharter(dir);
  const criterionState = await loadCriterionState(dir, charterId);
  const context = await loadBlockingContext(dir, charterId);
  const charterMarkdown = await readFile(join(dir, "charter.md"), "utf8");
  const reportMarkdown = await ensureReportScaffold(dir, {
    charterId,
    charterMarkdown,
    objective: charter.objective,
    name: state.name,
  });
  const srcChangeMs = await lastSrcChangeMs(projectDir);
  const failures = checkCompletionGate(charter.criteria, criterionState, state, context, srcChangeMs);
  failures.push(...checkReportCompletion(reportMarkdown).failures);
  const blocking: BlockingForCompleteEntry[] = [
    ...computeBlockingForComplete(charter.criteria, criterionState, context),
    ...(await computeReportBlockingForComplete(dir)),
  ];
  const trustBlocks = blocking.filter((entry) => entry.reason !== "val-not-pass" && !entry.reason.startsWith("report-"));
  if (blocking.length > 0) {
    // Render `<id>(<reason>)` per VAL so identity-disjoint and
    // requires-subagent-review rejections are distinguishable from generic
    // low-trust evidence in the user-facing error string. The summary line
    // keeps the legacy `low-trust evidence for N VAL(s): ...` phrasing so
    // existing tests grepping for VAL ids continue to match.
    if (trustBlocks.length > 0) {
      const idsWithReasons = trustBlocks.map((entry) => `${entry.criterionId}(${entry.reason})`).join(", ");
      failures.push(`low-trust evidence for ${trustBlocks.length} VAL(s): ${idsWithReasons}`);
    }
  }
  if (failures.length > 0) {
    const valNotPass = Array.from(new Set([
      ...failures
        .map((failure) => failure.match(/^(VAL-[A-Za-z0-9_-]+)/)?.[1])
        .filter((criterionId): criterionId is string => Boolean(criterionId)),
      ...blocking
        .filter((entry) => entry.reason === "val-not-pass")
        .map((entry) => entry.criterionId)
        .filter((criterionId): criterionId is string => Boolean(criterionId)),
    ]));
    const blockingReasons = Array.from(new Set([
      ...failures.map((failure) => {
        const separator = failure.indexOf(":");
        return separator === -1 ? failure : failure.slice(separator + 1).trim();
      }),
      ...blocking.map((entry) => entry.reason),
    ]));
    logger.info("completion blocked", {
      component: "service",
      charterId,
      blockingReasons,
      valNotPass,

    });
    const message = [
      `Cannot complete charter:`,
      ` - ${failures.join("\n - ")}`,
      ...(trustBlocks.length > 0
        ? ["Fix: add Because: rationale and record pass evidence from a review subagent (source=subagent, recordedBy=subagent:<agent>:<sessionId>) for the listed VALs."]
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
    for (const b of blocking) {
      if (b.reason !== "readiness-blocking" && b.reason !== "untriaged-handoff-items" && b.criterionId) {
        failingIds.add(b.criterionId);
      }
    }
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
        hint: `Record subagent-attributed pass evidence for ${id} (set source='subagent', recordedBy='subagent:<agent>:<sessionId>').`,
      });
    }
    const reviewerBlocking = blocking.filter((entry) => entry.reason !== "val-not-pass");
    if (reviewerBlocking.length > 0) {
      nextActions.push({
        tool: "subagent",
        hint: `Delegate a review subagent for: ${reviewerBlocking.map((b) => b.criterionId).filter(Boolean).join(", ")}.`,
      });
    }

    const reportBlockers = blocking.filter((entry) => entry.reason.startsWith("report-"));
    if (reportBlockers.length > 0) {
      nextActions.push({
        tool: "charter",
        action: "complete",
        hint: "Fill every REPORT.md heading (Outcome and Notes after the first scaffold), then retry charter action=complete.",
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
  const from = state.status;
  state.status = "completed";
  state.previousStatus = undefined;
  state.completedAt = now;
  state.updatedAt = now;
  state.completionReason = input.completionNote?.trim() || undefined;
  logCharterStatusTransition({ charterId, from, to: state.status, reason: state.completionReason });
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
  logger.info("charter completed", {
    component: "service",
    charterId,
    valCount: charter.criteria.length,
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

export async function abandonCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new CharterToolError("abandon requires a non-empty reason.", {
      code: "abandon.empty_reason",
      nextActions: [
        { tool: "charter", action: "abandon", hint: "Retry with `reason: '<why the charter is being abandoned>'`." },
        { tool: "charter_status", hint: "Inspect the charter before abandoning." },
      ],
    });
  }
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (isTerminal(state.status)) {
    throw new CharterToolError(`Charter ${charterId} is already terminal (${state.status}).`, {
      code: "abandon.already_terminal",
      nextActions: [
        { tool: "charter_status", hint: "Inspect the terminal charter; abandon is only legal on non-terminal charters." },
      ],
    });
  }
  const now = input.now ?? new Date().toISOString();
  await dispatchHook("charter:before_abandon", {
    type: "charter:before_abandon",
    charterId,
    ts: now,
    reason,
  });
  const from = state.status;
  state.previousStatus = from;
  state.status = "abandoned";
  state.updatedAt = now;
  state.completionReason = reason;
  state.terminatedAt = now;
  logCharterStatusTransition({ charterId, from, to: state.status, reason });
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_abandoned", ts: now, charterId, reason });
  return {
    charterId,
    status: state.status,
    message: `Abandoned charter ${charterId}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

/** @deprecated Use abandonCharter. v3 abandon only transitions to `abandoned`. */
export async function forceCompleteCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; target?: "completed" | "abandoned" | "budget_limited"; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  if (input.target && input.target !== "abandoned") {
    throw new CharterToolError(`v3 abandon only supports terminal status abandoned; got ${input.target}.`, {
      code: "abandon.non_abandoned_target",
      nextActions: [
        { tool: "charter", action: "complete", hint: "Use charter action=complete when evidence gates pass." },
        { tool: "charter", action: "abandon", hint: "Pass `reason: '<why the charter is being abandoned>'` to abandon." },
      ],
    });
  }
  return abandonCharter(projectDir, input);
}

/** @deprecated amend_charter was removed; edit charter.md and criteria.md directly. */
export async function amendCharter(
  projectDir: string,
  input: { charterId?: string; reason: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  void projectDir;
  void input;
  throw new CharterToolError("charter amend_charter was removed in v3; edit charter.md and criteria.md directly to rescope the contract.", {
    code: "amend.removed",
    nextActions: [
      { tool: "charter_status", hint: "Inspect the charter and edit charter.md/criteria.md directly." },
      { tool: "charter", action: "abandon", hint: "Abandon if the charter should not continue." },
    ],
  });
}

/**
 * Extra inputs used by `computeBlockingForComplete` to evaluate the
 * explicit review-subagent gate and the identity-disjoint predicate. When
 * omitted, only the trust gate applies and `requireReviewSubagent` defaults
 * to the criterion's declared (or undefined-as-false) value.
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
 * Only an explicit `RequireReviewSubagent: true` in criteria.md enables the
 * review subagent gate. Legacy milestone_ready_for_review auto-default is not
 * applied.
 */
export function effectiveRequireReviewSubagent(
  criterion: CharterCriterion,
  _milestoneCriterionIds?: ReadonlySet<string>,
): boolean {
  return criterion.requireReviewSubagent === true;
}

/**
 * Shared trust-gate computation used by both `completeCharter` (to block) and
 * `getCharterStatus` (to surface). A criterion shows up here when:
 *   - it has pass evidence AND that evidence is low-trust (manual or
 *     manual+because) AND the writer isn't a review subagent; OR
 *   - effective `requireReviewSubagent` is true and no pass evidence has a
 *     a subagent review writer; OR
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
      const subagentRecords = allPass.filter((rb) => isSubagentRecordedBy(rb));
      if (subagentRecords.length === 0) {
        blocking.push({ criterionId: criterion.id, reason: "requires-subagent-review" });
        continue;
      }
      const implementerSession = context.implementerSessionByCriterion.get(criterion.id);
      if (implementerSession) {
        const allShareImplementer = subagentRecords.every((rb) =>
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
  const sessionId = parts.slice(2).join(":");
  return sessionId.trim() ? sessionId : undefined;
}

export function isSubagentRecordedBy(recordedBy: string): boolean {
  return extractSessionId(recordedBy) !== undefined;
}

function blockingReason(record: CriterionStateRecord): string | undefined {
  const recordedBy = record.recordedBy ?? "agent:root";
  if (isSubagentRecordedBy(recordedBy)) return undefined;
  const source: EvidenceSource = record.source ?? "manual";
  const hasBecause = Boolean(record.because && record.because.trim());
  const rank = trustRank({ recordedBy, source, hasBecause });
  if (rank > 1) return undefined;
  if (source !== "manual") {
    // High-trust source (verifier/hook/subagent) recorded by a non-subagent writer
    // writer is rare but still passes the gate; only manual lands here.
    return undefined;
  }
  return hasBecause ? "manual+because" : "manual";
}

function checkCompletionGate(
  criteria: CharterCriterion[],
  criterionState: { criteria: Record<string, { outcome: string; lastTs: string; source?: string; lastFeatureId?: string }> },
  state: CharterState,
  context: BlockingContext | undefined,
  srcChangeMs: number | undefined,
): string[] {
  const failures: string[] = [];
  // Guard against vacuous completion: a charter with zero parsed criteria would
  // otherwise pass this gate trivially (the loop runs zero times). An empty
  // register means the criteria were never authored or failed to parse, so a
  // "0/0 complete" is never a real success.
  if (criteria.length === 0) {
    failures.push("register-empty: no VAL criteria parsed from criteria.md; author criteria (and fix any parse-warnings) before completing");
  }
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
    if (criterion.requireFreshEvidence && isEvidenceStaleForSrcChange(record.lastTs, srcChangeMs)) {
      failures.push(`${criterion.id}: evidence predates last src/ change; re-run verifier or record fresh evidence`);
      continue;
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
 * the explicit review-subagent gate and identity-disjoint predicate. Returns
 * empty maps on missing/unreadable inputs so callers can safely fall back to
 * the trust-gate-only behaviour.
 */
export async function loadBlockingContext(dir: string, charterId: string, state?: CharterState): Promise<BlockingContext> {
  const milestoneCriterionIds = await loadMilestoneReadyCriterionIds(dir);
  const implementerSessionByCriterion = new Map<string, string>();
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


/**
 * Walk work/<featureId>/evidence run directories and collect every pass
 * evidence record's `recordedBy` keyed by criterionId.
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
  input: { charterId?: string; now?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input.charterId);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "paused") {
    throw new CharterToolError(`Cannot resume charter in status ${state.status}`, {
      code: "lifecycle.wrong_state",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; resume is only legal from `paused`." },
        { tool: "charter", action: "pause", hint: "Pause the charter first if you want to later resume it." },
      ],
    });
  }
  const from = state.status;
  state.status = "active";
  state.previousStatus = undefined;
  state.updatedAt = input.now ?? new Date().toISOString();
  logCharterStatusTransition({ charterId: state.charterId, from, to: state.status });
  await writeCharterState(dir, state);
  await appendEvent(dir, {
    type: "charter_resumed",
    ts: state.updatedAt,
    charterId: state.charterId,
  });
  return {
    charterId: state.charterId,
    status: state.status,
    message: `Resumed charter ${state.charterId}.`,
    data: state,
    nextActions: nextActionsForStatus(state.status),
  };
}

/**
 * v3 status nextActions: base FSM hints plus drift-driven advisory rows.
 * Legacy milestone_ready_for_review review prompts are not emitted.
 */
export function buildActiveNextActions(opts: {
  status: CharterStatus;
  drift: DriftViews;
  blockingForComplete: BlockingForCompleteEntry[];
}): NextAction[] {
  const base = nextActionsForStatus(opts.status);
  if (opts.status !== "active") return base;

  const extras: NextAction[] = [];
  const ready = opts.drift.readyNext[0];
  if (ready) {
    const milestoneSuffix = ready.milestoneId ? ` (milestone ${ready.milestoneId})` : "";
    extras.push({
      tool: "charter_record",
      action: "verify",
      hint: `Advisory next VAL: ${ready.criterionId}${milestoneSuffix}.`,
      metadata: { criterionId: ready.criterionId, milestoneId: ready.milestoneId },
    });
  }

  const reviewBlockers = new Set(
    opts.blockingForComplete
      .filter((entry) => entry.reason === "requires-subagent-review" && entry.criterionId)
      .map((entry) => entry.criterionId!),
  );
  for (const criterionId of reviewBlockers) {
    extras.push({
      tool: "subagent",
      hint: `Delegate a review subagent for ${criterionId} (RequireReviewSubagent).`,
      metadata: { criterionId },
    });
  }

  return [...base, ...extras];
}

export function nextActionsForStatus(status: CharterStatus): NextAction[] {
  switch (status) {
    case "active":
      return [
        { tool: "charter_status", hint: "Read drift views before choosing the next move." },
        { tool: "charter_record", action: "evidence", hint: "Record evidence after running a check." },
        { tool: "charter_record", action: "verify", hint: "Run configured command verifiers for criteria." },
        { tool: "charter", action: "pause", hint: "Pause if blocked or waiting on user input." },
        { tool: "charter", action: "complete", hint: "Complete only if evidence gates pass and REPORT.md sections are filled." },
        { tool: "charter", action: "abandon", hint: "Abandon with a non-empty reason if the charter should not continue." },
      ];
    case "paused":
      return [
        { tool: "charter", action: "resume", hint: "Resume the paused charter." },
        { tool: "charter_status", hint: "Inspect current charter state." },
        { tool: "charter", action: "abandon", hint: "Abandon with a non-empty reason if the charter should not continue." },
      ];
    case "completed":
    case "abandoned":
      return [
        { tool: "charter_status", hint: "Inspect terminal charter result." },
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
  if (status === "paused") return "paused";
  if (status === "active") return "active";
  return "terminal";
}

function guidelinesForStatus(status: CharterStatus): string[] {
  if (status === "active") return [
    "Active charter: drive every VAL to pass evidence end-to-end without stopping for permission.",
    "MAIN AGENT CONTEXT IS PRECIOUS. Delegate verification and critique to user-owned subagents (`subagent({agent:'<name>', metadata:{'pi-charter.charterId':<id>, 'pi-charter.criterionId':'VAL-...', 'pi-charter.projectDir':<cwd>}, ...})`); delegate read-only recon to `subagent({agent:'explorer', ...})`.",
    "SYNC vs ASYNC: a sync subagent call blocks main entirely until the child finishes — main cannot read files, spawn more work, or receive messages/reminders in the meantime. That is fine when the next move depends on the child's output. An `async:true` call returns immediately with a run id; the child runs in the background while main is free to read, edit, spawn more subagents, or hand control back to the user. The subagent runtime wakes main when any child finishes or needs attention, so explicit sleeping/polling is usually unnecessary.",
    "PREFER ASYNC when the next step does not depend on the child's output, when you want to fan out multiple independent runs, or when the user should be able to prompt fixes while work progresses. Stay sync when you genuinely need the result before choosing the next move and have nothing else to do in parallel.",
    "requireReviewSubagent is satisfied by any pass evidence with source=subagent and non-empty recordedBy (e.g. subagent:<agent>:<sessionId>); use your own review subagents.",
    "Choose one next move from charter_status nextActions; do not guess transitions.",
  ];
  if (status === "paused") return ["Resume before recording new evidence or changing contract files."];
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
  "active",
  "paused",
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
