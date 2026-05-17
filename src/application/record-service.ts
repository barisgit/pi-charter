import { spawn } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { parseFeatureMarkdown } from "../domain/feature-md";
import type { CharterCriterion, RecordedBy } from "../domain/types";

/** Default identity for evidence written by the root agent. Callers (handoff,
 * delegated tooling) override this when they have a more specific identity. */
const DEFAULT_RECORDED_BY: RecordedBy = "agent:root";
/** Persona prefix used when applyHandoff derives recordedBy from subagentSessionId. */
const DEFAULT_HANDOFF_PERSONA = "charter-verifier";
import {
  appendEvent,
  charterDir,
  loadCharterState,
  writeJsonAtomic,
  writeTextAtomic,
} from "../infrastructure/store";
import { nextActionsForStatus, type NextAction } from "./service";

export type EvidenceOutcome = "pass" | "fail" | "partial";

export interface RecordEvidenceInput {
  charterId: string;
  criterionId: string;
  featureId?: string;
  outcome: EvidenceOutcome;
  summary: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
  source?: "manual" | "verifier" | "subagent";
  /** Identity of the writer. Defaults to 'agent:root' when omitted. */
  recordedBy?: RecordedBy;
  /** Rationale; REQUIRED when source === 'manual'. */
  because?: string;
  now?: string;
}

/**
 * A single evidence entry inside a `recordEvidenceBatch` call. Shape mirrors
 * `RecordEvidenceInput` minus the per-call fields (`charterId`, `now`) that
 * apply to the whole batch.
 */
export interface EvidenceEntry {
  criterionId: string;
  featureId?: string;
  outcome: EvidenceOutcome;
  summary: string;
  because?: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
  /** Narrowed to match `RecordEvidenceInput.source`; "hook" sources do not
   * flow through the user-facing tool surface. */
  source?: "manual" | "verifier" | "subagent";
  recordedBy?: RecordedBy;
}

export interface RecordEvidenceBatchInput {
  charterId: string;
  entries: EvidenceEntry[];
  now?: string;
}

export interface RecordEvidenceBatchResult {
  charterId: string;
  entries: Array<{ criterionId: string; featureId?: string; outcome: EvidenceOutcome; path: string; ts: string }>;
  nextActions: NextAction[];
}

export interface RecordEvidenceResult {
  charterId: string;
  criterionId: string;
  featureId?: string;
  outcome: EvidenceOutcome;
  path: string;
  ts: string;
  nextActions: NextAction[];
}

export interface CriterionStateRecord {
  outcome: EvidenceOutcome;
  lastEvidencePath: string;
  lastTs: string;
  lastSummary: string;
  lastFeatureId?: string;
  source?: "manual" | "verifier" | "subagent";
  recordedBy?: RecordedBy;
  because?: string;
}

export interface CriterionStateFile {
  charterId: string;
  criteria: Record<string, CriterionStateRecord>;
}

export async function recordEvidence(
  projectDir: string,
  input: RecordEvidenceInput,
): Promise<RecordEvidenceResult> {
  if (!input.summary?.trim()) throw new Error("summary is required");
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active" && state.status !== "review") {
    throw new Error(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`);
  }

  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) throw new Error(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`);

  const source = input.source ?? "manual";
  const because = input.because?.trim() || undefined;
  if (source === "manual" && !because) {
    // Manual evidence is the lowest-trust write; without a stable rationale
    // the completion gate cannot tell drive-by approvals from real review.
    throw new Error(`Manual evidence for ${criterion.id} requires a non-empty 'because' rationale.`);
  }
  const recordedBy: RecordedBy = input.recordedBy ?? DEFAULT_RECORDED_BY;

  const now = input.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const featureSegment = input.featureId?.trim() || "_charter";
  const relativePath = join("work", featureSegment, "evidence", `${criterion.id}__${stamp}.json`);
  const absolutePath = join(dir, relativePath);

  const record = {
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId,
    outcome: input.outcome,
    summary: input.summary.trim(),
    artifacts: input.artifacts ?? [],
    details: input.details ?? {},
    source,
    recordedBy,
    ...(because ? { because } : {}),
    verifier: criterion.verifier,
    ts: now,
  };
  await writeTextAtomic(absolutePath, `${JSON.stringify(record, null, 2)}\n`);

  const stateFile = await loadCriterionState(dir, input.charterId);
  stateFile.criteria[criterion.id] = {
    outcome: input.outcome,
    lastEvidencePath: relativePath,
    lastTs: now,
    lastSummary: record.summary,
    lastFeatureId: input.featureId,
    source,
    recordedBy,
    ...(because ? { because } : {}),
  };
  await writeJsonAtomic(join(dir, "criterion-state.json"), stateFile);

  await appendEvent(dir, {
    type: "evidence_recorded",
    ts: now,
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId,
    outcome: input.outcome,
    source: record.source,
  });

  if (input.featureId) {
    await projectFeatureCompletionFromEvidence(dir, input.featureId, input.charterId, now);
    await projectMilestoneReadyForReview(dir, input.charterId, input.featureId, now);
  }

  return {
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId,
    outcome: input.outcome,
    path: relativePath,
    ts: now,
    nextActions: nextActionsForEvidence(criterion, input.outcome, state.status),
  };
}

/**
 * Atomic-within-call batch evidence record. Validates all entries up front,
 * stages every per-entry evidence file, then commits with a SINGLE
 * `writeJsonAtomic(criterion-state.json)` regardless of N. On any validation
 * or staged-write failure, criterion-state.json is left untouched and any
 * partially-written evidence files are unlinked (best effort).
 *
 * Out of scope: concurrent-writer race elimination (tracked separately).
 */
export async function recordEvidenceBatch(
  projectDir: string,
  input: RecordEvidenceBatchInput,
): Promise<RecordEvidenceBatchResult> {
  if (!input.entries || input.entries.length === 0) {
    throw new Error("recordEvidenceBatch requires at least one entry.");
  }
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active" && state.status !== "review") {
    throw new Error(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`);
  }

  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criteriaById = new Map(charter.criteria.map((entry) => [entry.id, entry]));

  // ---- Phase 1: validate every entry up front (no I/O after this fails). ----
  type BatchEvidenceSource = NonNullable<EvidenceEntry["source"]>;
  interface Prepared {
    entry: EvidenceEntry;
    criterion: CharterCriterion;
    source: BatchEvidenceSource;
    because?: string;
    recordedBy: RecordedBy;
    relativePath: string;
    absolutePath: string;
    record: Record<string, unknown>;
    payload: string;
  }

  const now = input.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const prepared: Prepared[] = [];

  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    if (!entry.summary?.trim()) {
      throw new Error(`recordEvidenceBatch entry ${index} (${entry.criterionId ?? "<unknown>"}): summary is required.`);
    }
    if (!entry.criterionId?.trim()) {
      throw new Error(`recordEvidenceBatch entry ${index}: criterionId is required.`);
    }
    if (!entry.outcome) {
      throw new Error(`recordEvidenceBatch entry ${index} (${entry.criterionId}): outcome is required.`);
    }
    const criterion = criteriaById.get(entry.criterionId);
    if (!criterion) {
      throw new Error(`recordEvidenceBatch entry ${index}: unknown criterion ${entry.criterionId} in charter ${input.charterId}.`);
    }
    const source: BatchEvidenceSource = entry.source ?? "manual";
    const because = entry.because?.trim() || undefined;
    if (source === "manual" && !because) {
      throw new Error(`recordEvidenceBatch entry ${index} (${criterion.id}): manual evidence requires a non-empty 'because' rationale.`);
    }
    const recordedBy: RecordedBy = entry.recordedBy ?? DEFAULT_RECORDED_BY;
    const featureSegment = entry.featureId?.trim() || "_charter";
    // Per-entry index suffix prevents same-`now` filename collisions when the
    // caller passes a fixed `now` (test fixtures, deterministic replays) or
    // when the system clock yields identical ISO strings for sub-ms calls.
    const indexSuffix = String(index).padStart(3, "0");
    const relativePath = join("work", featureSegment, "evidence", `${criterion.id}__${stamp}_${indexSuffix}.json`);
    const absolutePath = join(dir, relativePath);
    const record: Record<string, unknown> = {
      charterId: input.charterId,
      criterionId: criterion.id,
      featureId: entry.featureId,
      outcome: entry.outcome,
      summary: entry.summary.trim(),
      artifacts: entry.artifacts ?? [],
      details: entry.details ?? {},
      source,
      recordedBy,
      ...(because ? { because } : {}),
      verifier: criterion.verifier,
      ts: now,
    };
    prepared.push({
      entry,
      criterion,
      source,
      because,
      recordedBy,
      relativePath,
      absolutePath,
      record,
      payload: `${JSON.stringify(record, null, 2)}\n`,
    });
  }

  // ---- Phase 2: write each evidence file (writeTextAtomic is per-file atomic). ----
  // On any failure here, unlink already-written files and re-throw BEFORE the
  // single criterion-state.json write so partial state never lands.
  const writtenPaths: string[] = [];
  try {
    for (const item of prepared) {
      await writeTextAtomic(item.absolutePath, item.payload);
      writtenPaths.push(item.absolutePath);
    }
  } catch (error) {
    for (const path of writtenPaths) {
      await unlink(path).catch(() => undefined);
    }
    throw error;
  }

  // ---- Phase 3: ONE criterion-state.json write covering all entries. ----
  // Last entry per criterionId wins, matching single-entry semantics if the
  // caller repeats a criterion in the same batch.
  const stateFile = await loadCriterionState(dir, input.charterId);
  for (const item of prepared) {
    stateFile.criteria[item.criterion.id] = {
      outcome: item.entry.outcome,
      lastEvidencePath: item.relativePath,
      lastTs: now,
      lastSummary: String(item.record.summary),
      lastFeatureId: item.entry.featureId,
      source: item.source,
      recordedBy: item.recordedBy,
      ...(item.because ? { because: item.because } : {}),
    };
  }
  await writeJsonAtomic(join(dir, "criterion-state.json"), stateFile);

  // ---- Phase 4: per-entry events (preserves existing evidence_recorded semantics). ----
  for (const item of prepared) {
    await appendEvent(dir, {
      type: "evidence_recorded",
      ts: now,
      charterId: input.charterId,
      criterionId: item.criterion.id,
      featureId: item.entry.featureId,
      outcome: item.entry.outcome,
      source: item.source,
    });
  }

  // ---- Phase 5: project feature completion once per touched featureId. ----
  const touchedFeatureIds: string[] = [];
  const seenFeatures = new Set<string>();
  for (const item of prepared) {
    const fid = item.entry.featureId;
    if (fid && !seenFeatures.has(fid)) {
      seenFeatures.add(fid);
      touchedFeatureIds.push(fid);
    }
  }
  for (const featureId of touchedFeatureIds) {
    await projectFeatureCompletionFromEvidence(dir, featureId, input.charterId, now);
  }
  // projectMilestoneReadyForReview dedupes internally per (milestoneId, planDigest);
  // calling once is sufficient — it sweeps the whole milestone of the triggering feature.
  if (touchedFeatureIds.length > 0) {
    await projectMilestoneReadyForReview(dir, input.charterId, touchedFeatureIds[0]!, now);
  }

  // ---- Response: preserve request order. ----
  const responseEntries = prepared.map((item) => ({
    criterionId: item.criterion.id,
    featureId: item.entry.featureId,
    outcome: item.entry.outcome,
    path: item.relativePath,
    ts: now,
  }));

  // Build nextActions from the LAST entry's outcome to mirror single-call shape;
  // batch callers can inspect per-entry outcomes via response.entries.
  const last = prepared[prepared.length - 1]!;
  return {
    charterId: input.charterId,
    entries: responseEntries,
    nextActions: nextActionsForEvidence(last.criterion, last.entry.outcome, state.status),
  };
}

export async function loadCriterionState(dir: string, charterId: string): Promise<CriterionStateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8")) as Partial<CriterionStateFile>;
    return {
      charterId: parsed.charterId ?? charterId,
      criteria: parsed.criteria && typeof parsed.criteria === "object" ? (parsed.criteria as Record<string, CriterionStateRecord>) : {},
    };
  } catch {
    return { charterId, criteria: {} };
  }
}

export interface VerifyCriterionInput {
  charterId: string;
  criterionId: string;
  featureId?: string;
  cwd?: string;
  timeoutMs?: number;
  now?: string;
}

export interface VerifyCriterionResult extends RecordEvidenceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_BYTES = 64 * 1024;

export async function verifyCriterion(
  projectDir: string,
  input: VerifyCriterionInput,
): Promise<VerifyCriterionResult> {
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active" && state.status !== "review") {
    throw new Error(`Cannot verify in status ${state.status}; charter must be active or in review.`);
  }
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) throw new Error(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`);
  if (criterion.verifier !== "command") {
    throw new Error(`charter_record verify for verifier=${criterion.verifier} is not implemented yet; only command verifier is supported.`);
  }
  if (!criterion.command?.trim()) {
    throw new Error(`Criterion ${criterion.id} has verifier=command but no Command: field set in charter.md.`);
  }

  const started = Date.now();
  const execution = await runCommand(criterion.command, {
    cwd: input.cwd ?? projectDir,
    timeoutMs: input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
  });
  const durationMs = Date.now() - started;
  const outcome: EvidenceOutcome = execution.exitCode === 0 ? "pass" : "fail";
  const summary = `command verifier exit=${execution.exitCode} duration=${durationMs}ms`;
  const evidence = await recordEvidence(projectDir, {
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId,
    outcome,
    summary,
    source: "verifier",
    recordedBy: DEFAULT_RECORDED_BY,
    details: {
      command: criterion.command,
      exitCode: execution.exitCode,
      durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      truncated: execution.truncated,
      timedOut: execution.timedOut,
    },
    now: input.now,
  });
  return {
    ...evidence,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    command: criterion.command,
    durationMs,
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

function runCommand(command: string, options: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_CAPTURED_BYTES) { truncated = true; return; }
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_CAPTURED_BYTES) { stdout = stdout.slice(0, MAX_CAPTURED_BYTES); truncated = true; }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_CAPTURED_BYTES) { truncated = true; return; }
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_CAPTURED_BYTES) { stderr = stderr.slice(0, MAX_CAPTURED_BYTES); truncated = true; }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : signal ? 128 : 1;
      resolve({ exitCode, stdout, stderr, truncated, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err), truncated, timedOut });
    });
  });
}

export interface HandoffCompletedCriterion {
  criterionId: string;
  outcome: EvidenceOutcome;
  summary: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
}

export interface ApplyHandoffInput {
  charterId: string;
  featureId: string;
  subagentSessionId: string;
  handoffNote: string;
  completedCriteria: HandoffCompletedCriterion[];
  now?: string;
}

export interface ApplyHandoffResult {
  charterId: string;
  featureId: string;
  subagentSessionId: string;
  handoffPath: string;
  appliedCount: number;
  ts: string;
  nextActions: NextAction[];
}

export interface FeatureStateRecord {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  lastWorkerSessionId?: string;
  lastHandoffPath?: string;
}

export interface FeatureStateFile {
  charterId: string;
  features: Record<string, FeatureStateRecord>;
}

export async function applyHandoff(projectDir: string, input: ApplyHandoffInput): Promise<ApplyHandoffResult> {
  if (!input.completedCriteria || input.completedCriteria.length === 0) {
    throw new Error("applyHandoff requires at least one completedCriteria entry.");
  }
  if (!input.featureId?.trim()) throw new Error("applyHandoff requires featureId.");
  if (!input.subagentSessionId?.trim()) throw new Error("applyHandoff requires subagentSessionId.");
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active" && state.status !== "review") {
    throw new Error(`Cannot apply handoff in status ${state.status}; charter must be active or in review.`);
  }
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criteriaById = new Map(charter.criteria.map((criterion) => [criterion.id, criterion]));
  for (const completed of input.completedCriteria) {
    if (!criteriaById.has(completed.criterionId)) throw new Error(`Unknown criterion ${completed.criterionId} in handoff.`);
  }
  const now = input.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const handoffRelative = join("handoffs", `${stamp}__${input.featureId}__${input.subagentSessionId}.json`);
  const handoffAbsolute = join(dir, handoffRelative);
  const envelope = {
    charterId: input.charterId,
    featureId: input.featureId,
    subagentSessionId: input.subagentSessionId,
    handoffNote: input.handoffNote,
    completedCriteria: input.completedCriteria,
    ts: now,
  };
  await writeTextAtomic(handoffAbsolute, `${JSON.stringify(envelope, null, 2)}\n`);

  for (const completed of input.completedCriteria) {
    await recordEvidence(projectDir, {
      charterId: input.charterId,
      criterionId: completed.criterionId,
      featureId: input.featureId,
      outcome: completed.outcome,
      summary: completed.summary,
      artifacts: completed.artifacts,
      details: { ...(completed.details ?? {}), subagentSessionId: input.subagentSessionId, handoffPath: handoffRelative },
      source: "subagent",
      recordedBy: `subagent:${DEFAULT_HANDOFF_PERSONA}:${input.subagentSessionId}` as RecordedBy,
      now,
    });
  }

  const featureState = await loadFeatureState(dir, input.charterId);
  const existing = featureState.features[input.featureId] ?? {};
  const completed = await handoffCompletesFeature(dir, input.featureId, input.charterId);
  // A handoff from the charter-verifier persona is a review, not an
  // implementation. Preserve any existing implementer session id (VAL-13);
  // when none is recorded, leave lastWorkerSessionId unset so the
  // identity-disjoint predicate skips this feature cleanly instead of
  // treating the reviewer as the implementer.
  const isReviewHandoff = input.subagentSessionId.startsWith(`${DEFAULT_HANDOFF_PERSONA}-`)
    || input.subagentSessionId === DEFAULT_HANDOFF_PERSONA
    || input.subagentSessionId.includes("charter-verifier");
  const nextWorkerSessionId = isReviewHandoff
    ? existing.lastWorkerSessionId
    : input.subagentSessionId;
  featureState.features[input.featureId] = {
    ...existing,
    status: completed ? "completed" : existing.status ?? "in_progress",
    startedAt: existing.startedAt ?? now,
    completedAt: completed ? existing.completedAt ?? now : existing.completedAt,
    lastWorkerSessionId: nextWorkerSessionId,
    lastHandoffPath: handoffRelative,
  };
  await writeJsonAtomic(join(dir, "feature-state.json"), featureState);

  await appendEvent(dir, {
    type: "handoff_applied",
    ts: now,
    charterId: input.charterId,
    featureId: input.featureId,
    subagentSessionId: input.subagentSessionId,
    appliedCount: input.completedCriteria.length,
  });

  await projectMilestoneReadyForReview(dir, input.charterId, input.featureId, now);

  return {
    charterId: input.charterId,
    featureId: input.featureId,
    subagentSessionId: input.subagentSessionId,
    handoffPath: handoffRelative,
    appliedCount: input.completedCriteria.length,
    ts: now,
    nextActions: [
      { tool: "charter_status", hint: "Inspect drift after handoff." },
      { tool: "charter_record", action: "verify", hint: "Re-run verifiers to confirm subagent claims." },
      ...nextActionsForStatus(state.status),
    ],
  };
}

async function handoffCompletesFeature(dir: string, featureId: string, charterId: string): Promise<boolean> {
  let fulfills: string[];
  try {
    const feature = parseFeatureMarkdown(await readFile(join(dir, "plan", `${featureId}.md`), "utf8"));
    fulfills = feature.fulfills;
  } catch {
    return false;
  }
  if (fulfills.length === 0) return false;
  const criterionState = await loadCriterionState(dir, charterId);
  return fulfills.every((criterionId) => criterionState.criteria[criterionId]?.outcome === "pass");
}

/**
 * After an evidence record is written, flip `feature-state.<featureId>.status`
 * to `completed` if every fulfilled criterion for that feature now has pass\n+ * evidence. Mirrors the projection in `applyHandoff` so agents that record\n+ * evidence directly (no handoff envelope) still see the feature close.\n+ */
async function projectFeatureCompletionFromEvidence(dir: string, featureId: string, charterId: string, now: string): Promise<void> {
  const completed = await handoffCompletesFeature(dir, featureId, charterId);
  if (!completed) return;
  const featureState = await loadFeatureState(dir, charterId);
  const existing = featureState.features[featureId] ?? {};
  if (existing.status === "completed") return;
  featureState.features[featureId] = {
    ...existing,
    status: "completed",
    startedAt: existing.startedAt ?? now,
    completedAt: existing.completedAt ?? now,
  };
  await writeJsonAtomic(join(dir, "feature-state.json"), featureState);
}

/**
 * After a feature flips to completed, check whether every feature in the
 * same milestone is now completed (none failed). If so, emit a single
 * `milestone_ready_for_review` event per `(milestoneId, planDigest)`. The
 * event is purely additive — it never gates anything. Charter status and the
 * evaluator surface it.
 */
async function projectMilestoneReadyForReview(
  dir: string,
  charterId: string,
  triggeringFeatureId: string,
  now: string,
): Promise<void> {
  // Identify the milestone of the triggering feature.
  let triggeringMilestone: string;
  try {
    const feature = parseFeatureMarkdown(await readFile(join(dir, "plan", `${triggeringFeatureId}.md`), "utf8"));
    triggeringMilestone = feature.milestone;
  } catch {
    return;
  }
  if (!triggeringMilestone) return;

  // Load every feature in the milestone and union their fulfills.
  const planDir = join(dir, "plan");
  let entries: string[];
  try {
    entries = (await readdir(planDir)).filter((entry) => entry.endsWith(".md"));
  } catch {
    return;
  }
  const milestoneFeatures: { id: string; fulfills: string[] }[] = [];
  for (const entry of entries) {
    let feature;
    try {
      feature = parseFeatureMarkdown(await readFile(join(planDir, entry), "utf8"));
    } catch {
      continue;
    }
    if (feature.milestone === triggeringMilestone) {
      milestoneFeatures.push({ id: feature.id, fulfills: feature.fulfills });
    }
  }
  if (milestoneFeatures.length === 0) return;

  const featureState = await loadFeatureState(dir, charterId);
  // Suppress when ANY feature in the milestone is marked failed.
  for (const feature of milestoneFeatures) {
    if (featureState.features[feature.id]?.status === "failed") return;
  }
  // Require ALL features completed.
  for (const feature of milestoneFeatures) {
    if (featureState.features[feature.id]?.status !== "completed") return;
  }

  const planDigest = await loadPlanDigest(dir);
  // Idempotency: skip if an event for this (milestoneId, planDigest) already exists.
  const eventsPath = join(dir, "events.jsonl");
  let existing = "";
  try {
    existing = await readFile(eventsPath, "utf8");
  } catch {
    existing = "";
  }
  if (existing) {
    for (const line of existing.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (
          event.type === "milestone_ready_for_review" &&
          event.milestoneId === triggeringMilestone &&
          event.planDigest === planDigest
        ) {
          return;
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  const criterionIds = Array.from(new Set(milestoneFeatures.flatMap((feature) => feature.fulfills))).sort();
  await appendEvent(dir, {
    type: "milestone_ready_for_review",
    ts: now,
    charterId,
    milestoneId: triggeringMilestone,
    planDigest,
    criterionIds,
  });
}

async function loadPlanDigest(dir: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { planDigest?: unknown };
    if (typeof parsed.planDigest === "string") return parsed.planDigest;
  } catch {
    // fall through
  }
  return "";
}

export async function loadFeatureState(dir: string, charterId: string): Promise<FeatureStateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as Partial<FeatureStateFile>;
    return {
      charterId: parsed.charterId ?? charterId,
      features: parsed.features && typeof parsed.features === "object" ? (parsed.features as Record<string, FeatureStateRecord>) : {},
    };
  } catch {
    return { charterId, features: {} };
  }
}

function nextActionsForEvidence(criterion: CharterCriterion, outcome: EvidenceOutcome, status: "active" | "review"): NextAction[] {
  const baseline = nextActionsForStatus(status);
  if (outcome === "fail" || outcome === "partial") {
    return [
      { tool: "charter_record", action: "evidence", hint: `Investigate failure for ${criterion.id} and record follow-up evidence.` },
      { tool: "charter_status", hint: "Re-read drift after a failure to choose the next move." },
      ...baseline,
    ];
  }
  return [
    { tool: "charter_record", action: "verify", hint: `Run the configured verifier (${criterion.verifier}) if you want machine-confirmed evidence.` },
    { tool: "charter_status", hint: "Inspect drift and remaining uncovered criteria." },
    ...baseline,
  ];
}
