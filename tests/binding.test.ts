import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession, reconcileSessionBinding, rebindCharter, readSessionBinding } from "../src/application/binding-service";
import { createCharter } from "../src/application/service";

async function withTempProject<T>(fn: (projectDir: string, homeDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-bind-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-bind-home-"));
  try {
    return await fn(projectDir, homeDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe("charter session binding", () => {
  it("writes forward binding into state.json and reverse binding under home", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Bind charter to session",
        now: "2026-05-15T00:00:00.000Z",
      });

      await bindCharterToSession(projectDir, {
        charterId: charter.charterId,
        sessionId: "sess_main_001",
        homeDir,
      });

      const stateRaw = await readFile(
        join(projectDir, ".pi/charters", charter.charterId, "state.json"),
        "utf8",
      );
      expect(JSON.parse(stateRaw).sessionId).toBe("sess_main_001");

      const reverse = await readSessionBinding({ sessionId: "sess_main_001", homeDir });
      expect(reverse).toMatchObject({
        sessionId: "sess_main_001",
        charterId: charter.charterId,
        projectDir,
      });
    });
  });

  it("rebinds to a new session and updates reverse pointer", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Rebind on fork",
        now: "2026-05-15T00:00:00.000Z",
      });

      await bindCharterToSession(projectDir, {
        charterId: charter.charterId,
        sessionId: "sess_main_001",
        homeDir,
      });

      await rebindCharter(projectDir, {
        charterId: charter.charterId,
        sessionId: "sess_fork_002",
        homeDir,
      });

      const stateRaw = await readFile(
        join(projectDir, ".pi/charters", charter.charterId, "state.json"),
        "utf8",
      );
      expect(JSON.parse(stateRaw).sessionId).toBe("sess_fork_002");

      const newReverse = await readSessionBinding({ sessionId: "sess_fork_002", homeDir });
      expect(newReverse?.charterId).toBe(charter.charterId);

      const oldExists = await stat(join(homeDir, ".pi/agent/sessions/sess_main_001/charter.json")).then(
        () => true,
        () => false,
      );
      expect(oldExists).toBe(false);
    });
  });

  it("reconcileSessionBinding restores forward pointer from reverse if missing", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Reconcile after compaction",
        now: "2026-05-15T00:00:00.000Z",
      });

      await bindCharterToSession(projectDir, {
        charterId: charter.charterId,
        sessionId: "sess_main_009",
        homeDir,
      });

      // Simulate forward pointer being lost (e.g. partial restore from snapshot).
      const { unlink } = await import("node:fs/promises");
      const statePath = join(projectDir, ".pi/charters", charter.charterId, "state.json");
      const stateRaw = JSON.parse(await readFile(statePath, "utf8"));
      delete stateRaw.sessionId;
      await import("node:fs/promises").then((m) => m.writeFile(statePath, JSON.stringify(stateRaw, null, 2)));
      void unlink;

      const reconciled = await reconcileSessionBinding({
        sessionId: "sess_main_009",
        homeDir,
      });
      expect(reconciled).toMatchObject({ charterId: charter.charterId, projectDir });

      const fixed = JSON.parse(await readFile(statePath, "utf8"));
      expect(fixed.sessionId).toBe("sess_main_009");
    });
  });

  it("readSessionBinding returns null for unknown session", async () => {
    await withTempProject(async (_projectDir, homeDir) => {
      const result = await readSessionBinding({ sessionId: "sess_unknown_404", homeDir });
      expect(result).toBeNull();
    });
  });
});
