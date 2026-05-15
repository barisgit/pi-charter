import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendEvent, charterDir, createCharterWorkspace, loadCharterIndex, loadCharterState, writeCharterState } from "../infrastructure/store";
import type { Budget, CharterState, CharterStatus } from "../domain/types";

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
  drift: { uncovered: unknown[]; stuck: unknown[]; stale: unknown[]; readyNext: unknown[] };
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
  return {
    charterId: state.charterId,
    status: state.status,
    phase: phaseForStatus(state.status),
    objective: state.objective,
    budget: state.budget,
    evaluator: {},
    drift: { uncovered: [], stuck: [], stale: [], readyNext: [] },
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
      return [{ tool: "charter_status", hint: "Inspect terminal charter result." }];
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
  if (status === "planning") return ["Author charter.md and plan/<featureId>.md before locking the plan."];
  if (status === "active") return ["Choose one next move based on drift views and evidence gaps."];
  if (status === "review") return ["Inspect evidence before completing; evaluator done is not a gate."];
  if (status === "paused") return ["Resume before recording new evidence or changing plan state."];
  return ["Terminal charters are read-only except explicit follow-up/new charter actions."];
}

function isTerminal(status: CharterStatus): boolean {
  return status === "completed" || status === "budget_limited" || status === "abandoned";
}
