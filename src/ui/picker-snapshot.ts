import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CharterStatus, RalphGuardState } from "../domain/types";
import { getCharterStatus } from "../application/service";
import { charterDir, listCharters, loadCharterState, reportPath } from "../infrastructure/store";

export interface CharterListRow {
  charterId: string;
  name: string;
  status: CharterStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  terminatedAt?: string;
  sessionId?: string;
  objective: string;
  legacy: boolean;
}

export interface PickerSnapshot {
  header: {
    name: string;
    status: CharterStatus;
    elapsed: string;
  };
  objective: string;
  references: string;
  scope: string;
  notes: string;
  legacy: boolean;
  charterMarkdown: string;
  warnings: string[];
  report?: { markdown: string; firstHeading?: string; links: string[] };
  ralph?: RalphGuardState;
}

export async function listAllCharters(projectDir: string, now = new Date()): Promise<CharterListRow[]> {
  const rows = await listCharters(projectDir);
  const enriched = await Promise.all(rows.map(async (row) => {
    const status = await getCharterStatus(projectDir, { charterId: row.charterId });
    const state = await loadCharterState(charterDir(projectDir, row.charterId));
    return {
      charterId: row.charterId,
      name: slugFromId(row.charterId),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: state.completedAt,
      terminatedAt: state.terminatedAt,
      sessionId: status.legacy ? undefined : row.sessionId,
      objective: status.objective,
      legacy: status.legacy,
    };
  }));
  return sortRows(enriched, now);
}

export async function buildPickerSnapshot(projectDir: string, charterId: string, now = new Date()): Promise<PickerSnapshot | undefined> {
  try {
    const status = await getCharterStatus(projectDir, { charterId });
    const dir = charterDir(projectDir, charterId);
    const state = await loadCharterState(dir);
    const report = status.reportExists ? await loadReport(reportPath(dir)) : undefined;
    return {
      header: {
        name: slugFromId(charterId),
        status: status.status,
        elapsed: formatAge(now.getTime() - Date.parse(state.createdAt)),
      },
      objective: status.objective,
      references: status.references,
      scope: status.scope,
      notes: status.notes,
      legacy: status.legacy,
      charterMarkdown: status.charterMarkdown,
      warnings: status.warnings,
      report,
      ralph: status.ralph,
    };
  } catch {
    return undefined;
  }
}

function sortRows(rows: CharterListRow[], now: Date): CharterListRow[] {
  const cutoff = now.getTime() - (30 * 24 * 60 * 60 * 1000);
  return rows
    .filter((row) => row.legacy || row.status === "active" || row.status === "paused" || Date.parse(row.completedAt ?? row.terminatedAt ?? row.updatedAt) >= cutoff)
    .sort((a, b) => {
      const terminalDiff = Number(isTerminal(a.status)) - Number(isTerminal(b.status));
      if (terminalDiff !== 0) return terminalDiff;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}

function isTerminal(status: CharterStatus): boolean {
  return status === "completed" || status === "abandoned";
}

async function loadReport(path: string): Promise<PickerSnapshot["report"]> {
  try {
    const markdown = await readFile(path, "utf8");
    return {
      markdown,
      firstHeading: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim(),
      links: [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    };
  } catch {
    return undefined;
  }
}

function slugFromId(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? basename(charterId);
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
