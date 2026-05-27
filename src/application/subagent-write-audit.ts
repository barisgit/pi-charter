import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export const SUBAGENT_WRITE_RESTRICTION_MESSAGE =
  "Plan is managed by the orchestrator; report results via charter_record action=handoff or charter_record action=evidence.";

const MANAGED_CHARTER_FILES = [
  "feature-state.json",
  "criterion-state.json",
  "state.json",
  "charter.md",
  "criteria.md",
] as const;

interface WatchedFileState {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

export interface SubagentWriteAuditSnapshot {
  charterDir: string;
  files: Record<string, WatchedFileState>;
}

export interface ForbiddenSubagentWrite {
  path: string;
  relativePath: string;
  before: WatchedFileState;
  after: WatchedFileState;
}

export function forbiddenSubagentWritePaths(charterDir: string): string[] {
  return [
    join(charterDir, "plan"),
    ...MANAGED_CHARTER_FILES.map((file) => join(charterDir, file)),
  ];
}

export async function snapshotSubagentWriteAudit(charterDir: string): Promise<SubagentWriteAuditSnapshot> {
  const files: Record<string, WatchedFileState> = {};
  for (const path of await watchedFilePaths(charterDir)) {
    files[path] = await statWatchedFile(path);
  }
  return { charterDir, files };
}

export async function detectSubagentForbiddenWrites(snapshot: SubagentWriteAuditSnapshot): Promise<ForbiddenSubagentWrite[]> {
  const currentPaths = await watchedFilePaths(snapshot.charterDir);
  const paths = new Set([...Object.keys(snapshot.files), ...currentPaths]);
  const writes: ForbiddenSubagentWrite[] = [];
  for (const path of [...paths].sort()) {
    const before = snapshot.files[path] ?? { exists: false };
    const after = await statWatchedFile(path);
    if (fileStateChanged(before, after)) {
      writes.push({
        path,
        relativePath: relative(snapshot.charterDir, path),
        before,
        after,
      });
    }
  }
  return writes;
}

async function watchedFilePaths(charterDir: string): Promise<string[]> {
  return [
    ...MANAGED_CHARTER_FILES.map((file) => join(charterDir, file)),
    ...(await planMarkdownPaths(charterDir)),
  ];
}

async function planMarkdownPaths(charterDir: string): Promise<string[]> {
  const planDir = join(charterDir, "plan");
  try {
    const entries = await readdir(planDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(planDir, entry.name));
  } catch {
    return [];
  }
}

async function statWatchedFile(path: string): Promise<WatchedFileState> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return { exists: false };
    return { exists: true, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch {
    return { exists: false };
  }
}

function fileStateChanged(before: WatchedFileState, after: WatchedFileState): boolean {
  if (before.exists !== after.exists) return true;
  if (!before.exists || !after.exists) return false;
  return before.mtimeMs !== after.mtimeMs || before.size !== after.size;
}
