import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureState, writeFeatureCheckState } from "../src/persistence/feature-state";

async function withTempCharter<T>(fn: (dir: string, charterId: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-charter-v2-feature-state-"));
  const charterId = "cha-v2-feature-state";
  const dir = join(root, ".pi", "charters", charterId);
  try {
    await mkdir(dir, { recursive: true });
    return await fn(dir, charterId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface RenameCounter {
  byDest: Map<string, number>;
  tempToDest: Array<{ tempPath: string; destPath: string }>;
  restore: () => void;
}

function installRenameCounter(): RenameCounter {
  const counter: RenameCounter = {
    byDest: new Map<string, number>(),
    tempToDest: [],
    restore: () => {},
  };
  const original = fsPromises.rename.bind(fsPromises);
  const spy = spyOn(fsPromises, "rename").mockImplementation((async (oldPath: unknown, newPath: unknown) => {
    const tempPath = typeof oldPath === "string" ? oldPath : String(oldPath);
    const destPath = typeof newPath === "string" ? newPath : String(newPath);
    counter.byDest.set(destPath, (counter.byDest.get(destPath) ?? 0) + 1);
    counter.tempToDest.push({ tempPath, destPath });
    return original(oldPath as Parameters<typeof fsPromises.rename>[0], newPath as Parameters<typeof fsPromises.rename>[1]);
  }) as unknown as typeof fsPromises.rename);
  counter.restore = () => {
    spy.mockRestore();
  };
  return counter;
}

let installed: RenameCounter | undefined;

afterEach(() => {
  installed?.restore();
  installed = undefined;
});

describe("v2 feature-state schema", () => {
  test("happy: write+read per-check status round-trips", async () => {
    await withTempCharter(async (dir, charterId) => {
      await writeFeatureCheckState(dir, charterId, "f1", "nests-checks-under-feature", {
        status: "passing",
        lastEvidenceTs: "2026-05-21T01:00:00.000Z",
        rounds: 2,
      });

      const state = await loadFeatureState(dir, charterId);

      expect(state.features.f1.checks["nests-checks-under-feature"]).toEqual({
        status: "passing",
        lastEvidenceTs: "2026-05-21T01:00:00.000Z",
        rounds: 2,
      });
    });
  });

  test("back-compat: old feature-state.json without checks loads", async () => {
    await withTempCharter(async (dir, charterId) => {
      await writeFile(
        join(dir, "feature-state.json"),
        `${JSON.stringify({
          charterId,
          features: {
            f1: { status: "in_progress", startedAt: "2026-05-21T00:00:00.000Z" },
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const state = await loadFeatureState(dir, charterId);

      expect(state.features.f1.status).toBe("in_progress");
      expect(state.features.f1.startedAt).toBe("2026-05-21T00:00:00.000Z");
      expect(state.features.f1.checks).toEqual({});
    });
  });

  test("atomic-write: feature-state writes use temp-file then rename", async () => {
    await withTempCharter(async (dir, charterId) => {
      installed = installRenameCounter();
      const featureStatePath = join(dir, "feature-state.json");

      await Promise.all([
        writeFeatureCheckState(dir, charterId, "f1", "happy", { status: "passing", lastEvidenceTs: "2026-05-21T01:00:00.000Z" }),
        writeFeatureCheckState(dir, charterId, "f1", "edge", { status: "failing", lastEvidenceTs: "2026-05-21T01:01:00.000Z", lastError: "boom" }),
      ]);

      const writes = installed.byDest.get(featureStatePath) ?? 0;
      expect(writes).toBe(2);
      expect(installed.tempToDest.every((entry) => entry.destPath === featureStatePath)).toBe(true);
      expect(installed.tempToDest.every((entry) => entry.tempPath.endsWith(".tmp"))).toBe(true);

      const state = await loadFeatureState(dir, charterId);
      expect(state.features.f1.checks.happy.status).toBe("passing");
      expect(state.features.f1.checks.edge.status).toBe("failing");
    });
  });

  test("multiple-features: per-check state is scoped per feature id", async () => {
    await withTempCharter(async (dir, charterId) => {
      await writeFeatureCheckState(dir, charterId, "f1", "same-check", { status: "passing", lastEvidenceTs: "2026-05-21T01:00:00.000Z" });
      await writeFeatureCheckState(dir, charterId, "f2", "same-check", { status: "failing", lastEvidenceTs: "2026-05-21T01:05:00.000Z", lastError: "exit 1" });

      const state = await loadFeatureState(dir, charterId);

      expect(state.features.f1.checks["same-check"]).toEqual({
        status: "passing",
        lastEvidenceTs: "2026-05-21T01:00:00.000Z",
      });
      expect(state.features.f2.checks["same-check"]).toEqual({
        status: "failing",
        lastEvidenceTs: "2026-05-21T01:05:00.000Z",
        lastError: "exit 1",
      });
    });
  });
});
