import { spawn } from "node:child_process";
import { access, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { parseFeatureMarkdown } from "../domain/feature-md";
import { validateEvidenceFile, type CommandEvidence, type EvidenceFile, type ReadinessEvidence } from "../domain/evidence-schemas";
import type { CharterCriterion, RecordedBy } from "../domain/types";
import { logger } from "../infrastructure/logger";

/** Default identity for evidence written by the root agent. Callers (handoff,
 * delegated tooling) override this when they have a more specific identity. */
const DEFAULT_RECORDED_BY: RecordedBy = "agent:root";
/** Persona prefix used when applyHandoff derives recordedBy from subagentSessionId. */
const DEFAULT_HANDOFF_PERSONA = "charter-reviewer";
const warnedLegacyQaScreenshots = new Set<string>();
import {
  appendEvent,
  charterDir,
  loadCharterState,
  withCharterLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "../infrastructure/store";
import { loadFeatureState, writeFeatureState } from "../persistence/feature-state";
export type { FeatureCheckState, FeatureCheckStatus, FeatureStateFile, FeatureStateRecord } from "../persistence/feature-state";
export { loadFeatureState } from "../persistence/feature-state";
import { assertNotV1NeedsReplan, nextActionsForStatus, type NextAction } from "./service";
import { CharterToolError } from "./errors";

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
  narrativePath?: string;
  runDirRelative?: string;
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

export interface RecordEvidenceFromFileResult extends RecordEvidenceBatchResult {
  evidenceFile: string;
  kind: EvidenceFile["kind"];
  featureId: string;
}

export interface RecordEvidenceFromFileInput {
  charterId: string;
  evidenceFile: string;
  now?: string;
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
  const dir = charterDir(projectDir, input.charterId);
  return await withCharterLock(dir, () => recordEvidenceLocked(projectDir, input));
}

export async function recordEvidenceFromFile(
  projectDir: string,
  input: RecordEvidenceFromFileInput,
): Promise<RecordEvidenceFromFileResult> {
  const dir = charterDir(projectDir, input.charterId);
  return await withCharterLock(dir, () => recordEvidenceFromFileLocked(projectDir, input));
}

async function recordEvidenceFromFileLocked(
  projectDir: string,
  input: RecordEvidenceFromFileInput,
): Promise<RecordEvidenceFromFileResult> {
  const dir = charterDir(projectDir, input.charterId);
  const loaded = await loadTypedEvidenceFile(projectDir, dir, input.evidenceFile);
  const normalizedJson = normalizeLegacyQaEvidence(input.charterId, loaded.json);
  const validation = validateEvidenceFile(normalizedJson);
  if (!validation.ok) {
    throw new CharterToolError(`Evidence file ${input.evidenceFile} does not match the typed evidence schema: ${validation.error}`, {
      code: "evidence.schema_violation",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Fix the JSON fields to match the command|review|qa|readiness evidence schema, then retry `evidenceFile`." },
      ],
    });
  }

  const detectedNarrative = await loadNarrativeCompanion(dir, loaded.absolutePath, loaded.requestedPath, validation.value);
  const evidence = detectedNarrative
    ? { ...validation.value, narrativePath: detectedNarrative.narrativePath } as EvidenceFile
    : validation.value;
  const feature = await loadEvidenceFeature(dir, evidence.featureId, input.charterId);
  const outcome = outcomeFromEvidenceFile(evidence);
  const runDirRelative = preferredRunDirRelative(dir, loaded.absolutePath, evidence.featureId);
  const result = await recordEvidenceBatchLocked(projectDir, {
    charterId: input.charterId,
    now: input.now,
    entries: feature.fulfills.map((criterionId) => ({
      criterionId,
      featureId: evidence.featureId,
      outcome,
      summary: evidence.summary,
      because: evidence.because,
      artifacts: artifactsFromEvidenceFile(evidence, input.evidenceFile),
      narrativePath: detectedNarrative?.narrativePath,
      runDirRelative,
      details: {
        evidenceFile: input.evidenceFile,
        kind: evidence.kind,
        typedEvidence: evidence,
      },
      source: sourceFromEvidenceFile(evidence),
      recordedBy: recordedByFromEvidenceFile(evidence),
    })),
  });

  if (evidence.kind === "command") {
    await projectCommandCheckResults(dir, input.charterId, evidence, result.entries[0]?.ts ?? input.now ?? new Date().toISOString());
  }

  if (detectedNarrative) {
    await writeNarrativeCompanions(dir, detectedNarrative, result.entries.map((entry) => entry.path));
  }

  return {
    ...result,
    evidenceFile: input.evidenceFile,
    kind: evidence.kind,
    featureId: evidence.featureId,
  };
}

async function recordEvidenceLocked(
  projectDir: string,
  input: RecordEvidenceInput,
): Promise<RecordEvidenceResult> {
  if (!input.summary?.trim()) {
    throw new CharterToolError("summary is required", {
      code: "evidence.missing_summary",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Pass `summary: '<short outcome description>'` (non-empty)." },
      ],
    });
  }
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  assertNotV1NeedsReplan(state);
  if (state.status !== "active" && state.status !== "review") {
    throw new CharterToolError(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`, {
      code: "evidence.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; record evidence is only legal in `active` or `review`." },
        { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan to transition from `planning` to `active` so evidence can be recorded." },
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter before recording evidence." },
      ],
    });
  }

  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) {
    const known = charter.criteria.map((c) => c.id);
    throw new CharterToolError(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`, {
      code: "evidence.unknown_criterion",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Pass a known criterionId. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
        { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying." },
      ],
    });
  }

  const source = input.source ?? "manual";
  const because = input.because?.trim() || undefined;
  if (source === "manual" && !because) {
    // Manual evidence is the lowest-trust write; without a stable rationale
    // the completion gate cannot tell drive-by approvals from real review.
    throw new CharterToolError(`Manual evidence for ${criterion.id} requires a non-empty 'because' rationale.`, {
      code: "evidence.missing_because",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Pass \`because: '<why this manual outcome is correct>'\` (criterionId='${criterion.id}'), or pass source='verifier'/'subagent' if the writer is not a human.` },
        { tool: "charter_record", action: "verify", hint: `Run the configured verifier (${criterion.verifier}) for ${criterion.id} instead of recording manual evidence.` },
      ],
    });
  }
  const recordedBy: RecordedBy = input.recordedBy ?? DEFAULT_RECORDED_BY;

  const now = input.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const featureSegment = input.featureId?.trim() || "_charter";
  const { relativePath, absolutePath } = await allocateEvidenceRecordPath(dir, featureSegment, stamp);

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
  const dir = charterDir(projectDir, input.charterId);
  return await withCharterLock(dir, () => recordEvidenceBatchLocked(projectDir, input));
}

async function recordEvidenceBatchLocked(
  projectDir: string,
  input: RecordEvidenceBatchInput,
): Promise<RecordEvidenceBatchResult> {
  if (!input.entries || input.entries.length === 0) {
    throw new CharterToolError("recordEvidenceBatch requires at least one entry.", {
      code: "evidence.empty_batch",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Pass `entries: [{criterionId, outcome, summary, because?}, ...]` with at least one entry." },
      ],
    });
  }
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  assertNotV1NeedsReplan(state);
  if (state.status !== "active" && state.status !== "review") {
    throw new CharterToolError(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`, {
      code: "evidence.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; record evidence is only legal in `active` or `review`." },
        { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan to transition from `planning` to `active` so evidence can be recorded." },
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter before recording evidence." },
      ],
    });
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
  const reservedRunDirs = new Set<string>();

  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    if (!entry.summary?.trim()) {
      throw new CharterToolError(`recordEvidenceBatch entry ${index} (${entry.criterionId ?? "<unknown>"}): summary is required.`, {
        code: "evidence.missing_summary",
        nextActions: [
          { tool: "charter_record", action: "evidence", hint: `Pass entries[${index}].summary as a non-empty string.` },
        ],
      });
    }
    if (!entry.criterionId?.trim()) {
      throw new CharterToolError(`recordEvidenceBatch entry ${index}: criterionId is required.`, {
        code: "evidence.missing_criterionId",
        nextActions: [
          { tool: "charter_record", action: "evidence", hint: `Pass entries[${index}].criterionId as a declared VAL-* id.` },
          { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying." },
        ],
      });
    }
    if (!entry.outcome) {
      throw new CharterToolError(`recordEvidenceBatch entry ${index} (${entry.criterionId}): outcome is required.`, {
        code: "evidence.missing_outcome",
        nextActions: [
          { tool: "charter_record", action: "evidence", hint: `Pass entries[${index}].outcome as 'pass' | 'fail' | 'partial'.` },
        ],
      });
    }
    const criterion = criteriaById.get(entry.criterionId);
    if (!criterion) {
      const known = charter.criteria.map((c) => c.id);
      throw new CharterToolError(`recordEvidenceBatch entry ${index}: unknown criterion ${entry.criterionId} in charter ${input.charterId}.`, {
        code: "evidence.unknown_criterion",
        nextActions: [
          { tool: "charter_record", action: "evidence", hint: `entries[${index}].criterionId must be a declared VAL-* id. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
          { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying." },
        ],
      });
    }
    const source: BatchEvidenceSource = entry.source ?? "manual";
    const because = entry.because?.trim() || undefined;
    if (source === "manual" && !because) {
      throw new CharterToolError(`recordEvidenceBatch entry ${index} (${criterion.id}): manual evidence requires a non-empty 'because' rationale.`, {
        code: "evidence.missing_because",
        nextActions: [
          { tool: "charter_record", action: "evidence", hint: `Pass entries[${index}].because as a non-empty rationale (criterionId='${criterion.id}'), or set entries[${index}].source to 'verifier' or 'subagent' if the writer is not a human.` },
        ],
      });
    }
    const recordedBy: RecordedBy = entry.recordedBy ?? DEFAULT_RECORDED_BY;
    const featureSegment = entry.featureId?.trim() || "_charter";
    const { relativePath, absolutePath } = entry.runDirRelative
      ? await allocatePreferredEvidenceRecordPath(dir, entry.runDirRelative, featureSegment, stamp, reservedRunDirs)
      : await allocateEvidenceRecordPath(dir, featureSegment, stamp, reservedRunDirs);
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
      ...(entry.narrativePath ? { narrativePath: entry.narrativePath } : {}),
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

async function loadTypedEvidenceFile(projectDir: string, dir: string, evidenceFile: string): Promise<{ json: unknown; absolutePath: string; requestedPath: string }> {
  const requestedPath = evidenceFilePath(projectDir, dir, evidenceFile);
  const path = extname(requestedPath) === ".md"
    ? join(dirname(requestedPath), `${basename(requestedPath, ".md")}.json`)
    : requestedPath;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new CharterToolError(`Unable to read evidenceFile ${evidenceFile}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "evidence.file_read_error",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Pass an existing JSON evidence file path (received '${evidenceFile}').` },
      ],
    });
  }
  try {
    return { json: JSON.parse(raw), absolutePath: path, requestedPath };
  } catch (error) {
    throw new CharterToolError(`Unable to parse evidenceFile ${evidenceFile} as JSON: ${error instanceof Error ? error.message : String(error)}`, {
      code: "evidence.file_read_error",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Fix JSON syntax in '${evidenceFile}', then retry.` },
      ],
    });
  }
}

function evidenceFilePath(projectDir: string, dir: string, evidenceFile: string): string {
  if (isAbsolute(evidenceFile)) return evidenceFile;
  if (evidenceFile.startsWith("evidence/")) return join(dir, evidenceFile);
  return join(projectDir, evidenceFile);
}

async function allocateEvidenceRecordPath(
  dir: string,
  featureSegment: string,
  stamp: string,
  reservedRunDirs = new Set<string>(),
): Promise<{ relativePath: string; absolutePath: string }> {
  const baseRelative = join("work", featureSegment, "evidence");
  let suffix = 0;
  while (true) {
    const runDir = suffix === 0 ? stamp : `${stamp}-${suffix}`;
    const runRelative = join(baseRelative, runDir);
    const absoluteRunDir = join(dir, runRelative);
    const reservationKey = join(featureSegment, runDir);
    if (!reservedRunDirs.has(reservationKey) && !(await pathExists(absoluteRunDir))) {
      reservedRunDirs.add(reservationKey);
      const relativePath = join(runRelative, "evidence.json");
      return { relativePath, absolutePath: join(dir, relativePath) };
    }
    suffix += 1;
  }
}

async function allocatePreferredEvidenceRecordPath(
  dir: string,
  runDirRelative: string,
  featureSegment: string,
  stamp: string,
  reservedRunDirs: Set<string>,
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = join(runDirRelative, "evidence.json");
  const absolutePath = join(dir, relativePath);
  if (!reservedRunDirs.has(runDirRelative) && !(await pathExists(absolutePath))) {
    reservedRunDirs.add(runDirRelative);
    return { relativePath, absolutePath };
  }
  return allocateEvidenceRecordPath(dir, featureSegment, stamp, reservedRunDirs);
}

interface NarrativeCompanion {
  narrativePath: string;
  absolutePath: string;
}

async function loadNarrativeCompanion(
  dir: string,
  evidenceAbsolutePath: string,
  requestedPath: string,
  evidence: EvidenceFile,
): Promise<NarrativeCompanion | undefined> {
  const runDir = dirname(evidenceAbsolutePath);
  const requestedIsMarkdown = extname(requestedPath) === ".md";
  const narrativePath = evidence.narrativePath
    ?? (requestedIsMarkdown ? basename(requestedPath) : await siblingNarrativePath(runDir, evidence.kind));
  if (!narrativePath) return undefined;
  const absolutePath = validateNarrativeCompanionPath(dir, runDir, evidence.kind, narrativePath);
  if (!(await pathExists(absolutePath))) {
    throw new CharterToolError(`Evidence narrativePath ${narrativePath} does not exist in the evidence run directory.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Write the referenced markdown narrative next to the typed evidence JSON, or remove narrativePath." },
      ],
    });
  }
  return { narrativePath, absolutePath };
}

async function siblingNarrativePath(runDir: string, kind: EvidenceFile["kind"]): Promise<string | undefined> {
  const narrativePath = `${kind}.md`;
  return await pathExists(join(runDir, narrativePath)) ? narrativePath : undefined;
}

function validateNarrativeCompanionPath(dir: string, runDir: string, kind: EvidenceFile["kind"], narrativePath: string): string {
  if (isAbsolute(narrativePath) || extname(narrativePath) !== ".md") {
    throw new CharterToolError(`Invalid ${kind} narrativePath ${narrativePath}: path must be relative and end in .md.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Use a relative markdown path such as 'qa.md' or 'review.md'." },
      ],
    });
  }
  const absolutePath = resolve(runDir, narrativePath);
  const relativeToRun = relative(runDir, absolutePath);
  if (relativeToRun.startsWith("..") || isAbsolute(relativeToRun)) {
    throw new CharterToolError(`Invalid ${kind} narrativePath ${narrativePath}: path must stay inside the evidence run directory.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Move the markdown companion into the same evidence run directory as the typed evidence JSON." },
      ],
    });
  }
  const relativeToCharter = relative(dir, absolutePath);
  if (relativeToCharter.startsWith("..") || isAbsolute(relativeToCharter)) {
    throw new CharterToolError(`Invalid ${kind} narrativePath ${narrativePath}: path must stay inside the charter directory.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Use markdown companions under the charter work/<feature>/evidence run directory." },
      ],
    });
  }
  return absolutePath;
}

function preferredRunDirRelative(dir: string, evidenceAbsolutePath: string, featureId: string): string | undefined {
  const runDir = dirname(evidenceAbsolutePath);
  const runDirRelative = relative(dir, runDir);
  if (runDirRelative.startsWith("..") || isAbsolute(runDirRelative)) return undefined;
  const parts = runDirRelative.split(/[\\/]+/);
  if (parts.length !== 4 || parts[0] !== "work" || parts[1] !== featureId || parts[2] !== "evidence") return undefined;
  return runDirRelative;
}

async function writeNarrativeCompanions(dir: string, narrative: NarrativeCompanion, evidencePaths: string[]): Promise<void> {
  const body = await readFile(narrative.absolutePath, "utf8");
  for (const evidencePath of evidencePaths) {
    const targetPath = join(dirname(join(dir, evidencePath)), narrative.narrativePath);
    if (resolve(targetPath) === resolve(narrative.absolutePath)) continue;
    await writeTextAtomic(targetPath, body);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeLegacyQaEvidence(charterId: string, json: unknown): unknown {
  if (!isLegacyQaEvidence(json)) return json;
  const featureId = typeof json.featureId === "string" ? json.featureId : "<missing>";
  const warningKey = `${charterId}:${featureId}`;
  if (!warnedLegacyQaScreenshots.has(warningKey)) {
    warnedLegacyQaScreenshots.add(warningKey);
    logger.warn("qa evidence uses deprecated screenshots[] field; migrate to artifacts:[{kind, path, caption?}]", {
      charterId,
      component: "record-service",
      featureId,
    });
  }
  const normalized: Record<string, unknown> = {
    ...json,
    artifacts: Array.isArray(json.artifacts)
      ? json.artifacts
      : json.screenshots.map((path) => ({ kind: "screenshot", path })),
  };
  delete normalized.screenshots;
  return normalized;
}

function isLegacyQaEvidence(json: unknown): json is Record<string, unknown> & { kind: "qa"; screenshots: string[] } {
  return !!json
    && typeof json === "object"
    && !Array.isArray(json)
    && (json as { kind?: unknown }).kind === "qa"
    && Array.isArray((json as { screenshots?: unknown }).screenshots)
    && (json as { screenshots: unknown[] }).screenshots.every((path) => typeof path === "string");
}

async function loadEvidenceFeature(dir: string, featureId: string, charterId: string): Promise<{ fulfills: string[] }> {
  let feature;
  try {
    feature = parseFeatureMarkdown(await readFile(join(dir, "plan", `${featureId}.md`), "utf8"));
  } catch (error) {
    throw new CharterToolError(`Evidence file references unknown featureId ${featureId}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "evidence.unknown_feature",
      nextActions: [
        { tool: "charter_plan", action: "view", hint: "List known feature ids, then fix evidenceFile.featureId." },
      ],
    });
  }
  if (feature.fulfills.length === 0) {
    throw new CharterToolError(`Feature ${featureId} does not fulfill any criteria in charter ${charterId}.`, {
      code: "evidence.no_feature_criteria",
      nextActions: [
        { tool: "charter_plan", action: "update_feature", hint: `Add at least one fulfilled VAL-* criterion to feature '${featureId}'.` },
      ],
    });
  }
  return { fulfills: feature.fulfills };
}

function outcomeFromEvidenceFile(evidence: EvidenceFile): EvidenceOutcome {
  switch (evidence.kind) {
    case "command":
      return Object.values(evidence.checkResults).every((result) => result.outcome === "pass") ? "pass" : "fail";
    case "readiness": {
      const readiness = evidence as ReadinessEvidence & { outcome?: EvidenceOutcome };
      if (readiness.outcome) return readiness.outcome;
      if (readiness.probeResult === "verified") return "pass";
      if (readiness.probeResult === "blocking") return "fail";
      return "partial";
    }
    case "review":
    case "qa":
      return evidence.outcome as EvidenceOutcome;
    default:
      return assertNever(evidence);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled evidence kind: ${String((value as { kind?: unknown }).kind)}`);
}

function sourceFromEvidenceFile(evidence: EvidenceFile): NonNullable<EvidenceEntry["source"]> {
  return evidence.kind === "command" ? "verifier" : "subagent";
}

function artifactsFromEvidenceFile(evidence: EvidenceFile, evidenceFile: string): string[] {
  if (evidence.kind === "qa") return evidence.artifacts.map((artifact) => artifact.path);
  return [evidenceFile];
}

function recordedByFromEvidenceFile(evidence: EvidenceFile): RecordedBy {
  if (evidence.kind === "review") {
    return `subagent:${DEFAULT_HANDOFF_PERSONA}:${evidence.subagentSessionId}` as RecordedBy;
  }
  return DEFAULT_RECORDED_BY;
}

async function projectCommandCheckResults(dir: string, charterId: string, evidence: CommandEvidence, now: string): Promise<void> {
  const state = await loadFeatureState(dir, charterId);
  const feature = state.features[evidence.featureId] ?? { checks: {} };
  const checks = { ...feature.checks };
  for (const [checkId, result] of Object.entries(evidence.checkResults)) {
    checks[checkId] = {
      status: result.outcome === "pass" ? "passing" : "failing",
      lastEvidenceTs: now,
      ...(result.outcome === "fail" ? { lastError: result.stderrHead || result.stdoutHead || `exitCode=${result.exitCode}` } : {}),
    };
  }
  state.features[evidence.featureId] = {
    ...feature,
    checks,
  };
  await writeFeatureState(dir, state);
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
  assertNotV1NeedsReplan(state);
  if (state.status !== "active" && state.status !== "review") {
    throw new CharterToolError(`Cannot verify in status ${state.status}; charter must be active or in review.`, {
      code: "verify.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; verify is only legal in `active` or `review`." },
        { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan to transition from `planning` to `active` so the verifier can run." },
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter before running the verifier." },
      ],
    });
  }
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) {
    const known = charter.criteria.map((c) => c.id);
    throw new CharterToolError(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`, {
      code: "verify.unknown_criterion",
      nextActions: [
        { tool: "charter_record", action: "verify", hint: `Pass a known criterionId. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
        { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying." },
      ],
    });
  }
  if (criterion.verifier !== "command") {
    throw new CharterToolError(`charter_record verify for verifier=${criterion.verifier} is not implemented yet; only command verifier is supported.`, {
      code: "verify.non_command_verifier",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Record evidence manually for ${criterion.id}; only the 'command' verifier auto-runs.` },
        { tool: "charter_plan", action: "view", hint: "Inspect the criterion to confirm its declared verifier kind." },
      ],
    });
  }
  if (!criterion.command?.trim()) {
    throw new CharterToolError(`Criterion ${criterion.id} has verifier=command but no Command: field set in charter.md.`, {
      code: "verify.missing_command",
      nextActions: [
        { tool: "charter_plan", action: "view", hint: `Edit charter.md to add a 'Command:' line under ${criterion.id} (e.g. 'Command: bun test tests/foo.test.ts').` },
        { tool: "charter_record", action: "evidence", hint: `Record manual evidence for ${criterion.id} until the Command: line is set.` },
      ],
    });
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

export async function applyHandoff(projectDir: string, input: ApplyHandoffInput): Promise<ApplyHandoffResult> {
  const dir = charterDir(projectDir, input.charterId);
  return await withCharterLock(dir, () => applyHandoffLocked(projectDir, input));
}

async function applyHandoffLocked(projectDir: string, input: ApplyHandoffInput): Promise<ApplyHandoffResult> {
  // VAL-HANDOFF-SCHEMA: featureId/subagentSessionId/handoffNote/completedCriteria
  // are validated at the registration boundary (charter_record action=handoff_apply)
  // which throws CharterToolError with structured nextActions[]. The duplicate
  // guard that used to live here has been removed so the registration layer is
  // the single source of truth for these four field validations.
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  assertNotV1NeedsReplan(state);
  if (state.status !== "active" && state.status !== "review") {
    throw new CharterToolError(`Cannot apply handoff in status ${state.status}; charter must be active or in review.`, {
      code: "handoff_apply.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; handoff_apply is only legal in `active` or `review`." },
        { tool: "charter_plan", action: "lock_plan", hint: "Lock the plan to transition from `planning` to `active` so handoffs can be applied." },
        { tool: "charter_manage", action: "resume", hint: "Resume the paused charter before applying a handoff." },
      ],
    });
  }
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criteriaById = new Map(charter.criteria.map((criterion) => [criterion.id, criterion]));
  for (const completed of input.completedCriteria) {
    if (!criteriaById.has(completed.criterionId)) {
      const known = charter.criteria.map((c) => c.id);
      throw new CharterToolError(`Unknown criterion ${completed.criterionId} in handoff.`, {
        code: "handoff_apply.unknown_criterion",
        nextActions: [
          { tool: "charter_record", action: "handoff_apply", hint: `completedCriteria[].criterionId must be a declared VAL-* id. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
          { tool: "charter_plan", action: "view", hint: "List declared VAL-* criteria before retrying the handoff." },
        ],
      });
    }
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

  const prepared: Array<{
    completed: HandoffCompletedCriterion;
    criterion: CharterCriterion;
    relativePath: string;
    absolutePath: string;
    record: Record<string, unknown>;
    payload: string;
    recordedBy: RecordedBy;
  }> = [];
  const reservedRunDirs = new Set<string>();
  for (const completed of input.completedCriteria) {
    const criterion = criteriaById.get(completed.criterionId)!;
    const recordedBy = `subagent:${DEFAULT_HANDOFF_PERSONA}:${input.subagentSessionId}` as RecordedBy;
    const { relativePath, absolutePath } = await allocateEvidenceRecordPath(dir, input.featureId, stamp, reservedRunDirs);
    const record: Record<string, unknown> = {
      charterId: input.charterId,
      criterionId: criterion.id,
      featureId: input.featureId,
      outcome: completed.outcome,
      summary: completed.summary.trim(),
      artifacts: completed.artifacts ?? [],
      details: { ...(completed.details ?? {}), subagentSessionId: input.subagentSessionId, handoffPath: handoffRelative },
      source: "subagent",
      recordedBy,
      verifier: criterion.verifier,
      ts: now,
    };
    prepared.push({
      completed,
      criterion,
      relativePath,
      absolutePath,
      record,
      payload: `${JSON.stringify(record, null, 2)}\n`,
      recordedBy,
    });
  }

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

  const criterionState = await loadCriterionState(dir, input.charterId);
  for (const item of prepared) {
    criterionState.criteria[item.criterion.id] = {
      outcome: item.completed.outcome,
      lastEvidencePath: item.relativePath,
      lastTs: now,
      lastSummary: String(item.record.summary),
      lastFeatureId: input.featureId,
      source: "subagent",
      recordedBy: item.recordedBy,
    };
  }
  await writeJsonAtomic(join(dir, "criterion-state.json"), criterionState);

  for (const item of prepared) {
    await appendEvent(dir, {
      type: "evidence_recorded",
      ts: now,
      charterId: input.charterId,
      criterionId: item.criterion.id,
      featureId: input.featureId,
      outcome: item.completed.outcome,
      source: "subagent",
    });
  }

  const featureState = await loadFeatureState(dir, input.charterId);
  const existing = featureState.features[input.featureId] ?? { checks: {} };
  const completed = await handoffCompletesFeature(dir, input.featureId, input.charterId);
  // A handoff from the charter-reviewer persona is a review, not an
  // implementation. Preserve any existing implementer session id (VAL-13);
  // when none is recorded, leave lastWorkerSessionId unset so the
  // identity-disjoint predicate skips this feature cleanly instead of
  // treating the reviewer as the implementer.
  const isReviewHandoff = input.subagentSessionId.startsWith(`${DEFAULT_HANDOFF_PERSONA}-`)
    || input.subagentSessionId === DEFAULT_HANDOFF_PERSONA
    || input.subagentSessionId.includes("charter-reviewer");
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
  await writeFeatureState(dir, featureState);

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
  const existing = featureState.features[featureId] ?? { checks: {} };
  if (existing.status === "completed") return;
  featureState.features[featureId] = {
    ...existing,
    status: "completed",
    startedAt: existing.startedAt ?? now,
    completedAt: existing.completedAt ?? now,
  };
  await writeFeatureState(dir, featureState);
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
  // Planner-authored review/QA/readiness features are first-class and must
  // complete before the milestone-ready review signal fires.
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
