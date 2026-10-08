import { generateCharterId, resolveCharterId as resolveIdFromRoot } from "../domain/ids";
import { parseCharterFile } from "../domain/charter-file";
import { appendEvent, charterDir, chartersRoot, createCharterWorkspace, listCharterIds, listCharters, loadCharterState, loadCharterText, pathExists, reportPath, writeCharterState, withCharterLock } from "../infrastructure/store";
import { CharterToolError } from "./errors";
import { dispatchHook } from "./hooks";
import type { CharterState, CharterStatus, NextAction } from "../domain/types";

export type { NextAction };

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
  objective: string;
  references: string;
  scope: string;
  /** Authored Markdown outside Objective/References/Scope, shown as plain notes. */
  notes: string;
  createdAt: string;
  warnings: string[];
  /** Whether an optional REPORT.md exists; Charter never creates one. */
  reportExists: boolean;
  nextActions: NextAction[];
  legacy: boolean;
  /** The authored charter.md verbatim, including notes the parser ignores. */
  charterMarkdown: string;
  ralph?: CharterState["ralph"];
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    const objective = input.objective.trim();
    if (!objective) throw toolError("objective is required for action=create", "create");
    await assertSessionAvailable(projectDir, input.sessionId);
    const now = input.now ?? new Date().toISOString();
    const charterId = await generateCharterId({ root: chartersRoot(projectDir), objective, now: new Date(now) });
    const created = await createCharterWorkspace(projectDir, { charterId, objective, now, sessionId: input.sessionId });
    return {
      charterId,
      status: created.state.status,
      message: `Created charter ${charterId}. Refine the Objective in ${created.charterDir}/charter.md.`,
      data: created.state,
      nextActions: nextActionsFor(created.state, false),
    };
  });
}

export async function listCharterSummaries(projectDir: string): Promise<CharterServiceResult> {
  const rows = await listCharters(projectDir);
  return {
    charterId: "",
    status: "active",
    message: rows.length === 0 ? "No charters." : rows.map((row) => `${row.charterId} ${row.status}${row.legacy ? " legacy" : ""} — ${row.objective}`).join("\n"),
    data: rows,
    nextActions: [{ tool: "charter", action: "create", hint: "Create a charter for durable bounded work only when this session has no active or paused charter; otherwise complete or abandon that charter first." }],
  };
}

/**
 * Read the charter as it is on disk now: lifecycle from state.json and the
 * Objective, References, Scope and notes parsed from the current charter.md.
 * Pure read: takes no lock and writes nothing, so it never waits for a mutation.
 */
export async function getCharterStatus(
  projectDir: string,
  input: { charterId?: string; sessionId?: string } = {},
): Promise<CharterStatusResult> {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const charterMarkdown = await loadCharterText(dir);
  const parsed = parseCharterFile(charterMarkdown);
  const legacy = state.schemaVersion === "file-interface";
  return {
    charterId,
    status: state.status,
    objective: legacy ? state.objective : parsed.objective || state.objective,
    references: legacy ? "" : parsed.references,
    scope: legacy ? "" : parsed.scope,
    notes: legacy ? "" : parsed.notes,
    createdAt: state.createdAt,
    warnings: legacy ? [] : parsed.warnings,
    reportExists: await pathExists(reportPath(dir)),
    nextActions: nextActionsFor(state, legacy),
    legacy,
    charterMarkdown,
    ralph: state.ralph,
  };
}

/**
 * The writable charter bound to the session, read from state.json only (no
 * charter.md, no lock). The cheap lookup for callers that need lifecycle and
 * Ralph guard state, such as the widget.
 */
export async function findBoundCharterState(projectDir: string, sessionId?: string): Promise<CharterState | undefined> {
  if (!sessionId) return undefined;
  for (const id of await listCharterIds(projectDir)) {
    const state = await loadCharterState(projectDir, id).catch(() => undefined);
    if (state && state.schemaVersion === "phases" && state.sessionId === sessionId && (state.status === "active" || state.status === "paused")) return state;
  }
  return undefined;
}

export async function getBoundCharterStatus(projectDir: string, sessionId?: string): Promise<CharterStatusResult | undefined> {
  const bound = await findBoundCharterState(projectDir, sessionId);
  return bound ? getCharterStatus(projectDir, { charterId: bound.charterId }) : undefined;
}

export async function pauseCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string; guard?: boolean },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    const { charterId, dir, state } = await mutableCharter(projectDir, input);
    if (state.status !== "active") throw toolError(`Only active charters can be paused (current: ${state.status}).`, "status");
    state.previousStatus = state.status;
    state.status = "paused";
    if (input.guard) state.ralph = { activations: state.ralph?.activations ?? [], warnedAt: state.ralph?.warnedAt, pausedByGuard: true };
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_paused", ts: new Date().toISOString(), charterId, note: input.note, guard: input.guard === true });
    return { charterId, status: state.status, message: `Paused charter ${charterId}.`, data: state, nextActions: nextActionsFor(state, false) };
  });
}

export async function resumeCharter(
  projectDir: string,
  input: { charterId?: string; sessionId?: string; userInitiated?: boolean },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    const { charterId, dir, state } = await mutableCharter(projectDir, input, true);
    if (state.status !== "paused") throw toolError(`Only paused charters can be resumed (current: ${state.status}).`, "status");
    if (state.ralph?.pausedByGuard && !input.userInitiated) {
      throw toolError("This charter was paused by the Ralph guard. Use explicit user command `/charter resume` to continue.", "status");
    }
    await assertSessionAvailable(projectDir, input.sessionId ?? state.sessionId, charterId);
    state.status = "active";
    if (input.sessionId) state.sessionId = input.sessionId;
    if (state.ralph?.pausedByGuard) state.ralph = { activations: [] };
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_resumed", ts: new Date().toISOString(), charterId });
    return { charterId, status: state.status, message: `Resumed charter ${charterId}.`, data: state, nextActions: nextActionsFor(state, false) };
  });
}

export async function bindCharterToSession(
  projectDir: string,
  input: { charterId?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    if (!input.sessionId) throw toolError("No session id available for binding.", "status");
    const { charterId, dir, state } = await mutableCharter(projectDir, input, true);
    if (state.status !== "active") throw toolError(`Only active charters can be bound (current: ${state.status}).`, "status");
    await assertSessionAvailable(projectDir, input.sessionId, charterId);
    state.sessionId = input.sessionId;
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_bound", ts: new Date().toISOString(), charterId, sessionId: input.sessionId });
    return { charterId, status: state.status, message: `Bound charter ${charterId} to this session.`, data: state, nextActions: nextActionsFor(state, false) };
  });
}

export async function completeCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    const note = input.note?.trim();
    if (!note) throw toolError("note is required for action=complete", "complete");
    const { charterId, dir, state } = await mutableCharter(projectDir, input);
    if (state.status !== "active" && state.status !== "paused") throw toolError(`Only active or paused charters can complete (current: ${state.status}).`, "status");
    await dispatchHook("charter:before_complete", {
      type: "charter:before_complete",
      charterId,
      ts: new Date().toISOString(),
      completionNote: note,
    });
    // Any REPORT.md or work/ artifacts belong to the worker and stay untouched.
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    state.completionNote = note;
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_completed", ts: state.completedAt, charterId, note });
    return { charterId, status: state.status, message: `Completed charter ${charterId}.`, data: state, nextActions: [] };
  });
}

export async function abandonCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  return withCharterLock(chartersRoot(projectDir), async () => {
    if (!input.note?.trim()) throw toolError("note is required for action=abandon", "abandon");
    const { charterId, dir, state } = await mutableCharter(projectDir, input);
    if (state.status === "completed" || state.status === "abandoned") throw toolError(`Charter is already ${state.status}.`, "status");
    await dispatchHook("charter:before_abandon", { type: "charter:before_abandon", charterId, ts: new Date().toISOString(), reason: input.note });
    state.status = "abandoned";
    state.terminatedAt = new Date().toISOString();
    state.abandonReason = input.note;
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_abandoned", ts: state.terminatedAt, charterId, note: input.note });
    return { charterId, status: state.status, message: `Abandoned charter ${charterId}.`, data: state, nextActions: [] };
  });
}

export async function resolveCharterId(
  projectDir: string,
  input: { charterId?: string; sessionId?: string } = {},
): Promise<string> {
  if (input.charterId) return resolveIdFromRoot(chartersRoot(projectDir), input.charterId);
  if (input.sessionId) {
    const bound = (await listCharters(projectDir)).find((row) =>
      !row.legacy && row.sessionId === input.sessionId && (row.status === "active" || row.status === "paused"));
    if (bound) return bound.charterId;
  }
  const rows = await listCharters(projectDir);
  if (rows.length === 1) return rows[0].charterId;
  if (rows.length === 0) throw new Error("No charters found.");
  throw new Error("No charter id supplied and no unique active session charter found.");
}

function nextActionsFor(state: CharterState, legacy: boolean): NextAction[] {
  if (legacy || state.status === "completed" || state.status === "abandoned") return [];
  if (state.status === "paused") return [
    { tool: "charter", action: "resume", hint: state.ralph?.pausedByGuard ? "Use `/charter resume` explicitly to resume after the Ralph guard pause." : "Resume this paused charter." },
    { tool: "charter", action: "complete", hint: "Complete with a concise note once the Objective is satisfied; complete or abandon this charter before opening another." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted; complete or abandon this charter before opening another." },
  ];
  return [
    { tool: "charter", action: "status", hint: "Inspect the Objective and charter notes." },
    { tool: "charter", action: "pause", hint: "Pause if this work should stop temporarily." },
    { tool: "charter", action: "complete", hint: "Complete with a concise note once the Objective is satisfied; complete or abandon this charter before opening another." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted; complete or abandon this charter before opening another." },
  ];
}

async function mutableCharter(projectDir: string, input: { charterId?: string; sessionId?: string }, allowResume = false) {
  const bound = input.sessionId ? (await nonTerminalChartersForSession(projectDir, input.sessionId))[0] : undefined;
  if (input.sessionId && !bound && !(allowResume && input.charterId)) {
    throw toolError("This session has no bound charter. Use resume with an explicit id to pick up a paused charter.", "resume");
  }
  const charterId = await resolveCharterId(projectDir, input);
  if (bound && charterId !== bound.charterId) {
    throw new CharterToolError(`This session is bound to charter ${bound.charterId}; mutate only that charter. Complete or abandon it before opening another.`, {
      code: "session.charter_mismatch",
      nextActions: [
        { tool: "charter", action: "status", hint: `Inspect the bound charter ${bound.charterId}.` },
      ],
    });
  }
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  assertMutable(state);
  return { charterId, dir, state };
}

function assertMutable(state: CharterState): void {
  if (state.schemaVersion === "file-interface") throw toolError("Legacy charters are read-only. Start a new charter to continue this work.", "create");
}

async function assertSessionAvailable(projectDir: string, sessionId?: string, charterId?: string): Promise<void> {
  const existing = (await nonTerminalChartersForSession(projectDir, sessionId)).filter((row) => row.charterId !== charterId);
  if (existing.length === 0) return;
  throw new CharterToolError(`Session already has non-terminal charter ${existing[0].charterId}; complete or abandon the current charter first.`, {
    code: "create.non_terminal_exists",
    nextActions: [
      { tool: "charter", action: "complete", hint: `Complete ${existing[0].charterId} when the Objective is met before opening another charter.` },
      { tool: "charter", action: "abandon", hint: `Abandon ${existing[0].charterId} with a reason before opening another charter.` },
    ],
  });
}

async function nonTerminalChartersForSession(projectDir: string, sessionId?: string) {
  return (await listCharters(projectDir)).filter((row) => !row.legacy && (row.status === "active" || row.status === "paused") && row.sessionId === sessionId);
}

function toolError(message: string, action: string): CharterToolError {
  return new CharterToolError(message, { nextActions: [{ tool: "charter", action, hint: message }] });
}
