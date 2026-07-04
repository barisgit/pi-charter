/**
 * Picker data layer.
 *
 * Keeps the old picker snapshot/row shapes so the restored visual renderer can
 * stay byte-for-byte familiar, but projects them from ADR-0014 .charters/
 * state.json + charter.md status projections.
 */

import { readFile } from "node:fs/promises";
import { getCharterStatus, type CharterStatusResult } from "../application/service";
import { charterDir, listCharters, loadCharterState, readEvents, reportPath } from "../infrastructure/store";
import type { CharterStatus } from "../domain/types";

export interface PickerSnapshot {
  charterId: string;
  header: {
    name: string;
    status: CharterStatus;
    elapsedMs: number;
    passCount: number;
    totalCount: number;
  };
  objective: string;
  blockingForComplete: string[];
  plan: PlanSummaryNode;
  recentEvidence: EvidenceRow[];
  report?: ReportSnapshot;
}

export interface ReportSnapshot {
  markdown: string;
}

export interface PlanSummaryNode {
  status: "completed" | "in_progress" | "pending";
  passCount: number;
  totalCount: number;
  criteria: PlanCriterionNode[];
}

export interface PlanCriterionNode {
  criterionId: string;
  titleFromH3: string;
  depends: string[];
  outcome: "pass" | "fail" | "partial" | null;
}

export interface EvidenceRow {
  ts: string;
  criterionId: string;
  outcome: "pass" | "fail" | "partial";
  recordedBy: string;
}

export interface CharterListRow {
  charterId: string;
  name: string;
  status: CharterStatus;
  passCount: number;
  totalCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  terminatedAt?: string;
  sessionId?: string;
}

export interface CharterPickerRow {
  charterId: string;
  slug: string;
  status: CharterStatus;
  objective: string;
  createdAt: string;
  updatedAt: string;
  sessionBound: boolean;
  evidenceCounts: { pass: number; fail: number; none: number };
  staleCount: number;
  criteriaCount: number;
  criteria: Array<{ id: string; title: string; evidence: "pass" | "fail" | "none"; stale: boolean }>;
  openEnded: boolean;
  age: string;
}

export interface PickerSnapshotOptions {
  sessionId?: string;
  now?: Date;
}

const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
]);
const TERMINAL_CAP = 10;

/**
 * Resolve a charter's display name, tolerating out-of-contract on-disk state.
 * Always returns a string so pane-overlay title truncation never receives a
 * non-string and crashes pi.
 */
export function charterDisplayName(name: unknown, charterId: string): string {
  if (typeof name === "string" && name.trim()) return name;
  return slugFromId(charterId) || charterId.slice(0, 8);
}

export function extractTitleFromH3(headingLine: string): string {
  const match = /^#{2,3}\s+(C\d+\.)(?:\s+(.*))?$/.exec(headingLine);
  if (!match) return "";
  return (match[2] ?? "").trim();
}

export async function buildPickerSnapshot(
  projectDir: string,
  charterId: string,
): Promise<PickerSnapshot | null> {
  let status: CharterStatusResult;
  try {
    status = await getCharterStatus(projectDir, { charterId });
  } catch {
    return null;
  }

  let state;
  try {
    state = await loadCharterState(projectDir, charterId);
  } catch {
    return null;
  }

  const totalCount = status.criteria.length;
  const passCount = status.evidenceCounts.pass;
  const createdMs = Date.parse(state.createdAt);
  const endIso = state.completedAt ?? state.terminatedAt;
  const endMs = endIso ? Date.parse(endIso) : Date.now();
  const elapsedMs = Number.isFinite(createdMs) && Number.isFinite(endMs) ? Math.max(0, endMs - createdMs) : 0;
  const plan = buildPlan(status);
  const recentEvidence = await collectRecentEvidence(projectDir, status, state.updatedAt);
  const report = await loadReportSnapshot(projectDir, charterId);

  return {
    charterId,
    header: {
      name: charterDisplayName(slugFromId(charterId), charterId),
      status: status.status,
      elapsedMs,
      passCount,
      totalCount,
    },
    objective: status.objective,
    blockingForComplete: status.blockers,
    plan,
    recentEvidence,
    ...(report ? { report } : {}),
  };
}

export async function listAllCharters(projectDir: string): Promise<CharterListRow[]> {
  const loaded = await Promise.all((await listCharters(projectDir)).map((row) => loadListRow(projectDir, row.charterId)));
  const rows = loaded.filter((row): row is CharterListRow => row !== null);

  const nonTerminal = rows.filter((r) => !TERMINAL_STATUSES.has(r.status));
  const terminal = rows.filter((r) => TERMINAL_STATUSES.has(r.status));

  nonTerminal.sort((a, b) => compareDesc(a.createdAt, b.createdAt));
  terminal.sort((a, b) => compareDesc(terminalSortKey(a), terminalSortKey(b)));

  return [
    ...nonTerminal,
    ...terminal.slice(0, TERMINAL_CAP),
  ];
}

export async function buildPickerRows(projectDir: string, options: PickerSnapshotOptions = {}): Promise<CharterPickerRow[]> {
  const now = options.now ?? new Date();
  const rows = await listCharters(projectDir);
  const out: CharterPickerRow[] = [];
  for (const row of rows) {
    try {
      const status = await getCharterStatus(projectDir, { charterId: row.charterId });
      out.push({
        charterId: row.charterId,
        slug: slugFromId(row.charterId),
        status: status.status,
        objective: status.objective,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sessionBound: Boolean(options.sessionId && row.sessionId === options.sessionId),
        evidenceCounts: status.evidenceCounts,
        staleCount: status.criteria.filter((criterion) => criterion.stale).length,
        criteriaCount: status.criteria.length,
        criteria: status.criteria.map((criterion) => ({
          id: criterion.id,
          title: criterion.title,
          evidence: criterion.evidence,
          stale: criterion.stale,
        })),
        openEnded: status.openEnded,
        age: formatAge(row.createdAt, now),
      });
    } catch {
      // Tolerate parser/runtime drift by skipping rows that cannot project.
    }
  }
  return out;
}

async function loadListRow(projectDir: string, charterId: string): Promise<CharterListRow | null> {
  try {
    const [state, status] = await Promise.all([
      loadCharterState(projectDir, charterId),
      getCharterStatus(projectDir, { charterId }),
    ]);
    const row: CharterListRow = {
      charterId,
      name: charterDisplayName(slugFromId(charterId), charterId),
      status: status.status,
      passCount: status.evidenceCounts.pass,
      totalCount: status.criteria.length,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      sessionId: state.sessionId,
    };
    if (state.completedAt) row.completedAt = state.completedAt;
    if (state.terminatedAt) row.terminatedAt = state.terminatedAt;
    return row;
  } catch {
    return null;
  }
}

function buildPlan(status: CharterStatusResult): PlanSummaryNode {
  const criteria: PlanCriterionNode[] = status.criteria.map((criterion) => ({
    criterionId: criterion.id,
    titleFromH3: criterion.title === criterion.id ? "" : criterion.title,
    depends: criterion.depends,
    outcome: normalizeOutcome(criterion.evidence),
  }));
  const passCount = status.evidenceCounts.pass;
  return {
    status: derivePlanStatus(criteria),
    passCount,
    totalCount: criteria.length,
    criteria,
  };
}

function derivePlanStatus(criteria: PlanCriterionNode[]): "completed" | "in_progress" | "pending" {
  if (criteria.length === 0) return "pending";
  if (criteria.every((criterion) => criterion.outcome === "pass")) return "completed";
  if (criteria.every((criterion) => criterion.outcome === null)) return "pending";
  return "in_progress";
}

function normalizeOutcome(value: string | undefined): "pass" | "fail" | "partial" | null {
  if (value === "pass" || value === "fail") return value;
  return null;
}

async function loadReportSnapshot(projectDir: string, charterId: string): Promise<ReportSnapshot | undefined> {
  try {
    return { markdown: await readFile(reportPath(charterDir(projectDir, charterId)), "utf8") };
  } catch {
    return undefined;
  }
}

async function collectRecentEvidence(projectDir: string, status: CharterStatusResult, updatedAt: string): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  try {
    const events = await readEvents(charterDir(projectDir, status.charterId));
    for (const event of events) {
      if (event.field !== "evidence.status" && event.field !== "evidence.note") continue;
      const criterionId = typeof event.criterionId === "string" ? event.criterionId : "";
      const next = typeof event.next === "string" ? event.next : undefined;
      const outcome = normalizeOutcome(next);
      if (!criterionId || !outcome) continue;
      rows.push({ ts: typeof event.ts === "string" ? event.ts : updatedAt, criterionId, outcome, recordedBy: "charter.md" });
    }
  } catch {
    // Fall back to current Evidence lines below.
  }

  if (rows.length === 0) {
    for (const criterion of status.criteria) {
      const outcome = normalizeOutcome(criterion.evidence);
      if (!outcome) continue;
      rows.push({ ts: updatedAt, criterionId: criterion.id, outcome, recordedBy: criterion.note || "Evidence line" });
    }
  }
  rows.sort((a, b) => compareDesc(a.ts, b.ts));
  return rows.slice(0, 5);
}

function terminalSortKey(row: CharterListRow): string {
  return row.completedAt ?? row.terminatedAt ?? row.createdAt;
}

function compareDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

export function slugFromId(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? charterId;
}

export function evidenceSummary(row: Pick<CharterPickerRow, "evidenceCounts" | "staleCount" | "openEnded">): string {
  const parts = [
    `pass=${row.evidenceCounts.pass}`,
    `fail=${row.evidenceCounts.fail}`,
    `none=${row.evidenceCounts.none}`,
  ];
  if (row.staleCount > 0) parts.push(`stale=${row.staleCount}`);
  if (row.openEnded) parts.push("open-ended");
  return parts.join(" ");
}

export function statusWord(status: CharterStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "abandoned":
      return "abandoned";
  }
}

export function isResumableStatus(status: CharterStatus): boolean {
  return status === "active" || status === "paused";
}

function formatAge(createdAt: string, now: Date): string {
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return "?";
  const seconds = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}
