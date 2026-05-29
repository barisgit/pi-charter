import { access } from "node:fs/promises";
import { join } from "node:path";
import { charterDir, loadCharterState, loadParsedCharter } from "../infrastructure/store";
import { isEvidenceStaleForSrcChange, lastSrcChangeMs } from "../domain/src-freshness";
import { computeSidecarDrift, type SidecarDriftEntry } from "./sidecar-drift";
import { loadCriterionState } from "./record-service";

export interface UncoveredEntry {
  criterionId: string;
  reason: "no-evidence" | "non-pass";
}

export interface StaleEntry {
  criterionId: string;
  ageMs: number;
  lastTs: string;
  reason: "src-change" | "age-window";
}

export interface ReadyNextEntry {
  criterionId: string;
  milestoneId: string;
}

export interface MilestoneArtifactReminder {
  milestoneId: string;
  reason: "no-artifact-capture";
}

export interface DriftViews {
  uncovered: UncoveredEntry[];
  stale: StaleEntry[];
  readyNext: ReadyNextEntry[];
  sidecarDrift: SidecarDriftEntry[];
  milestoneArtifacts: MilestoneArtifactReminder[];
}

export async function computeDrift(
  projectDir: string,
  input: { charterId: string; now?: number },
): Promise<DriftViews> {
  const dir = charterDir(projectDir, input.charterId);
  let charter: Awaited<ReturnType<typeof loadParsedCharter>>;
  let state: Awaited<ReturnType<typeof loadCharterState>>;
  try {
    [charter, state] = await Promise.all([
      loadParsedCharter(dir),
      loadCharterState(dir),
    ]);
  } catch {
    return { uncovered: [], stale: [], readyNext: [], sidecarDrift: [], milestoneArtifacts: [] };
  }
  const criterionState = await loadCriterionState(dir, input.charterId);
  const now = input.now ?? Date.now();
  const srcChangeMs = await lastSrcChangeMs(projectDir);

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
      if (isEvidenceStaleForSrcChange(record.lastTs, srcChangeMs)) {
        stale.push({
          criterionId: criterion.id,
          ageMs: srcChangeMs === undefined ? 0 : Math.max(0, srcChangeMs - Date.parse(record.lastTs)),
          lastTs: record.lastTs,
          reason: "src-change",
        });
      }
    }
  }

  const uncoveredIds = new Set(uncovered.map((entry) => entry.criterionId));
  const readyNext = firstNonPassVal(charter.milestones, charter.criteria.map((criterion) => criterion.id), uncoveredIds);
  const sidecarDrift = await computeSidecarDrift(dir, state, criterionState);
  const milestoneArtifacts = await computeMilestoneArtifactReminders(dir, charter.milestones, criterionState);

  return { uncovered, stale, readyNext, sidecarDrift, milestoneArtifacts };
}

async function computeMilestoneArtifactReminders(
  dir: string,
  milestones: Array<{ id: string; criterionIds: string[] }>,
  criterionState: Awaited<ReturnType<typeof loadCriterionState>>,
): Promise<MilestoneArtifactReminder[]> {
  const reminders: MilestoneArtifactReminder[] = [];
  for (const milestone of milestones) {
    if (milestone.criterionIds.length === 0) continue;
    const allPass = milestone.criterionIds.every((criterionId) =>
      criterionState.criteria[criterionId]?.outcome === "pass",
    );
    if (!allPass) continue;
    const captureDir = join(dir, "work", milestone.id, "evidence");
    if (!(await pathExists(captureDir))) {
      reminders.push({ milestoneId: milestone.id, reason: "no-artifact-capture" });
    }
  }
  return reminders;
}

function firstNonPassVal(
  milestones: Array<{ id: string; criterionIds: string[] }>,
  flatCriterionOrder: string[],
  uncoveredIds: ReadonlySet<string>,
): ReadyNextEntry[] {
  if (milestones.length > 0) {
    for (const milestone of milestones) {
      for (const criterionId of milestone.criterionIds) {
        if (uncoveredIds.has(criterionId)) {
          return [{ criterionId, milestoneId: milestone.id }];
        }
      }
    }
    return [];
  }

  for (const criterionId of flatCriterionOrder) {
    if (uncoveredIds.has(criterionId)) {
      return [{ criterionId, milestoneId: "" }];
    }
  }
  return [];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
