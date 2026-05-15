import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import type { CharterCriterion } from "../domain/types";
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
    source: input.source ?? "manual",
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
    source: input.source ?? "manual",
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
      now,
    });
  }

  const featureState = await loadFeatureState(dir, input.charterId);
  const existing = featureState.features[input.featureId] ?? {};
  featureState.features[input.featureId] = {
    ...existing,
    status: existing.status ?? "in_progress",
    startedAt: existing.startedAt ?? now,
    lastWorkerSessionId: input.subagentSessionId,
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

async function loadFeatureState(dir: string, charterId: string): Promise<FeatureStateFile> {
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
