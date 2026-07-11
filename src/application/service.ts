import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateCharterId, resolveCharterId as resolveIdFromRoot } from "../domain/ids";
import { readyCriteria, type ParsedCharterFile } from "../domain/charter-file";
import { appendEvent, charterDir, chartersRoot, createCharterWorkspace, ensureWorkDir, listCharters, loadCharterState, loadParsedCharter, pathExists, readEvents, reportPath, writeCharterState, writeTextAtomic } from "../infrastructure/store";
import { CharterToolError } from "./errors";
import { dispatchHook } from "./hooks";
import { criterionStaleness, refreshCharterSnapshot } from "./staleness";
import type { CharterState, CharterStatus, NextAction } from "../domain/types";

export type { NextAction };

export interface CharterServiceResult<T = unknown> {
  charterId: string;
  status: CharterStatus;
  message: string;
  data?: T;
  nextActions: NextAction[];
}

export interface CriterionStatusView {
  id: string;
  title: string;
  evidence: "pass" | "fail" | "none";
  note: string;
  stale: boolean;
  depends: string[];
  /** Times this criterion's Evidence line has flipped to fail (from the journal). */
  failCount: number;
}

export interface CharterStatusResult {
  charterId: string;
  status: CharterStatus;
  objective: string;
  createdAt: string;
  openEnded: boolean;
  criteria: CriterionStatusView[];
  evidenceCounts: { pass: number; fail: number; none: number };
  blockers: string[];
  warnings: string[];
  readyNext: string[];
  reportExists: boolean;
  nextActions: NextAction[];
}

export async function createCharter(
  projectDir: string,
  input: { objective: string; now?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const objective = input.objective.trim();
  if (!objective) throw toolError("objective is required for action=create", "create");
  const existing = await activeChartersForSession(projectDir, input.sessionId);
  if (existing.length > 0) {
    throw new CharterToolError(`Session already has active charter ${existing[0].charterId}; status or pause it before creating another.`, {
      code: "create.active_exists",
      nextActions: [
        { tool: "charter", action: "status", hint: `Inspect ${existing[0].charterId}.` },
        { tool: "charter", action: "pause", hint: "Pause the active charter before creating a replacement." },
      ],
    });
  }
  const now = input.now ?? new Date().toISOString();
  const charterId = await generateCharterId({ root: chartersRoot(projectDir), objective, now: new Date(now) });
  const created = await createCharterWorkspace(projectDir, { charterId, objective, now, sessionId: input.sessionId });
  return {
    charterId,
    status: created.state.status,
    message: `Created charter ${charterId}. Edit ${created.charterDir}/charter.md to add criteria or evidence.`,
    data: created.state,
    nextActions: nextActionsFor(created.state, undefined, false),
  };
}

export async function listCharterSummaries(projectDir: string): Promise<CharterServiceResult> {
  const rows = await listCharters(projectDir);
  return {
    charterId: "",
    status: "active",
    message: rows.length === 0 ? "No charters." : rows.map((row) => `${row.charterId} ${row.status} — ${row.objective}`).join("\n"),
    data: rows,
    nextActions: [{ tool: "charter", action: "create", hint: "Create a charter for durable bounded work." }],
  };
}

export async function getCharterStatus(
  projectDir: string,
  input: { charterId?: string; sessionId?: string } = {},
): Promise<CharterStatusResult> {
  const charterId = await resolveCharterId(projectDir, input);
  const refreshed = await refreshCharterSnapshot(projectDir, charterId);
  const dir = charterDir(projectDir, charterId);
  const reportExists = await pathExists(reportPath(dir));
  const staleById = new Map(criterionStaleness(refreshed.state).map((entry) => [entry.id, entry.stale]));
  const failCounts = countEvidenceFailures(await readEvents(dir));
  const criteria = refreshed.parsed.criteria.map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    evidence: criterion.evidence.status,
    note: criterion.evidence.note,
    stale: staleById.get(criterion.id) ?? false,
    depends: criterion.depends,
    failCount: failCounts.get(criterion.id) ?? 0,
  }));
  const evidenceCounts = {
    pass: criteria.filter((criterion) => criterion.evidence === "pass").length,
    fail: criteria.filter((criterion) => criterion.evidence === "fail").length,
    none: criteria.filter((criterion) => criterion.evidence === "none").length,
  };
  const blockers = completionBlockers(refreshed.state, refreshed.parsed, reportExists);
  return {
    charterId,
    status: refreshed.state.status,
    objective: refreshed.state.objective,
    createdAt: refreshed.state.createdAt,
    openEnded: refreshed.parsed.openEnded,
    criteria,
    evidenceCounts,
    blockers,
    warnings: refreshed.parsed.warnings,
    readyNext: readyCriteria(refreshed.parsed).map((criterion) => criterion.id),
    reportExists,
    nextActions: nextActionsFor(refreshed.state, refreshed.parsed, reportExists),
  };
}

export async function getBoundCharterStatus(projectDir: string, sessionId?: string): Promise<CharterStatusResult | undefined> {
  if (!sessionId) return undefined;
  const rows = (await listCharters(projectDir)).filter((row) => row.sessionId === sessionId);
  const bound = rows.find((row) => row.status === "active" || row.status === "paused") ?? rows.find((row) => row.status === "completed" || row.status === "abandoned");
  if (!bound) return undefined;
  return getCharterStatus(projectDir, { charterId: bound.charterId });
}

export async function pauseCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active") throw toolError(`Only active charters can be paused (current: ${state.status}).`, "status");
  state.previousStatus = state.status;
  state.status = "paused";
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_paused", ts: new Date().toISOString(), charterId, note: input.note });
  return { charterId, status: state.status, message: `Paused charter ${charterId}.`, data: state, nextActions: nextActionsFor(state, undefined, false) };
}

export async function resumeCharter(
  projectDir: string,
  input: { charterId?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "paused") throw toolError(`Only paused charters can be resumed (current: ${state.status}).`, "status");
  state.status = "active";
  if (input.sessionId) state.sessionId = input.sessionId;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_resumed", ts: new Date().toISOString(), charterId });
  return { charterId, status: state.status, message: `Resumed charter ${charterId}.`, data: state, nextActions: nextActionsFor(state, undefined, false) };
}

export async function bindCharterToSession(
  projectDir: string,
  input: { charterId?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  if (!input.sessionId) throw toolError("No session id available for binding.", "status");
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status !== "active") throw toolError(`Only active charters can be bound (current: ${state.status}).`, "status");
  state.sessionId = input.sessionId;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_bound", ts: new Date().toISOString(), charterId, sessionId: input.sessionId });
  return { charterId, status: state.status, message: `Bound charter ${charterId} to this session.`, data: state, nextActions: nextActionsFor(state, undefined, false) };
}

export async function completeCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const { parsed, state } = await refreshCharterSnapshot(projectDir, charterId);
  if (state.status !== "active") throw toolError(`Only active charters can complete (current: ${state.status}).`, "status");
  if (parsed.openEnded) throw toolError("Open-ended charters have no criteria; completion is not legal. Add criteria or pause/abandon.", "status");

  const report = reportPath(dir);
  const exists = await pathExists(report);
  const blockers = completionBlockers(state, parsed, exists);
  if (!exists) {
    await writeTextAtomic(report, await renderReportScaffold(dir, parsed));
    throw new CharterToolError(`REPORT.md scaffolded for ${charterId}; fill it in, then retry complete.`, {
      code: "complete.report_scaffolded",
      nextActions: [{ tool: "charter", action: "complete", hint: "Review and fill REPORT.md, then retry completion." }],
    });
  }
  if (blockers.length > 0) {
    throw new CharterToolError(`Cannot complete charter ${charterId}: ${blockers.join("; ")}`, {
      code: "complete.blocked",
      nextActions: nextActionsFor(state, parsed, true),
    });
  }
  await dispatchHook("charter:before_complete", {
    type: "charter:before_complete",
    charterId,
    ts: new Date().toISOString(),
    criteriaCount: parsed.criteria.length,
    completionNote: input.note,
  });
  state.status = "completed";
  state.completedAt = new Date().toISOString();
  state.completionNote = input.note;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_completed", ts: state.completedAt, charterId, note: input.note });
  return { charterId, status: state.status, message: `Completed charter ${charterId}.`, data: state, nextActions: [] };
}

export async function abandonCharter(
  projectDir: string,
  input: { charterId?: string; note?: string; sessionId?: string },
): Promise<CharterServiceResult<CharterState>> {
  if (!input.note?.trim()) throw toolError("note is required for action=abandon", "abandon");
  const charterId = await resolveCharterId(projectDir, input);
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  if (state.status === "completed" || state.status === "abandoned") throw toolError(`Charter is already ${state.status}.`, "status");
  await dispatchHook("charter:before_abandon", {
    type: "charter:before_abandon",
    charterId,
    ts: new Date().toISOString(),
    reason: input.note,
  });
  state.status = "abandoned";
  state.terminatedAt = new Date().toISOString();
  state.abandonReason = input.note;
  await writeCharterState(dir, state);
  await appendEvent(dir, { type: "charter_abandoned", ts: state.terminatedAt, charterId, note: input.note });
  return { charterId, status: state.status, message: `Abandoned charter ${charterId}.`, data: state, nextActions: [] };
}

export async function resolveCharterId(
  projectDir: string,
  input: { charterId?: string; sessionId?: string } = {},
): Promise<string> {
  if (input.charterId) return resolveIdFromRoot(chartersRoot(projectDir), input.charterId);
  const active = await activeChartersForSession(projectDir, input.sessionId);
  if (active.length === 1) return active[0].charterId;
  if (active.length > 1) throw new Error(`Multiple active charters for session: ${active.map((row) => row.charterId).join(", ")}`);
  const rows = await listCharters(projectDir);
  if (rows.length === 1) return rows[0].charterId;
  if (rows.length === 0) throw new Error("No charters found.");
  throw new Error("No charter id supplied and no unique active session charter found.");
}

function completionBlockers(state: CharterState, parsed: ParsedCharterFile, reportExists: boolean): string[] {
  if (parsed.openEnded) return ["open-ended charter has no criteria"];
  const stale = new Set(criterionStaleness(state).filter((entry) => entry.stale).map((entry) => entry.id));
  const blockers: string[] = [];
  for (const criterion of parsed.criteria) {
    if (criterion.evidence.status === "none") blockers.push(`${criterion.id} has no evidence`);
    if (criterion.evidence.status === "fail") blockers.push(`${criterion.id} has fail evidence`);
    if (criterion.evidence.status === "pass" && criterion.evidence.note.trim().length === 0) blockers.push(`${criterion.id} pass evidence has empty note`);
    if (stale.has(criterion.id)) blockers.push(`${criterion.id} pass evidence is stale`);
  }
  if (!reportExists) blockers.push("REPORT.md missing");
  return blockers;
}

function nextActionsFor(state: CharterState, parsed: ParsedCharterFile | undefined, reportExists: boolean): NextAction[] {
  if (state.status === "completed" || state.status === "abandoned") return [];
  if (state.status === "paused") return [
    { tool: "charter", action: "resume", hint: "Resume this paused charter." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted." },
  ];
  const actions: NextAction[] = [
    { tool: "charter", action: "status", hint: "Inspect current evidence, blockers, and ready criteria." },
    { tool: "charter", action: "pause", hint: "Pause if this work should stop temporarily." },
    { tool: "charter", action: "abandon", hint: "Abandon with a note if the objective is no longer wanted." },
  ];
  if (parsed && !parsed.openEnded) {
    actions.push({
      tool: "charter",
      action: "complete",
      hint: reportExists ? "Complete once every criterion has fresh pass evidence." : "Attempt complete to scaffold REPORT.md once criteria pass.",
    });
  }
  return actions;
}

async function activeChartersForSession(projectDir: string, sessionId?: string) {
  const rows = await listCharters(projectDir);
  return rows.filter((row) => row.status === "active" && (!sessionId || row.sessionId === sessionId));
}

async function renderReportScaffold(dir: string, parsed: ParsedCharterFile): Promise<string> {
  const artifacts = await listWorkArtifacts(dir);
  const lines = ["# Charter Report", "", "## Objective", "", parsed.objective || "(objective missing)", "", "## Criteria", ""];
  for (const criterion of parsed.criteria) {
    lines.push(`### ${criterion.id}. ${criterion.title}`, "", `Evidence: ${criterion.evidence.status} — ${criterion.evidence.note}`.trim(), "");
  }
  if (artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const artifact of artifacts) lines.push(`- ${artifact}`);
    lines.push("");
  }
  lines.push("## Summary", "", "Fill in the final outcome and any important follow-up.", "");
  return lines.join("\n");
}

async function listWorkArtifacts(dir: string): Promise<string[]> {
  const work = await ensureWorkDir(dir);
  const out: string[] = [];
  async function walk(base: string, rel = "work"): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(base, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, childRel);
      else out.push(childRel);
    }
  }
  await walk(work);
  return out.sort();
}

function toolError(message: string, action: string): CharterToolError {
  return new CharterToolError(message, {
    nextActions: [{ tool: "charter", action, hint: message }],
  });
}

export function countEvidenceFailures(events: import("../domain/types").CharterEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "criterion_changed") continue;
    if (event.field !== "evidence.status" || event.new !== "fail") continue;
    const id = typeof event.criterion === "string" ? event.criterion : undefined;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
