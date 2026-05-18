/**
 * Picker data layer (f4-picker-data).
 *
 * Pure data assembly the picker render layer (f5) consumes. No UI here.
 *
 * `buildPickerSnapshot` gathers a single charter's slice across charter.md,
 * state.json, criterion-state.json, feature-state.json, plan/*.md,
 * work/<featureId>/evidence/*.json and evaluator-log.jsonl. Per-source
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
import { parseCharterMarkdown } from "../domain/charter-md";
import { parseFeatureMarkdown } from "../domain/feature-md";
import {
  computeBlockingForComplete,
  loadBlockingContext,
} from "../application/service";
import { loadCriterionState } from "../application/record-service";
import { charterDir, chartersRoot, loadCharterState } from "../infrastructure/store";
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
  evaluatorVerdict: { verdict: string; steer: string; ts: string } | null;
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
  "budget_limited",
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
export function extractTitleFromH3(headingLine: string): string {
  const match = /^###\s+(VAL-[A-Z0-9-]+)(?:\s+(.*))?$/.exec(headingLine);
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

  const charterMd = await safeReadFile(join(dir, "charter.md"));
  const parsed = charterMd ? safeParseCharter(charterMd) : null;
  const titleByCriterionId = charterMd ? buildTitleMap(charterMd) : new Map<string, string>();

  const criterionState = await safeLoadCriterionState(dir, charterId);
  const featureState = await safeLoadFeatureState(dir);
  const features = await safeReadFeatures(dir);

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

  const planTree = buildPlanTree(features, featureState, criterionState, titleByCriterionId);

  const evaluatorVerdict = await readEvaluatorVerdict(dir);
  const blockingForComplete = await safeComputeBlocking(dir, charterId);
  const recentEvidence = await collectRecentEvidence(dir, features);

  return {
    charterId,
    header: {
      name: state.name?.trim() ? state.name : charterId.slice(0, 8),
      status: state.status,
      elapsedMs,
      passCount,
      totalCount,
    },
    objective: state.objective,
    evaluatorVerdict,
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
  const charterMd = await safeReadFile(join(dir, "charter.md"));
  const parsed = charterMd ? safeParseCharter(charterMd) : null;
  const criterionState = await safeLoadCriterionState(dir, charterId);
  const passCount = Object.values(criterionState.criteria).filter(
    (record) => record?.outcome === "pass",
  ).length;
  const row: CharterListRow = {
    charterId,
    name: state.name?.trim() ? state.name : charterId.slice(0, 8),
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

function safeParseCharter(markdown: string): ReturnType<typeof parseCharterMarkdown> | null {
  try {
    return parseCharterMarkdown(markdown);
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

async function safeLoadCriterionState(dir: string, charterId: string) {
  try {
    return await loadCriterionState(dir, charterId);
  } catch {
    return { charterId, criteria: {} as Record<string, { outcome?: string }> };
  }
}

interface FeatureStateMap {
  features: Record<string, { status?: string }>;
}

async function safeLoadFeatureState(dir: string): Promise<FeatureStateMap> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as Partial<FeatureStateMap>;
    const features = parsed.features && typeof parsed.features === "object"
      ? (parsed.features as FeatureStateMap["features"])
      : {};
    return { features };
  } catch {
    return { features: {} };
  }
}

interface ReadFeature {
  id: string;
  milestone: string;
  order: number;
  fulfills: string[];
}

async function safeReadFeatures(dir: string): Promise<ReadFeature[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "plan"));
  } catch {
    return [];
  }
  const out: ReadFeature[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const md = await readFile(join(dir, "plan", name), "utf8");
      const parsed = parseFeatureMarkdown(md);
      out.push({
        id: parsed.id,
        milestone: parsed.milestone,
        order: parsed.order,
        fulfills: parsed.fulfills,
      });
    } catch {
      // skip malformed feature files
    }
  }
  return out;
}

/**
 * Build a map of VAL id → title taken from the raw H3 line via
 * `extractTitleFromH3` (NOT the charter-md parser's `title`, which falls
 * back to the VAL id).
 */
function buildTitleMap(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^###\s+(VAL-[A-Z0-9-]+)/.exec(line);
    if (!match) continue;
    map.set(match[1], extractTitleFromH3(line));
  }
  return map;
}

function buildPlanTree(
  features: ReadFeature[],
  featureState: FeatureStateMap,
  criterionState: { criteria: Record<string, { outcome?: string }> },
  titleByCriterionId: Map<string, string>,
): PlanMilestoneNode[] {
  const byMilestone = new Map<string, ReadFeature[]>();
  for (const feature of features) {
    const list = byMilestone.get(feature.milestone) ?? [];
    list.push(feature);
    byMilestone.set(feature.milestone, list);
  }
  const milestoneIds = [...byMilestone.keys()].sort();
  const nodes: PlanMilestoneNode[] = [];
  for (const milestoneId of milestoneIds) {
    const list = byMilestone.get(milestoneId)!;
    list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const featureNodes: PlanFeatureNode[] = list.map((feature) => {
      const status = normalizeFeatureStatus(featureState.features[feature.id]?.status);
      const criteria: PlanCriterionNode[] = feature.fulfills.map((criterionId) => ({
        criterionId,
        titleFromH3: titleByCriterionId.get(criterionId) ?? "",
        outcome: normalizeOutcome(criterionState.criteria[criterionId]?.outcome),
      }));
      const passCount = criteria.filter((c) => c.outcome === "pass").length;
      return {
        featureId: feature.id,
        status,
        passCount,
        totalCount: criteria.length,
        criteria,
      };
    });
    nodes.push({ milestoneId, features: featureNodes });
  }
  return nodes;
}

function normalizeFeatureStatus(value: string | undefined): "completed" | "in_progress" | "pending" {
  if (value === "completed" || value === "in_progress") return value;
  return "pending";
}

function normalizeOutcome(value: string | undefined): "pass" | "fail" | "partial" | null {
  if (value === "pass" || value === "fail" || value === "partial") return value;
  return null;
}

async function readEvaluatorVerdict(
  dir: string,
): Promise<{ verdict: string; steer: string; ts: string } | null> {
  const text = await safeReadFile(join(dir, "evaluator-log.jsonl"));
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  let last: { verdict: string; steer: string; ts: string } | null = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        verdict?: unknown;
        steerReminder?: unknown;
        reason?: unknown;
        ts?: unknown;
      };
      if (entry.verdict === undefined || entry.verdict === null) continue;
      const verdict = typeof entry.verdict === "string" ? entry.verdict : String(entry.verdict);
      const steer =
        typeof entry.steerReminder === "string"
          ? entry.steerReminder
          : typeof entry.reason === "string"
            ? entry.reason
            : "";
      const ts = typeof entry.ts === "string" ? entry.ts : "";
      last = { verdict, steer, ts };
    } catch {
      // ignore malformed log lines
    }
  }
  return last;
}

async function safeComputeBlocking(dir: string, charterId: string): Promise<string[]> {
  try {
    const charterMd = await readFile(join(dir, "charter.md"), "utf8");
    const charter = parseCharterMarkdown(charterMd);
    const criterionState = await loadCriterionState(dir, charterId);
    const context = await loadBlockingContext(dir, charterId);
    const blocking = computeBlockingForComplete(charter.criteria, criterionState, context);
    return blocking.map((entry) => entry.criterionId);
  } catch {
    return [];
  }
}

async function collectRecentEvidence(
  dir: string,
  features: ReadFeature[],
): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (const feature of features) {
    const evidenceDir = join(dir, "work", feature.id, "evidence");
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
  }
  rows.sort((a, b) => compareDesc(a.ts, b.ts));
  return rows.slice(0, 5);
}
