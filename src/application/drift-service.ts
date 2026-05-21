import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { parseFeatureMarkdown, type FeatureDefinition } from "../domain/feature-md";
import { charterDir, loadCharterState } from "../infrastructure/store";
import { loadCriterionState, type CriterionStateRecord } from "./record-service";
import { getLatestReadinessProbe, type ReadinessProbeResult } from "./readiness-service";

export interface UncoveredEntry {
  criterionId: string;
  reason: "no-evidence" | "non-pass";
}

export interface StaleEntry {
  criterionId: string;
  ageMs: number;
  lastTs: string;
}

export interface ReadyNextEntry {
  featureId: string;
  fulfills: string[];
  probeResult?: ReadinessProbeResult;
}

export interface StuckEntry {
  featureId: string;
  status: string;
  startedAt?: string;
}

export interface DriftViews {
  uncovered: UncoveredEntry[];
  stuck: StuckEntry[];
  stale: StaleEntry[];
  readyNext: ReadyNextEntry[];
}

const DEFAULT_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function computeDrift(
  projectDir: string,
  input: { charterId: string; now?: number; freshnessWindowMs?: number },
): Promise<DriftViews> {
  const dir = charterDir(projectDir, input.charterId);
  let charterText: string;
  try {
    charterText = await readFile(join(dir, "charter.md"), "utf8");
  } catch {
    return { uncovered: [], stuck: [], stale: [], readyNext: [] };
  }
  const charter = parseCharterMarkdown(charterText);
  const features = await readFeatures(join(dir, "plan"));
  const criterionState = await loadCriterionState(dir, input.charterId);
  const featureState = await loadFeatureStateSafely(dir);
  const state = await loadCharterState(dir);
  const now = input.now ?? Date.now();
  const freshnessWindowMs = input.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;

  const uncovered: UncoveredEntry[] = [];
  const stale: StaleEntry[] = [];
  for (const criterion of charter.criteria) {
    const record = criterionState.criteria[criterion.id];
    if (!record) {
      uncovered.push({ criterionId: criterion.id, reason: "no-evidence" });
      continue;
    }
    if (record.outcome !== "pass") {
      uncovered.push({ criterionId: criterion.id, reason: "non-pass" });
      continue;
    }
    if (criterion.requireFreshEvidence) {
      const lastMs = Date.parse(record.lastTs);
      if (Number.isFinite(lastMs)) {
        const ageMs = now - lastMs;
        if (ageMs > freshnessWindowMs) stale.push({ criterionId: criterion.id, ageMs, lastTs: record.lastTs });
      }
    }
  }

  const uncoveredIds = new Set(uncovered.map((entry) => entry.criterionId));
  const passedCriteria = new Set(
    Object.entries(criterionState.criteria)
      .filter(([, record]: [string, CriterionStateRecord]) => record.outcome === "pass")
      .map(([id]) => id),
  );
  const completedFeatures = new Set(
    Object.entries(featureState).filter(([, record]) => record.status === "completed").map(([id]) => id),
  );
  const readyNext: ReadyNextEntry[] = [];
  for (const feature of features) {
    if (completedFeatures.has(feature.id)) continue;
    const preconditionsMet = feature.preconditions.every((id) => completedFeatures.has(id));
    if (!preconditionsMet) continue;
    const fulfilledUncovered = feature.fulfills.filter((id) => uncoveredIds.has(id));
    if (fulfilledUncovered.length === 0 && feature.fulfills.length > 0) continue;
    const probeResult = feature.kind === "readiness" ? await getLatestReadinessProbe(feature.id, dir) : undefined;
    readyNext.push({
      featureId: feature.id,
      fulfills: fulfilledUncovered.length > 0 ? fulfilledUncovered : feature.fulfills,
      ...(probeResult ? { probeResult } : {}),
    });
  }

  const stuck: StuckEntry[] = [];
  for (const [featureId, record] of Object.entries(featureState)) {
    if (record.status === "in_progress") {
      stuck.push({ featureId, status: record.status, startedAt: record.startedAt });
    }
  }

  void state;
  void passedCriteria;
  return { uncovered, stuck, stale, readyNext };
}

async function readFeatures(planDir: string): Promise<FeatureDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(planDir);
  } catch {
    return [];
  }
  const features: FeatureDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    features.push(parseFeatureMarkdown(await readFile(join(planDir, entry), "utf8")));
  }
  return features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

interface FeatureStateRow {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  lastWorkerSessionId?: string;
}

async function loadFeatureStateSafely(dir: string): Promise<Record<string, FeatureStateRow>> {
  try {
    await stat(join(dir, "feature-state.json"));
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as {
      features?: Record<string, FeatureStateRow>;
    };
    return parsed.features ?? {};
  } catch {
    return {};
  }
}
