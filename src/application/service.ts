import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent, charterDir, createCharterWorkspace, loadCharterIndex, loadCharterState, writeCharterState } from "../infrastructure/store";
import { loadCriterionState } from "./record-service";
import { computeDrift } from "./drift-service";
import { dispatchHook } from "./hooks";
import { parseCharterMarkdown } from "../domain/charter-md";
import type { Budget, CharterCriterion, CharterState, CharterStatus } from "../domain/types";

export interface NextAction {
  tool: "charter_manage" | "charter_plan" | "charter_record" | "charter_status";
  action?: string;
  hint: string;
}

export interface CharterServiceResult<T = unknown> {
  charterId: string;
  status: CharterStatus;
  message: string;
  data?: T;
  nextActions: NextAction[];
}

export interface CharterStatusResult {
  charterId: string;
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
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; budget?: Budget; idempotencyKey?: string; charterId?: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const objective = input.objective.trim();
  if (!objective) throw new Error("objective is required");
  const now = input.now ?? new Date().toISOString();
  const charterId = input.charterId ?? randomUUID();
  const created = await createCharterWorkspace(projectDir, { charterId, objective, budget: input.budget, now, sessionId: input.sessionId });
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
  const state = await loadCharterState(charterDir(projectDir, charterId));
  const drift = await computeDrift(projectDir, { charterId });
  return {
    charterId: state.charterId,
    status: state.status,
    phase: phaseForStatus(state.status),
    objective: state.objective,
    budget: state.budget,
    evaluator: {},
    drift,
    guidelines: guidelinesForStatus(state.status),
    nextActions: nextActionsForStatus(state.status),
  };
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
  const failures = checkCompletionGate(charter.criteria, criterionState, state);
  if (failures.length > 0) {
    throw new Error(`Cannot complete charter:\n - ${failures.join("\n - ")}`);
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

function checkCompletionGate(
  criteria: CharterCriterion[],
  criterionState: { criteria: Record<string, { outcome: string; lastTs: string; source?: string; lastFeatureId?: string }> },
  state: CharterState,
): string[] {
  const failures: string[] = [];
  const freshnessWindowMs = 24 * 60 * 60 * 1000;
  const lockTs = state.updatedAt;
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
    if (criterion.requireReviewSubagent) {
      const source = (record as { source?: string }).source;
      if (source !== "verifier" && source !== "subagent") {
        failures.push(`${criterion.id}: requires review subagent evidence (got ${source ?? "manual"})`);
      }
    }
  }
  return failures;
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
    "Run subagent({agent:'charter-planner-critic'}) before charter_plan action=lock_plan; resolve every BLOCK finding it returns.",
  ];
  if (status === "active") return [
    "Choose one next move from charter_status nextActions; do not guess transitions.",
    "Delegate verification with subagent({agent:'charter-verifier', metadata:{'pi-charter.charterId':<id>,'pi-charter.featureId':<id>,'pi-charter.projectDir':<cwd>}}) instead of running verifier commands inline.",
  ];
  if (status === "review") return ["Inspect evidence before completing; evaluator done is not a gate."];
  if (status === "paused") return ["Resume before recording new evidence or changing plan state."];
  return ["Terminal charters are read-only except explicit follow-up/new charter actions."];
}

function isTerminal(status: CharterStatus): boolean {
  return status === "completed" || status === "budget_limited" || status === "abandoned";
}
