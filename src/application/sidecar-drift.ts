import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CriterionStateFile } from "../application/record-service";
import type { CharterState } from "../domain/types";

export interface SidecarDriftEntry {
  path: "state.json" | "criterion-state.json";
  lastToolWriteAt: string;
  fileMtimeMs: number;
}

const SIDECAR_FILES = ["state.json", "criterion-state.json"] as const;

export async function computeSidecarDrift(
  dir: string,
  state: CharterState,
  criterionState: CriterionStateFile,
): Promise<SidecarDriftEntry[]> {
  const drift: SidecarDriftEntry[] = [];
  const entries: Array<{ path: SidecarDriftEntry["path"]; lastToolWriteAt?: string }> = [
    { path: "state.json", lastToolWriteAt: state.lastToolWriteAt },
    { path: "criterion-state.json", lastToolWriteAt: criterionState.lastToolWriteAt },
  ];

  for (const entry of entries) {
    if (!entry.lastToolWriteAt) continue;
    const lastMs = Date.parse(entry.lastToolWriteAt);
    if (!Number.isFinite(lastMs)) continue;
    let fileStat;
    try {
      fileStat = await stat(join(dir, entry.path));
    } catch {
      continue;
    }
    if (fileStat.mtimeMs > lastMs) {
      drift.push({
        path: entry.path,
        lastToolWriteAt: entry.lastToolWriteAt,
        fileMtimeMs: fileStat.mtimeMs,
      });
    }
  }
  return drift;
}
