import { spawn } from "node:child_process";
import { access, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { validateEvidenceFile, type EvidenceFile } from "../domain/evidence-schemas";
import type { CharterCriterion, ParsedCharterMarkdown, RecordedBy, SubagentVerifier } from "../domain/types";
import { logger } from "../infrastructure/logger";

/** Default identity for evidence written by the root agent. Callers (handoff,
 * delegated tooling) override this when they have a more specific identity. */
const DEFAULT_RECORDED_BY: RecordedBy = "agent:root";

function subagentRecordedBy(agent: string, sessionId: string): RecordedBy {
  const trimmedAgent = agent.trim() || "subagent";
  const trimmedSession = sessionId.trim();
  return `subagent:${trimmedAgent}:${trimmedSession}` as RecordedBy;
}

function handoffIsReviewRole(role: "review" | "implement" | undefined): boolean {
  return role !== "implement";
}
import {
  appendEvent,
  charterDir,
  loadCharterState,
  loadParsedCharter,
  withCharterLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "../infrastructure/store";
import { assertNotV1NeedsReplan, loadFeatureEvidence, nextActionsForStatus, type NextAction } from "./service";
import { CharterToolError } from "./errors";
import { PI_CHARTER_METADATA_KEYS, type SpawnRawInput } from "../infrastructure/subagent-bridge";
import { getSubagentApi } from "./subagent-api";
import {
  detectSubagentForbiddenWrites,
  snapshotSubagentWriteAudit,
  SUBAGENT_WRITE_RESTRICTION_MESSAGE,
} from "./subagent-write-audit";


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
  criterionId: string;
  featureId?: string;
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
  lastToolWriteAt?: string;
}

async function writeCriterionState(dir: string, stateFile: CriterionStateFile, toolWriteAt?: string): Promise<void> {
  stateFile.lastToolWriteAt = toolWriteAt ?? new Date().toISOString();
  await writeJsonAtomic(join(dir, "criterion-state.json"), stateFile);
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
  const validation = validateEvidenceFile(loaded.json);
  if (!validation.ok) {
    throw new CharterToolError(`Evidence file ${input.evidenceFile} does not match the flat evidence schema: ${validation.error}`, {
      code: "evidence.schema_violation",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Fix the JSON fields to match the flat evidence row shape (criterionId, outcome, summary, ts, ...), then retry `evidenceFile`." },
      ],
    });
  }
  const detectedNarrative = await loadNarrativeCompanion(dir, loaded.absolutePath, loaded.requestedPath, validation.value);
  const evidence = detectedNarrative
    ? { ...validation.value, narrativePath: detectedNarrative.narrativePath } as EvidenceFile
    : validation.value;
  const outcome = evidence.outcome;
  const criterionId = evidence.criterionId;
  const featureId = evidence.featureId ?? evidence.criterionId;
  const runDirRelative = preferredRunDirRelative(dir, loaded.absolutePath, featureId);
  const result = await recordEvidenceBatchLocked(projectDir, {
    charterId: input.charterId,
    now: input.now,
    entries: [{
      criterionId,
      featureId,
      outcome,
      summary: evidence.summary,
      because: evidence.because,
      artifacts: artifactsFromEvidenceFile(evidence, input.evidenceFile),
      narrativePath: detectedNarrative?.narrativePath,
      runDirRelative,
      details: {
        evidenceFile: input.evidenceFile,
        importedEvidence: evidence,
      },
      source: sourceFromEvidenceFile(evidence),
      recordedBy: recordedByFromEvidenceFile(evidence),
    }],
  });


  if (detectedNarrative) {
    await writeNarrativeCompanions(dir, detectedNarrative, result.entries.map((entry) => entry.path));
  }

  return {
    ...result,
    evidenceFile: input.evidenceFile,
    criterionId,
    featureId,
  };
}

async function verifyEvidenceExistsCriterion(
  projectDir: string,
  dir: string,
  criterion: CharterCriterion,
  input: VerifyCriterionInput,
): Promise<VerifyCriterionResult> {
  const started = Date.now();
  const verifier = criterion.verifierSpec;
  if (!verifier || verifier.kind !== "evidence-exists") {
    throw new CharterToolError(`Criterion ${criterion.id} has verifier=evidence-exists but no evidence-exists verifier spec.`, {
      code: "verify.missing_evidence_exists_spec",
      nextActions: [
        { tool: "charter_status", hint: `Inspect ${criterion.id}; evidence-exists verifiers require a Kind: review|qa|readiness|command field.` },
      ],
    });
  }
  const featureId = input.featureId?.trim();
  if (!featureId) {
    throw new CharterToolError(`Criterion ${criterion.id} uses verifier=evidence-exists, which requires featureId to scan feature evidence.`, {
      code: "verify.missing_featureId",
      nextActions: [
        { tool: "charter_record", action: "verify", hint: `Pass featureId for the feature whose evidence should satisfy ${criterion.id}.` },
        { tool: "charter_status", hint: "List features and their fulfilled criteria before retrying." },
      ],
    });
  }

  const freshSinceMs = verifier.freshSince ? Date.parse(verifier.freshSince) : undefined;
  const records = await loadFeatureEvidence(dir, featureId);
  const scanned = records.map((record) => ({
    path: record.path,
    ts: record.ts,
    kind: evidenceKindFromRecord(record.record),
  }));
  const matching = scanned.filter((record) => {
    if (record.kind !== verifier.evidenceKind) return false;
    if (freshSinceMs === undefined) return true;
    const tsMs = Date.parse(record.ts);
    return !Number.isNaN(tsMs) && tsMs >= freshSinceMs;
  });
  const outcome: EvidenceOutcome = matching.length > 0 ? "pass" : "fail";
  const durationMs = Date.now() - started;
  const command = `evidence-exists:${verifier.evidenceKind}`;
  const stdout = matching.map((record) => `${record.ts} ${record.path}`).join("\n");
  const stderr = outcome === "pass"
    ? ""
    : `No ${verifier.evidenceKind} evidence found for feature ${featureId}${verifier.freshSince ? ` since ${verifier.freshSince}` : ""}.`;
  const summary = outcome === "pass"
    ? `evidence-exists verifier found ${matching.length} ${verifier.evidenceKind} evidence record(s)`
    : `evidence-exists verifier found no ${verifier.evidenceKind} evidence records`;
  const evidence = await recordEvidence(projectDir, {
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId,
    outcome,
    summary,
    source: "verifier",
    recordedBy: DEFAULT_RECORDED_BY,
    details: {
      verifier: "evidence-exists",
      evidenceKind: verifier.evidenceKind,
      freshSince: verifier.freshSince,
      scannedRecords: scanned,
      matchingRecords: matching,
    },
    now: input.now,
  });
  return {
    ...evidence,
    exitCode: outcome === "pass" ? 0 : 1,
    stdout,
    stderr,
    command,
    durationMs,
  };
}

type LegacyEvidenceKind = "command" | "review" | "qa" | "readiness";

function evidenceKindFromRecord(record: Record<string, unknown>): LegacyEvidenceKind | undefined {
  if (isLegacyEvidenceKind(record.kind)) return record.kind;
  const source = record.source;
  if (source === "verifier") return "command";
  if (source === "subagent") {
    const details = record.details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const evidenceKind = (details as Record<string, unknown>).evidenceKind;
      if (isLegacyEvidenceKind(evidenceKind)) return evidenceKind;
    }
    return "review";
  }
  const details = record.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const detailRecord = details as Record<string, unknown>;
    if (isLegacyEvidenceKind(detailRecord.kind)) return detailRecord.kind;
    const typedEvidence = detailRecord.typedEvidence;
    if (typedEvidence && typeof typedEvidence === "object" && !Array.isArray(typedEvidence)) {
      const kind = (typedEvidence as Record<string, unknown>).kind;
      if (isLegacyEvidenceKind(kind)) return kind;
    }
  }
  return undefined;
}

function isLegacyEvidenceKind(kind: unknown): kind is LegacyEvidenceKind {
  return kind === "review" || kind === "qa" || kind === "readiness" || kind === "command";
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
  if (state.status !== "active") {
    throw new CharterToolError(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`, {
      code: "evidence.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; record evidence is only legal in `active` or `review`." },
        { tool: "charter_status", hint: "Lock the plan to transition from `planning` to `active` so evidence can be recorded." },
        { tool: "charter", action: "resume", hint: "Resume the paused charter before recording evidence." },
      ],
    });
  }

  const charter = await loadParsedCharter(dir);
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) {
    const known = charter.criteria.map((c) => c.id);
    throw new CharterToolError(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`, {
      code: "evidence.unknown_criterion",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Pass a known criterionId. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
        { tool: "charter_status", hint: "List declared VAL-* criteria before retrying." },
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
  await writeCriterionState(dir, stateFile, now);

  await appendEvent(dir, {
    type: "evidence_recorded",
    ts: now,
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId,
    outcome: input.outcome,
    source: record.source,
  });


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
  if (state.status !== "active") {
    throw new CharterToolError(`Cannot record evidence in status ${state.status}; charter must be active or in review (not planning).`, {
      code: "evidence.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; record evidence is only legal in `active` or `review`." },
        { tool: "charter_status", hint: "Lock the plan to transition from `planning` to `active` so evidence can be recorded." },
        { tool: "charter", action: "resume", hint: "Resume the paused charter before recording evidence." },
      ],
    });
  }

  const charter = await loadParsedCharter(dir);
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
          { tool: "charter_status", hint: "List declared VAL-* criteria before retrying." },
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
          { tool: "charter_status", hint: "List declared VAL-* criteria before retrying." },
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
  await writeCriterionState(dir, stateFile, now);

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
    ?? (requestedIsMarkdown ? basename(requestedPath) : await siblingNarrativePath(runDir));
  if (!narrativePath) return undefined;
  const absolutePath = validateNarrativeCompanionPath(dir, runDir, narrativePath);
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

async function siblingNarrativePath(runDir: string): Promise<string | undefined> {
  for (const name of ["narrative.md", "review.md", "qa.md"]) {
    if (await pathExists(join(runDir, name))) return name;
  }
  return undefined;
}

function validateNarrativeCompanionPath(dir: string, runDir: string, narrativePath: string): string {
  if (isAbsolute(narrativePath) || extname(narrativePath) !== ".md") {
    throw new CharterToolError(`Invalid narrativePath ${narrativePath}: path must be relative and end in .md.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Use a relative markdown path such as 'qa.md' or 'review.md'." },
      ],
    });
  }
  const absolutePath = resolve(runDir, narrativePath);
  const relativeToRun = relative(runDir, absolutePath);
  if (relativeToRun.startsWith("..") || isAbsolute(relativeToRun)) {
    throw new CharterToolError(`Invalid narrativePath ${narrativePath}: path must stay inside the evidence run directory.`, {
      code: "evidence.narrative_path_invalid",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Move the markdown companion into the same evidence run directory as the typed evidence JSON." },
      ],
    });
  }
  const relativeToCharter = relative(dir, absolutePath);
  if (relativeToCharter.startsWith("..") || isAbsolute(relativeToCharter)) {
    throw new CharterToolError(`Invalid narrativePath ${narrativePath}: path must stay inside the charter directory.`, {
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

function outcomeFromEvidenceFile(evidence: EvidenceFile): EvidenceOutcome {
  return evidence.outcome;
}

function sourceFromEvidenceFile(evidence: EvidenceFile): NonNullable<EvidenceEntry["source"]> {
  return evidence.source ?? "manual";
}

function artifactsFromEvidenceFile(evidence: EvidenceFile, evidenceFile: string): string[] {
  if (evidence.artifacts?.length) return evidence.artifacts;
  return [evidenceFile];
}

function recordedByFromEvidenceFile(evidence: EvidenceFile): RecordedBy {
  if (evidence.recordedBy?.trim()) return evidence.recordedBy as RecordedBy;
  return DEFAULT_RECORDED_BY;
}

export async function loadCriterionState(dir: string, charterId: string): Promise<CriterionStateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8")) as Partial<CriterionStateFile>;
    return {
      charterId: parsed.charterId ?? charterId,
      criteria: parsed.criteria && typeof parsed.criteria === "object" ? (parsed.criteria as Record<string, CriterionStateRecord>) : {},
      lastToolWriteAt: typeof parsed.lastToolWriteAt === "string" ? parsed.lastToolWriteAt : undefined,
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
  signal?: AbortSignal;
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
  if (state.status !== "active") {
    throw new CharterToolError(`Cannot verify in status ${state.status}; charter must be active or in review.`, {
      code: "verify.bad_status",
      nextActions: [
        { tool: "charter_status", hint: "Inspect current status; verify is only legal in `active` or `review`." },
        { tool: "charter_status", hint: "Lock the plan to transition from `planning` to `active` so the verifier can run." },
        { tool: "charter", action: "resume", hint: "Resume the paused charter before running the verifier." },
      ],
    });
  }
  const charter = await loadParsedCharter(dir);
  const criterion = charter.criteria.find((entry) => entry.id === input.criterionId);
  if (!criterion) {
    const known = charter.criteria.map((c) => c.id);
    throw new CharterToolError(`Unknown criterion ${input.criterionId} in charter ${input.charterId}`, {
      code: "verify.unknown_criterion",
      nextActions: [
        { tool: "charter_record", action: "verify", hint: `Pass a known criterionId. Declared: ${known.slice(0, 8).join(", ")}${known.length > 8 ? ", ..." : ""}.` },
        { tool: "charter_status", hint: "List declared VAL-* criteria before retrying." },
      ],
    });
  }
  if (criterion.verifier === "evidence-exists") {
    return await verifyEvidenceExistsCriterion(projectDir, dir, criterion, input);
  }
  if (criterion.verifier === "subagent") {
    return await verifySubagentCriterion(projectDir, dir, charter, criterion, input);
  }
  if (criterion.verifier !== "command") {
    throw new CharterToolError(`charter_record verify for verifier=${criterion.verifier} is not implemented yet; only command verifier is supported.`, {
      code: "verify.non_command_verifier",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: `Record evidence manually for ${criterion.id}; only the 'command' verifier auto-runs.` },
        { tool: "charter_status", hint: "Inspect the criterion to confirm its declared verifier kind." },
      ],
    });
  }
  if (!criterion.command?.trim()) {
    throw new CharterToolError(`Criterion ${criterion.id} has verifier=command but no Command: field set in criteria.md.`, {
      code: "verify.missing_command",
      nextActions: [
        { tool: "charter_status", hint: `Edit criteria.md to add a 'Command:' line under ${criterion.id} (e.g. 'Command: bun test tests/foo.test.ts').` },
        { tool: "charter_record", action: "evidence", hint: `Record manual evidence for ${criterion.id} until the Command: line is set.` },
      ],
    });
  }

  const started = Date.now();
  const execution = await runCommand(criterion.command, {
    cwd: input.cwd ?? projectDir,
    timeoutMs: input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    signal: input.signal,
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

async function verifySubagentCriterion(
  projectDir: string,
  dir: string,
  charter: ParsedCharterMarkdown,
  criterion: CharterCriterion,
  input: VerifyCriterionInput,
): Promise<VerifyCriterionResult> {
  const verifier = criterion.verifierSpec as SubagentVerifier | undefined;
  if (!verifier || verifier.kind !== "subagent") {
    throw new CharterToolError(`Criterion ${criterion.id} has verifier=subagent but no valid subagent verifier spec.`, {
      code: "verify.missing_subagent_spec",
      nextActions: [
        { tool: "charter_status", hint: `Inspect ${criterion.id}; subagent verifiers require Agent: and Task: fields.` },
      ],
    });
  }

  const api = getSubagentApi();
  if (!api) {
    throw new CharterToolError("Cannot run subagent verifier because pi-subagents has not exposed a runner API.", {
      code: "verify.subagent_unavailable",
      nextActions: [
        { tool: "subagent", hint: "Load/enable pi-subagents so the subagent runner emits subagent:expose-api, then retry charter_record verify." },
        { tool: "charter_record", action: "evidence", hint: `Record typed evidence for ${criterion.id} manually until the subagent runner is available.` },
      ],
    });
  }

  const dispatchStartedAt = Date.now();
  const evidenceDir = join(dir, "work", input.featureId?.trim() || "_charter", "evidence");
  const prompt = interpolateSubagentTask(verifier.task, {
    charterId: input.charterId,
    featureId: input.featureId,
    criterionId: criterion.id,
    evidenceDir,
    commands: charter.commands,
  });
  const writeAudit = await snapshotSubagentWriteAudit(dir);
  const spawnInput: SpawnRawInput = {
    systemPrompt: `You are ${verifier.agent}. Run the requested pi-charter verifier persona and write typed evidence before finishing.`,
    prompt,
    async: false,
    cwd: input.cwd ?? projectDir,
    inheritProjectContext: true,
    inheritSkills: false,
    metadata: {
      [PI_CHARTER_METADATA_KEYS.projectDir]: projectDir,
      [PI_CHARTER_METADATA_KEYS.charterId]: input.charterId,
      [PI_CHARTER_METADATA_KEYS.criterionId]: criterion.id,
      ...(input.featureId ? { [PI_CHARTER_METADATA_KEYS.featureId]: input.featureId } : {}),
    },
  };
  const resolvedModel = spawnInput.model ?? "frontmatter-default";
  const resolvedThinking = spawnInput.thinking ?? "frontmatter-default";
  logger.info("verifier dispatch", {
    component: "subagent-dispatch",
    charterId: input.charterId,
    criterionId: criterion.id,
    persona: verifier.agent,
    resolvedModel,
    resolvedThinking,
  });
  const started = Date.now();
  const response = await api.spawnRaw(spawnInput);
  const durationMs = Date.now() - started;
  logger.info("verifier dispatch completed", {
    component: "subagent-dispatch",
    charterId: input.charterId,
    criterionId: criterion.id,
    persona: verifier.agent,
    exitCode: response.isError === true ? 1 : 0,
    durationMs,
  });
  const forbiddenWrites = await detectSubagentForbiddenWrites(writeAudit);
  if (forbiddenWrites.length > 0) {
    const paths = forbiddenWrites.map((write) => write.relativePath).join(", ");
    logger.error("Subagent modified orchestrator-managed charter files", undefined, {
      component: "subagent-write-audit",
      charterId: input.charterId,
      criterionId: criterion.id,
      featureId: input.featureId,
      paths: forbiddenWrites.map((write) => write.relativePath),
    });
    throw new CharterToolError(`${SUBAGENT_WRITE_RESTRICTION_MESSAGE} Changed paths: ${paths}`, {
      code: "verify.subagent_forbidden_write",
      nextActions: [
        { tool: "charter_record", action: "evidence", hint: "Have the subagent report results through a handoff instead of editing plan or charter state files." },
        { tool: "charter_record", action: "evidence", hint: "Have the subagent write flat evidence under work/<segment>/evidence/<ts>/evidence.json and import it with charter_record action=evidence." },
        { tool: "charter_status", hint: "Inspect charter status after resolving the rejected subagent write." },
      ],
    });
  }
  const responseText = response.content.map((part) => part.text).join("\n");
  const freshEvidence = await newestFlatEvidenceAfterDispatch(dir, projectDir, {
    featureId: input.featureId,
    criterionId: criterion.id,
    dispatchStartedAt,
  });

  if (!freshEvidence) {
    const summary = `subagent verifier ${verifier.agent} produced no fresh flat evidence`;
    const evidence = await recordEvidence(projectDir, {
      charterId: input.charterId,
      criterionId: criterion.id,
      featureId: input.featureId,
      outcome: "fail",
      summary,
      source: "verifier",
      recordedBy: DEFAULT_RECORDED_BY,
      details: {
        agent: verifier.agent,
        dispatchStartedAt: new Date(dispatchStartedAt).toISOString(),
        durationMs,
        responseText,
        isError: response.isError === true,
      },
      now: input.now,
    });
    return {
      ...evidence,
      exitCode: 1,
      stdout: response.isError ? "" : responseText,
      stderr: response.isError ? responseText : "",
      command: `subagent:${verifier.agent}`,
      durationMs,
    };
  }

  const evidenceOutcome = freshEvidence.evidence.outcome;
  const outcome: EvidenceOutcome = evidenceOutcome === "pass" ? "pass" : "fail";
  const evidence = await recordEvidence(projectDir, {
    charterId: input.charterId,
    criterionId: criterion.id,
    featureId: input.featureId ?? freshEvidence.evidence.featureId,
    outcome,
    summary: freshEvidence.evidence.summary,
    artifacts: artifactsFromEvidenceFile(freshEvidence.evidence, freshEvidence.relativePath),
    source: sourceFromEvidenceFile(freshEvidence.evidence),
    recordedBy: recordedByFromEvidenceFile(freshEvidence.evidence),
    because: freshEvidence.evidence.because,
    details: {
      evidenceFile: freshEvidence.relativePath,
      importedEvidence: freshEvidence.evidence,
      agent: verifier.agent,
      dispatchStartedAt: new Date(dispatchStartedAt).toISOString(),
      durationMs,
      responseText,
      isError: response.isError === true,
    },
    now: input.now,
  });
  return {
    ...evidence,
    exitCode: outcome === "pass" ? 0 : 1,
    stdout: response.isError ? "" : responseText,
    stderr: response.isError ? responseText : "",
    command: `subagent:${verifier.agent}`,
    durationMs,
  };
}

function interpolateSubagentTask(
  template: string,
  input: { charterId: string; featureId?: string; criterionId: string; evidenceDir: string; commands: Record<string, string> },
): string {
  return template
    .replaceAll("{charterId}", input.charterId)
    .replaceAll("{featureId}", input.featureId ?? "")
    .replaceAll("{criterionId}", input.criterionId)
    .replaceAll("{evidenceDir}", input.evidenceDir)
    .replace(/\{commands\.([^}]+)\}/g, (_match, key: string) => input.commands[key] ?? "");
}

interface FlatEvidenceCandidate {
  evidence: EvidenceFile;
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  evidenceTimeMs: number;
}

async function newestFlatEvidenceAfterDispatch(
  dir: string,
  projectDir: string,
  options: { featureId?: string; criterionId: string; dispatchStartedAt: number },
): Promise<FlatEvidenceCandidate | undefined> {
  const roots = options.featureId
    ? [join(dir, "work", options.featureId, "evidence")]
    : [join(dir, "work")];
  const candidates: FlatEvidenceCandidate[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    await collectFlatEvidenceCandidates(root, dir, projectDir, options, candidates);
  }
  candidates.sort((a, b) => (b.evidenceTimeMs - a.evidenceTimeMs) || (b.mtimeMs - a.mtimeMs));
  return candidates[0];
}

async function collectFlatEvidenceCandidates(
  current: string,
  dir: string,
  projectDir: string,
  options: { featureId?: string; criterionId: string; dispatchStartedAt: number },
  candidates: FlatEvidenceCandidate[],
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFlatEvidenceCandidates(absolutePath, dir, projectDir, options, candidates);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    const fileStat = await stat(absolutePath);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }
    const validation = validateEvidenceFile(raw);
    if (!validation.ok) continue;
    const evidence = validation.value;
    if (evidence.criterionId !== options.criterionId) continue;
    if (options.featureId && evidence.featureId && evidence.featureId !== options.featureId) continue;
    const evidenceTimeMs = evidenceTimestampMs(evidence) ?? fileStat.mtimeMs;
    if (Math.max(evidenceTimeMs, fileStat.mtimeMs) < options.dispatchStartedAt) continue;
    candidates.push({
      evidence,
      absolutePath,
      relativePath: relative(projectDir, absolutePath),
      mtimeMs: fileStat.mtimeMs,
      evidenceTimeMs,
    });
  }
}

function evidenceTimestampMs(evidence: EvidenceFile): number | undefined {
  const parsed = Date.parse(evidence.ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

function runCommand(command: string, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "aborted before start", truncated: false, timedOut: false });
      return;
    }
    const child = spawn("/bin/sh", ["-c", command], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
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
      options.signal?.removeEventListener("abort", onAbort);
      const exitCode = aborted ? 130 : typeof code === "number" ? code : signal ? 128 : 1;
      resolve({ exitCode, stdout, stderr: aborted ? stderr + "\naborted via signal" : stderr, truncated, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err), truncated, timedOut });
    });
  });
}

function nextActionsForEvidence(criterion: CharterCriterion, outcome: EvidenceOutcome, status: "active"): NextAction[] {
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
