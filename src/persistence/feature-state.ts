import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../infrastructure/store";

export type FeatureCheckStatus = "pending" | "passing" | "failing";

export interface FeatureCheckState {
  status: FeatureCheckStatus;
  lastEvidenceTs?: string;
  rounds?: number;
  lastError?: string;
}

export interface FeatureStateRecord {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  lastWorkerSessionId?: string;
  lastHandoffPath?: string;
  checks: Record<string, FeatureCheckState>;
}

export interface FeatureStateFile {
  charterId: string;
  features: Record<string, FeatureStateRecord>;
}

export async function loadFeatureState(dir: string, charterId: string): Promise<FeatureStateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as Partial<FeatureStateFile>;
    return {
      charterId: typeof parsed.charterId === "string" ? parsed.charterId : charterId,
      features: normalizeFeatures(parsed.features),
    };
  } catch {
    return { charterId, features: {} };
  }
}

export async function writeFeatureState(dir: string, state: FeatureStateFile): Promise<void> {
  await writeJsonAtomic(join(dir, "feature-state.json"), state);
}

const featureStateQueues = new Map<string, Promise<unknown>>();

async function withFeatureStateLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(dir, "feature-state.json");
  const prev = featureStateQueues.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guard = next.catch(() => undefined);
  featureStateQueues.set(path, guard);
  try {
    return await next;
  } finally {
    if (featureStateQueues.get(path) === guard) featureStateQueues.delete(path);
  }
}

export async function writeFeatureCheckState(
  dir: string,
  charterId: string,
  featureId: string,
  checkId: string,
  check: FeatureCheckState,
): Promise<FeatureStateFile> {
  return await withFeatureStateLock(dir, async () => {
    const state = await loadFeatureState(dir, charterId);
    const feature = state.features[featureId] ?? { checks: {} };
    state.features[featureId] = {
      ...feature,
      checks: {
        ...feature.checks,
        [checkId]: check,
      },
    };
    await writeFeatureState(dir, state);
    return state;
  });
}

function normalizeFeatures(value: unknown): Record<string, FeatureStateRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const features: Record<string, FeatureStateRecord> = {};
  for (const [featureId, rawFeature] of Object.entries(value)) {
    if (!rawFeature || typeof rawFeature !== "object" || Array.isArray(rawFeature)) {
      features[featureId] = { checks: {} };
      continue;
    }
    const raw = rawFeature as Record<string, unknown>;
    features[featureId] = {
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
      ...(typeof raw.lastWorkerSessionId === "string" ? { lastWorkerSessionId: raw.lastWorkerSessionId } : {}),
      ...(typeof raw.lastHandoffPath === "string" ? { lastHandoffPath: raw.lastHandoffPath } : {}),
      checks: normalizeChecks(raw.checks),
    };
  }
  return features;
}

function normalizeChecks(value: unknown): Record<string, FeatureCheckState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const checks: Record<string, FeatureCheckState> = {};
  for (const [checkId, rawCheck] of Object.entries(value)) {
    if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) continue;
    const raw = rawCheck as Record<string, unknown>;
    if (!isFeatureCheckStatus(raw.status)) continue;
    checks[checkId] = {
      status: raw.status,
      ...(typeof raw.lastEvidenceTs === "string" ? { lastEvidenceTs: raw.lastEvidenceTs } : {}),
      ...(typeof raw.rounds === "number" && Number.isFinite(raw.rounds) ? { rounds: raw.rounds } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError } : {}),
    };
  }
  return checks;
}

function isFeatureCheckStatus(value: unknown): value is FeatureCheckStatus {
  return value === "pending" || value === "passing" || value === "failing";
}
