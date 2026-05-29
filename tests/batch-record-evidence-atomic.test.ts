import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvidenceBatch } from "../src/application/record-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";
import * as fsPromises from "node:fs/promises";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-batch-evidence-atomic-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface RenameCounter {
  total: number;
  byDest: Map<string, number>;
  restore: () => void;
}

function installRenameCounter(): RenameCounter {
  const counter: RenameCounter = {
    total: 0,
    byDest: new Map<string, number>(),
    restore: () => {},
  };
  const original = fsPromises.rename.bind(fsPromises);
  const spy = spyOn(fsPromises, "rename").mockImplementation((async (oldPath: unknown, newPath: unknown) => {
    counter.total += 1;
    const key = typeof newPath === "string" ? newPath : String(newPath);
    counter.byDest.set(key, (counter.byDest.get(key) ?? 0) + 1);
    return original(oldPath as Parameters<typeof fsPromises.rename>[0], newPath as Parameters<typeof fsPromises.rename>[1]);
  }) as unknown as typeof fsPromises.rename);
  counter.restore = () => {
    spy.mockRestore();
  };
  return counter;
}

function countMatching(counter: RenameCounter, predicate: (path: string) => boolean): number {
  let total = 0;
  for (const [path, count] of counter.byDest) {
    if (predicate(path)) total += count;
  }
  return total;
}

describe("recordEvidenceBatch — single criterion-state write", () => {
  let installed: RenameCounter | undefined;
  afterEach(() => {
    installed?.restore();
    installed = undefined;
  });

  test("5 entries in ONE batch produce exactly ONE criterion-state.json write", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000b1";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Atomic batch probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [
          { id: "VAL-A", title: "A" },
          { id: "VAL-B", title: "B" },
          { id: "VAL-C", title: "C" },
          { id: "VAL-D", title: "D" },
          { id: "VAL-E", title: "E" },
        ],
      });

      installed = installRenameCounter();

      await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", outcome: "pass", summary: "A", because: "ra" },
          { criterionId: "VAL-B", outcome: "pass", summary: "B", because: "rb" },
          { criterionId: "VAL-C", outcome: "pass", summary: "C", because: "rc" },
          { criterionId: "VAL-D", outcome: "pass", summary: "D", because: "rd" },
          { criterionId: "VAL-E", outcome: "pass", summary: "E", because: "re" },
        ],
      });

      const criterionStatePath = join(dir, "criterion-state.json");
      const criterionStateWrites = installed.byDest.get(criterionStatePath) ?? 0;
      expect(criterionStateWrites).toBe(1);

      const evidenceWrites = countMatching(installed, (path) => /\/work\/.+\/evidence\/[^/]+\/evidence\.json$/.test(path));
      expect(evidenceWrites).toBe(5);
    });
  });
});
