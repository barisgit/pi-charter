import { generateCharterId, resolveCharterId as resolveIdFromRoot } from "../domain/ids";
import { parseCharterFile, type Phase, type PhaseStatus, type ParsedCharterFile } from "../domain/charter-file";
import { appendEvent, charterDir, chartersRoot, createCharterWorkspace, listCharters, loadCharterState, loadCharterText, pathExists, reportPath, writeCharterState, writeTextAtomic, withCharterLock } from "../infrastructure/store";
import { CharterToolError } from "./errors";
import { dispatchHook } from "./hooks";
import { refreshCharterSnapshot, refreshCharterSnapshotUnlocked } from "./snapshots";
import type { CharterState, CharterStatus, NextAction } from "../domain/types";

export type { NextAction, Phase, PhaseStatus };

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
  phases: Phase[];
  phaseCounts: Record<PhaseStatus, number>;
  createdAt: string;
  warnings: string[];
  reportExists: boolean;
  nextActions: NextAction[];
  legacy: boolean;
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
      message: `Created charter ${charterId}. Refine the Objective and evolve phases in ${created.charterDir}/charter.md.`,
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
    nextActions: [{ tool: "charter", action: "create", hint: "Create a charter for durable bounded work." }],
  };
}

export async function getCharterStatus(
  projectDir: string,
  input: { charterId?: string; sessionId?: string } = {},
): Promise<CharterStatusResult> {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const charterMarkdown = await loadCharterText(dir);
  const refreshed = state.schemaVersion === "phases"
    ? await refreshCharterSnapshot(projectDir, charterId)
    : { state, parsed: parseCharterFile(charterMarkdown) };
  const phases = state.schemaVersion === "phases" ? refreshed.parsed.phases : [];
  const phaseCounts: Record<PhaseStatus, number> = {
    upcoming: phases.filter((phase) => phase.status === "upcoming").length,
    current: phases.filter((phase) => phase.status === "current").length,
    done: phases.filter((phase) => phase.status === "done").length,
  };
  const legacy = state.schemaVersion === "file-interface";
  return {
    charterId,
    status: state.status,
    objective: legacy ? state.objective : refreshed.parsed.objective || state.objective,
    references: legacy ? "" : refreshed.parsed.references,
    scope: legacy ? "" : refreshed.parsed.scope,
    phases,
    phaseCounts,
    createdAt: state.createdAt,
    warnings: legacy ? [] : refreshed.parsed.warnings,
    reportExists: await pathExists(reportPath(dir)),
    nextActions: nextActionsFor(state, legacy),
    legacy,
    charterMarkdown,
    ralph: state.ralph,
  };
}

export async function getBoundCharterStatus(projectDir: string, sessionId?: string): Promise<CharterStatusResult | undefined> {
  if (!sessionId) return undefined;
  const rows = (await listCharters(projectDir)).filter((row) => !row.legacy && row.sessionId === sessionId);
  const bound = rows.find((row) => row.status === "active" || row.status === "paused");
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
    const { charterId, dir, state } = await mutableCharter(projectDir, input);
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
    const { charterId, dir, state } = await mutableCharter(projectDir, input);
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
    const charterId = await resolveCharterId(projectDir, input);
    const dir = charterDir(projectDir, charterId);
    const initial = await loadCharterState(dir);
    assertMutable(initial);
    const { parsed, state } = await refreshCharterSnapshotUnlocked(projectDir, charterId);
    if (state.status !== "active" && state.status !== "paused") throw toolError(`Only active or paused charters can complete (current: ${state.status}).`, "status");
    await dispatchHook("charter:before_complete", {
      type: "charter:before_complete",
      charterId,
      ts: new Date().toISOString(),
      phaseCount: parsed.phases.length,
      completionNote: input.note,
    });
    const report = reportPath(dir);
    if (!(await pathExists(report))) await writeTextAtomic(report, renderReport(parsed, input.note));
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    state.completionNote = input.note;
    await writeCharterState(dir, state);
    await appendEvent(dir, { type: "charter_completed", ts: state.completedAt, charterId, note: input.note });
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
  const active = await activeChartersForSession(projectDir, input.sessionId);
  if (active.length === 1) return active[0].charterId;
  if (active.length > 1) throw new Error(`Multiple active charters for session: ${active.map((row) => row.charterId).join(", ")}`);
  const rows = await listCharters(projectDir);
  if (rows.length === 1) return rows[0].charterId;
  if (rows.length === 0) throw new Error("No charters found.");
  throw new Error("No charter id supplied and no unique active session charter found.");
}

function nextActionsFor(state: CharterState, legacy: boolean): NextAction[] {
  if (legacy || state.status === "completed" || state.status === "abandoned") return [];
  if (state.status === "paused") return [
    { tool: "charter", action: "resume", hint: state.ralph?.pausedByGuard ? "Use `/charter resume` explicitly to resume after the Ralph guard pause." : "Resume this paused charter." },
    { tool: "charter", action: "complete", hint: "Complete when the Objective has been audited and the result is ready to report." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted." },
  ];
  return [
    { tool: "charter", action: "status", hint: "Inspect the Objective and emerging phases." },
    { tool: "charter", action: "pause", hint: "Pause if this work should stop temporarily." },
    { tool: "charter", action: "complete", hint: "Complete when the Objective has been audited and the result is ready to report." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted." },
  ];
}

async function mutableCharter(projectDir: string, input: { charterId?: string; sessionId?: string }) {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  assertMutable(state);
  return { charterId, dir, state };
}

function assertMutable(state: CharterState): void {
  if (state.schemaVersion === "file-interface") throw toolError("Legacy charters are read-only. Start a new charter to continue this work.", "create");
}

async function assertSessionAvailable(projectDir: string, sessionId?: string, charterId?: string): Promise<void> {
  const existing = (await activeChartersForSession(projectDir, sessionId)).filter((row) => row.charterId !== charterId);
  if (existing.length === 0) return;
  throw new CharterToolError(`Session already has active charter ${existing[0].charterId}; status or pause it before creating another.`, {
    code: "create.active_exists",
    nextActions: [
      { tool: "charter", action: "status", hint: `Inspect ${existing[0].charterId}.` },
      { tool: "charter", action: "pause", hint: "Pause the active charter before creating a replacement." },
    ],
  });
}

async function activeChartersForSession(projectDir: string, sessionId?: string) {
  return (await listCharters(projectDir)).filter((row) => !row.legacy && row.status === "active" && (!sessionId || row.sessionId === sessionId));
}

function renderReport(parsed: ParsedCharterFile, completionNote?: string): string {
  const lines = ["# Charter Report", "", "## Objective", "", parsed.objective || "(objective missing)", ""];
  if (parsed.references) lines.push("## References", "", parsed.references, "");
  if (parsed.scope) lines.push("## Scope", "", parsed.scope, "");
  lines.push("## Phases", "");
  for (const phase of parsed.phases) {
    lines.push(`${phase.number}. ${phase.title} — ${phase.status}`);
    if (phase.body) lines.push(indent(phase.body));
  }
  lines.push("", "## Completion", "", completionNote?.trim() || "No completion note was supplied.", "");
  const links = visualEvidenceLinks(parsed);
  lines.push("## Visual Evidence", "");
  if (links.length) lines.push(...links.map((link) => `- ${link}`));
  else lines.push("No user-visible artifacts were linked from phase notes.");
  lines.push("");
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split("\n").map((line) => `   ${line}`).join("\n");
}

function visualEvidenceLinks(parsed: ParsedCharterFile): string[] {
  const out = new Set<string>();
  for (const phase of parsed.phases) {
    for (const match of phase.body.matchAll(/\[([^\]]+)\]\(((?:work\/|\/)[^)]+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|cast))\)/gi)) {
      if (!match[2].split("/").includes("..")) out.add(`[${match[1]}](${match[2]})`);
    }
  }
  return [...out];
}

function toolError(message: string, action: string): CharterToolError {
  return new CharterToolError(message, { nextActions: [{ tool: "charter", action, hint: message }] });
}
