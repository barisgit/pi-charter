import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartersRoot, createCharterWorkspace, loadCharterIndex } from "../src/infrastructure/store";

describe("concurrent createCharterWorkspace -> index.json", () => {
  test("parallel createCharterWorkspace calls preserve every row in index.json", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-index-"));
    try {
      const n = 8;
      const charterIds = Array.from({ length: n }, (_, index) => `cha-concurrent-index-${String(index).padStart(2, "0")}`);

      await Promise.all(
        charterIds.map((charterId, index) =>
          createCharterWorkspace(projectDir, {
            charterId,
            objective: `Concurrent index probe ${index}`,
            now: `2026-05-15T00:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        ),
      );

      const indexPath = join(chartersRoot(projectDir), "index.json");
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as { charters: Array<{ charterId: string }> };
      expect(Array.isArray(parsed.charters)).toBe(true);
      expect(parsed.charters).toHaveLength(n);

      const seen = new Set(parsed.charters.map((row) => row.charterId));
      for (const charterId of charterIds) {
        expect(seen.has(charterId)).toBe(true);
      }

      // Sanity: typed loader should agree with the raw file.
      const loaded = await loadCharterIndex(projectDir);
      expect(loaded).toHaveLength(n);
      const loadedIds = new Set(loaded.map((row) => row.charterId));
      for (const charterId of charterIds) {
        expect(loadedIds.has(charterId)).toBe(true);
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
