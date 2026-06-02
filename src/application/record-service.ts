import { access, readFile, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { validateEvidenceFile, type EvidenceFile } from "../domain/evidence-schemas";
import type { CharterCriterion, RecordedBy } from "../domain/types";

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
    { tool: "charter_status", hint: "Inspect drift and remaining uncovered criteria." },
    ...baseline,
  ];
}
