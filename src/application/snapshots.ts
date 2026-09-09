import { appendEvent, charterDir, chartersRoot, hashText, listCharterIds, loadCharterState, loadCharterText, pathExists, writeCharterState, withCharterLock } from "../infrastructure/store";
import { parseCharterFile, type ParsedCharterFile } from "../domain/charter-file";
import type { CharterState } from "../domain/types";

export interface SnapshotRefreshResult {
  parsed: ParsedCharterFile;
  state: CharterState;
  changed: boolean;
}

export async function refreshCharterSnapshot(projectDir: string, charterId: string): Promise<SnapshotRefreshResult> {
  return withCharterLock(chartersRoot(projectDir), () => refreshCharterSnapshotUnlocked(projectDir, charterId));
}

// Caller must hold the project mutation lock.
export async function refreshCharterSnapshotUnlocked(projectDir: string, charterId: string): Promise<SnapshotRefreshResult> {
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const text = await loadCharterText(dir);
  const parsed = parseCharterFile(text);
  if (state.schemaVersion === "file-interface") return { parsed, state, changed: false };

  const hash = hashText(text);
  if (hash === state.snapshotHash) return { parsed, state, changed: false };
  const previousHash = state.snapshotHash;
  state.snapshotHash = hash;
  await appendEvent(dir, {
    type: "charter_file_changed",
    ts: new Date().toISOString(),
    charterId,
    previousHash,
    snapshotHash: hash,
  });
  await writeCharterState(dir, state);
  return { parsed, state, changed: true };
}

export async function refreshSessionSnapshots(projectDir: string, sessionId?: string): Promise<void> {
  if (!(await pathExists(chartersRoot(projectDir)))) return;
  await withCharterLock(chartersRoot(projectDir), async () => {
    for (const id of await listCharterIds(projectDir)) {
      const state = await loadCharterState(projectDir, id).catch(() => undefined);
      if (!state || state.schemaVersion === "file-interface") continue;
      if (state.status === "completed" || state.status === "abandoned") continue;
      if (sessionId && state.sessionId && state.sessionId !== sessionId) continue;
      await refreshCharterSnapshotUnlocked(projectDir, id);
    }
  });
}
