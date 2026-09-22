import { appendEvent, charterDir, chartersRoot, hashText, listCharterIds, loadCharterState, loadCharterText, writeCharterState, withCharterLock } from "../infrastructure/store";
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
  if (!sessionId) return;
  const isRelevant = (state: CharterState | undefined): boolean =>
    state?.schemaVersion === "phases" && state.sessionId === sessionId &&
    (state.status === "active" || state.status === "paused");
  const candidates: string[] = [];
  for (const id of await listCharterIds(projectDir)) {
    const state = await loadCharterState(projectDir, id).catch(() => undefined);
    if (isRelevant(state)) candidates.push(id);
  }
  if (candidates.length === 0) return;

  await withCharterLock(chartersRoot(projectDir), async () => {
    for (const id of candidates) {
      // Binding and lifecycle may have changed while waiting for the lock.
      const state = await loadCharterState(projectDir, id).catch(() => undefined);
      if (!isRelevant(state)) continue;
      await refreshCharterSnapshotUnlocked(projectDir, id);
    }
  });
}
