import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCharter, getCharterStatus, pauseCharter, resumeCharter } from "../src/application/service";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-service-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("charter service", () => {
  test("create returns active state with legal next actions", async () => {
    await withTempProject(async (projectDir) => {
      const result = await createCharter(projectDir, {
        objective: "Implement M1 filesystem store",
        charterId: "00000000-0000-4000-8000-000000000101",
        now: "2026-05-15T01:00:00.000Z",
      });

      expect(result.status).toBe("active");
      expect(result.nextActions.map((a) => `${a.tool}:${a.action ?? ""}`)).toContain("charter_status:");
      expect(result.nextActions.some((a) => a.tool === "charter" && a.action === "pause")).toBe(true);

      const status = await getCharterStatus(projectDir, { charterId: result.charterId });
      expect(status.objective).toBe("Implement M1 filesystem store");
      expect(status.phase).toBe("active");
      expect(status.nextActions.length).toBeGreaterThan(0);
    });
  });

  test("pause and resume preserve previous status", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Pause test",
        charterId: "00000000-0000-4000-8000-000000000102",
        now: "2026-05-15T01:00:00.000Z",
      });

      const paused = await pauseCharter(projectDir, { charterId: created.charterId, now: "2026-05-15T01:01:00.000Z" });
      expect(paused.status).toBe("paused");
      expect(paused.nextActions.map((a) => `${a.tool}:${a.action}`)).toContain("charter:resume");

      const resumed = await resumeCharter(projectDir, { charterId: created.charterId, now: "2026-05-15T01:02:00.000Z" });
      expect(resumed.status).toBe("active");
    });
  });
});
