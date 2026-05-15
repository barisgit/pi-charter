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
  source?: "manual" | "verifier";
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

interface CriterionStateRecord {
  outcome: EvidenceOutcome;
  lastEvidencePath: string;
  lastTs: string;
  lastSummary: string;
  lastFeatureId?: string;
}

interface CriterionStateFile {
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

async function loadCriterionState(dir: string, charterId: string): Promise<CriterionStateFile> {
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
