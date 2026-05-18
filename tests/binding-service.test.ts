import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession, readSessionBinding, writeChildBinding } from "../src/application/binding-service";
import { createCharter } from "../src/application/service";

async function withTempProject<T>(fn: (projectDir: string, homeDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-bind-service-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-bind-service-home-"));
  try {
    return await fn(projectDir, homeDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

function statePath(projectDir: string, charterId: string): string {
  return join(projectDir, ".pi/charters", charterId, "state.json");
}

function reversePath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".pi/agent/sessions", sessionId, "charter.json");
}

describe("binding service roles", () => {
  it("round-trips participant role through writeChildBinding", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      await writeChildBinding({
        sessionId: "child_001",
        charterId: "charter_participant",
        projectDir,
        homeDir,
        role: "participant",
        boundAt: "2026-05-18T00:00:00.000Z",
      });

      const binding = await readSessionBinding({ sessionId: "child_001", homeDir });
      expect(binding?.role).toBe("participant");
    });
  });

  it("round-trips owner role by default through bindCharterToSession", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Bind owner session",
        now: "2026-05-18T00:00:00.000Z",
      });

      const written = await bindCharterToSession(projectDir, {
        charterId: charter.charterId,
        sessionId: "owner_001",
        homeDir,
        now: "2026-05-18T00:01:00.000Z",
      });
      const binding = await readSessionBinding({ sessionId: "owner_001", homeDir });

      expect(written.role).toBe("owner");
      expect(binding?.role).toBe("owner");
    });
  });

  it("coerces legacy on-disk records without role to owner", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const sessionId = "legacy_001";
      const path = reversePath(homeDir, sessionId);
      await mkdir(join(homeDir, ".pi/agent/sessions", sessionId), { recursive: true });
      await writeFile(
        path,
        JSON.stringify(
          {
            sessionId,
            charterId: "legacy_charter",
            projectDir,
            boundAt: "2026-05-18T00:00:00.000Z",
          },
          null,
          2,
        ),
      );

      const binding = await readSessionBinding({ sessionId, homeDir });
      expect(binding?.role).toBe("owner");
    });
  });

  it("writeChildBinding leaves root state.json forward pointer untouched", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Child binding only",
        now: "2026-05-18T00:00:00.000Z",
      });
      const before = JSON.parse(await readFile(statePath(projectDir, charter.charterId), "utf8"));

      await writeChildBinding({
        sessionId: "child_002",
        charterId: charter.charterId,
        projectDir,
        homeDir,
        boundAt: "2026-05-18T00:02:00.000Z",
      });

      const after = JSON.parse(await readFile(statePath(projectDir, charter.charterId), "utf8"));
      expect(after.sessionId).toBe(before.sessionId);
    });
  });

  it("bindCharterToSession still writes the forward pointer", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Forward pointer regression",
        now: "2026-05-18T00:00:00.000Z",
      });

      await bindCharterToSession(projectDir, {
        charterId: charter.charterId,
        sessionId: "owner_002",
        homeDir,
      });

      const state = JSON.parse(await readFile(statePath(projectDir, charter.charterId), "utf8"));
      expect(state.sessionId).toBe("owner_002");
    });
  });
});
