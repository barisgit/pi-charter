import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Latest mtime across all files under `<projectDir>/src`. Returns undefined when
 * `src/` is absent or empty — callers treat that as "no src freshness baseline".
 */
export async function lastSrcChangeMs(projectDir: string): Promise<number | undefined> {
  const srcDir = join(projectDir, "src");
  let max = 0;
  let found = false;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      found = true;
      const fileStat = await stat(path);
      if (fileStat.mtimeMs > max) max = fileStat.mtimeMs;
    }
  }

  await walk(srcDir);
  return found ? max : undefined;
}

export function isEvidenceStaleForSrcChange(lastTs: string, srcChangeMs: number | undefined): boolean {
  if (srcChangeMs === undefined) return false;
  const evidenceMs = Date.parse(lastTs);
  if (!Number.isFinite(evidenceMs)) return true;
  return evidenceMs < srcChangeMs;
}
