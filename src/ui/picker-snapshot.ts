/**
 * Picker data layer.
 *
 * Pure data assembly for the picker render layer. No UI here.
 *
 * `buildPickerSnapshot` gathers a single charter's slice across charter.md,
 * state.json, criterion-state.json, feature-state.json, plan/*.md,
 * work/<featureId>/evidence/*.json. Per-source
 * errors are swallowed so one bad file does not poison the snapshot; only a
 * missing or unreadable state.json returns null.
 *
 * `listAllCharters` enumerates every charter under `.pi/charters/`
 * (including terminal ones; `listActiveCharters` in service.ts is
 * non-terminal-only and not reused here). Order: non-terminal sorted by
 * createdAt desc, then terminal sorted by `completedAt ?? terminatedAt ??
 * createdAt` desc, terminal capped at 10.
 *
 * `extractTitleFromH3` is the picker's title source: the charter-md parser
 * falls back the H3 title to the VAL id when the heading is just
 * `### VAL-X`, which would render the id twice. The picker wants an empty
 * string in that case so it can render id + title without dup.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  computeBlockingForComplete,
  loadBlockingContext,
} from "../application/service";
import { loadCriterionState, type CriterionStateFile } from "../application/record-service";
import { charterDir, chartersRoot, loadCharterState, loadParsedCharter } from "../infrastructure/store";
import type { CharterMilestone, CharterStatus, ParsedCharterMarkdown } from "../domain/types";

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
  planTree: PlanMilestoneNode[];
  recentEvidence: EvidenceRow[];
}

export interface PlanMilestoneNode {
  milestoneId: string;
  features: PlanFeatureNode[];
}

export interface PlanFeatureNode {
  featureId: string;
  status: "completed" | "in_progress" | "pending";
  passCount: number;
  totalCount: number;
  criteria: PlanCriterionNode[];
}

export interface PlanCriterionNode {
  criterionId: string;
  titleFromH3: string;
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
}

const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
]);
const TERMINAL_CAP = 10;

/**
 * Extract the human-readable title that follows a `### VAL-...` heading.
 *
 * Returns empty string when the heading is just the VAL id (e.g.
 * `### VAL-X`). The charter-md parser falls back the title to the VAL id in
 * that case, which would render the id twice in the picker; the picker
 * prefers a deliberate empty so it can format id + title without dup.
 */
/**
 * Resolve a charter's display name, tolerating out-of-contract on-disk state
 * (e.g. a non-string `name` in a corrupted/legacy `state.json`). Always returns
 * a string so downstream TUI chrome never receives a non-string and crashes pi.
 */
export function charterDisplayName(name: unknown, charterId: string): string {
  return typeof name === "string" && name.trim() ? name : charterId.slice(0, 8);
}

export function extractTitleFromH3(headingLine: string): string {
  const match = /^#{2,3}\s+(VAL-[A-Z0-9-]+)(?:\s+(.*))?$/.exec(headingLine);
  if (!match) return "";
  return (match[2] ?? "").trim();
}

export async function buildPickerSnapshot(
  projectDir: string,
  charterId: string,
): Promise<PickerSnapshot | null> {
  const dir = charterDir(projectDir, charterId);
  let state;
  try {
    state = await loadCharterState(dir);
  } catch {
    return null;
  }

  const [parsed, charterMd, criteriaMd] = await Promise.all([
    safeLoadParsedCharter(dir),
    safeReadFile(join(dir, "charter.md")),
    safeReadFile(join(dir, "criteria.md")),
  ]);
  const titleByCriterionId = buildTitleMap(effectiveCriteriaTitleSource(charterMd, criteriaMd));

  const criterionState = await safeLoadCriterionState(dir, charterId);

  const totalCount = parsed?.criteria.length ?? 0;
  const passCount = Object.values(criterionState.criteria).filter(
    (record) => record?.outcome === "pass",
  ).length;
  // For terminal charters, freeze elapsed time at completedAt/terminatedAt so the
  // duration reflects actual lifetime rather than wall-clock since creation.
  const createdMs = Date.parse(state.createdAt);
  const endIso = state.completedAt ?? state.terminatedAt;
  const endMs = endIso ? Date.parse(endIso) : Date.now();
  const elapsedMs = Number.isFinite(createdMs) && Number.isFinite(endMs) ? Math.max(0, endMs - createdMs) : 0;

  const planTree = buildPlanTree(parsed, criterionState, titleByCriterionId);

  const blockingForComplete = await safeComputeBlocking(dir, charterId);
  const recentEvidence = await collectRecentEvidence(dir);

  return {
    charterId,
    header: {
      name: charterDisplayName(state.name, charterId),
      status: state.status,
      elapsedMs,
      passCount,
      totalCount,
    },
    objective: state.objective,
    blockingForComplete,
    planTree,
    recentEvidence,
  };
}

export async function listAllCharters(projectDir: string): Promise<CharterListRow[]> {
  const root = chartersRoot(projectDir);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map((id) => loadListRow(projectDir, id)),
  );
  const rows = loaded.filter((row): row is LoadedRow => row !== null);

  const nonTerminal = rows.filter((r) => !TERMINAL_STATUSES.has(r.row.status));
  const terminal = rows.filter((r) => TERMINAL_STATUSES.has(r.row.status));

  nonTerminal.sort((a, b) => compareDesc(a.row.createdAt, b.row.createdAt));
  terminal.sort((a, b) => compareDesc(terminalSortKey(a), terminalSortKey(b)));

  return [
    ...nonTerminal.map((entry) => entry.row),
    ...terminal.slice(0, TERMINAL_CAP).map((entry) => entry.row),
  ];
}

interface LoadedRow {
  row: CharterListRow;
  terminatedAt?: string;
}

async function loadListRow(
  projectDir: string,
  charterId: string,
): Promise<LoadedRow | null> {
  const dir = charterDir(projectDir, charterId);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  let state;
  try {
    state = await loadCharterState(dir);
  } catch {
    return null;
  }
  const parsed = await safeLoadParsedCharter(dir);
  const criterionState = await safeLoadCriterionState(dir, charterId);
  const passCount = Object.values(criterionState.criteria).filter(
    (record) => record?.outcome === "pass",
  ).length;
  const row: CharterListRow = {
    charterId,
    name: charterDisplayName(state.name, charterId),
    status: state.status,
    passCount,
    totalCount: parsed?.criteria.length ?? 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  if (state.completedAt) row.completedAt = state.completedAt;
  if (state.terminatedAt) row.terminatedAt = state.terminatedAt;
  return { row, terminatedAt: state.terminatedAt };
}

function terminalSortKey(entry: LoadedRow): string {
  return entry.row.completedAt ?? entry.terminatedAt ?? entry.row.createdAt;
}

function compareDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

async function safeLoadParsedCharter(dir: string): Promise<ParsedCharterMarkdown | null> {
  try {
    return await loadParsedCharter(dir);
  } catch {
    return null;
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function effectiveCriteriaTitleSource(charterMd: string | null, criteriaMd: string | null): string {
  if (criteriaMd && !(isDefaultCriteriaScaffold(criteriaMd) && charterHasInlineCriteria(charterMd ?? ""))) {
    return criteriaMd;
  }
  return charterMd ?? criteriaMd ?? "";
}

function isDefaultCriteriaScaffold(markdown: string): boolean {
  const valHeadings = markdown.match(/^#{2,3}\s+VAL-[A-Z0-9-]+\b/gm) ?? [];
  return valHeadings.length === 1 && /^##\s+VAL-EXAMPLE\b/m.test(markdown);
}

function charterHasInlineCriteria(markdown: string): boolean {
  const criteriaSection = /(?:^|\n)##\s+Criteria\s*(?:\n|$)([\s\S]*?)(?=\n##\s+|$)/i.exec(markdown)?.[1] ?? "";
  return /(?:^|\n)###\s+VAL-[A-Z0-9-]+\b/i.test(criteriaSection);
}

async function safeLoadCriterionState(dir: string, charterId: string): Promise<CriterionStateFile> {
  try {
    return await loadCriterionState(dir, charterId);
  } catch {
    return { charterId, criteria: {} };
  }
}

/**
 * Build a map of VAL id → title taken from the raw H3 line via
 * `extractTitleFromH3` (NOT the charter-md parser's `title`, which falls
 * back to the VAL id).
 */
function buildTitleMap(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{2,3}\s+(VAL-[A-Z0-9-]+)/.exec(line);
    if (!match) continue;
    map.set(match[1], extractTitleFromH3(line));
  }
  return map;
}

function buildPlanTree(
  parsed: ParsedCharterMarkdown | null,
  criterionState: CriterionStateFile,
  titleByCriterionId: Map<string, string>,
): PlanMilestoneNode[] {
  if (!parsed) return [];
  const milestones: CharterMilestone[] = parsed.milestones.length > 0
    ? parsed.milestones
    : [{
      id: "",
      title: "",
      criterionIds: parsed.criteria.map((criterion) => criterion.id),
    }];
  return milestones.map((milestone) => {
    const criteria: PlanCriterionNode[] = milestone.criterionIds.map((criterionId) => ({
      criterionId,
      titleFromH3: titleByCriterionId.get(criterionId) ?? "",
      outcome: normalizeOutcome(criterionState.criteria[criterionId]?.outcome),
    }));
    const passCount = criteria.filter((criterion) => criterion.outcome === "pass").length;
    const featureNode: PlanFeatureNode = {
      featureId: milestone.id || "_flat",
      status: deriveMilestoneFeatureStatus(criteria),
      passCount,
      totalCount: criteria.length,
      criteria,
    };
    return { milestoneId: milestone.id, features: [featureNode] };
  });
}

function deriveMilestoneFeatureStatus(
  criteria: PlanCriterionNode[],
): "completed" | "in_progress" | "pending" {
  if (criteria.length === 0) return "pending";
  if (criteria.every((criterion) => criterion.outcome === "pass")) return "completed";
  if (criteria.every((criterion) => criterion.outcome === null)) return "pending";
  return "in_progress";
}

function normalizeOutcome(value: string | undefined): "pass" | "fail" | "partial" | null {
  if (value === "pass" || value === "fail" || value === "partial") return value;
  return null;
}

async function safeComputeBlocking(dir: string, charterId: string): Promise<string[]> {
  try {
    const parsed = await safeLoadParsedCharter(dir);
    if (!parsed) return [];
    const criterionState = await safeLoadCriterionState(dir, charterId);
    const context = await loadBlockingContext(dir, charterId);
    return computeBlockingForComplete(parsed.criteria, criterionState, context)
      .map((entry) => `${entry.criterionId ?? entry.handoffPath ?? entry.featureId ?? "handoff item"}: ${entry.reason}`);
  } catch {
    return [];
  }
}


async function collectRecentEvidence(dir: string): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  const workRoot = join(dir, "work");
  let workEntries: string[];
  try {
    workEntries = await readdir(workRoot);
  } catch {
    return [];
  }
  for (const segment of workEntries) {
    const evidenceDir = join(workRoot, segment, "evidence");
    let entries: string[];
    try {
      entries = await readdir(evidenceDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const text = await safeReadFile(join(evidenceDir, name));
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as {
          ts?: unknown;
          criterionId?: unknown;
          outcome?: unknown;
          recordedBy?: unknown;
        };
        const outcome = normalizeOutcome(typeof parsed.outcome === "string" ? parsed.outcome : undefined);
        if (!outcome) continue;
        const ts = typeof parsed.ts === "string" ? parsed.ts : "";
        const criterionId = typeof parsed.criterionId === "string" ? parsed.criterionId : "";
        const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : "";
        if (!ts || !criterionId) continue;
        rows.push({ ts, criterionId, outcome, recordedBy });
      } catch {
        // skip malformed evidence
      }
    }
    const runEvidenceDirs = entries.filter((name) => !name.endsWith(".json"));
    for (const runDir of runEvidenceDirs) {
      const runEvidenceDir = join(evidenceDir, runDir);
      let runFiles: string[];
      try {
        runFiles = await readdir(runEvidenceDir);
      } catch {
        continue;
      }
      for (const name of runFiles) {
        if (!name.endsWith(".json")) continue;
        const text = await safeReadFile(join(runEvidenceDir, name));
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as {
            ts?: unknown;
            criterionId?: unknown;
            outcome?: unknown;
            recordedBy?: unknown;
          };
          const outcome = normalizeOutcome(typeof parsed.outcome === "string" ? parsed.outcome : undefined);
          if (!outcome) continue;
          const ts = typeof parsed.ts === "string" ? parsed.ts : "";
          const criterionId = typeof parsed.criterionId === "string" ? parsed.criterionId : "";
          const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : "";
          if (!ts || !criterionId) continue;
          rows.push({ ts, criterionId, outcome, recordedBy });
        } catch {
          // skip malformed evidence
        }
      }
    }
  }
  rows.sort((a, b) => compareDesc(a.ts, b.ts));
  return rows.slice(0, 5);
}
