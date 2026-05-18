import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession, readSessionBinding, writeChildBinding } from "../src/application/binding-service";
import { autoBindChildSession } from "../src/application/registration";
import { createCharter, forceCompleteCharter } from "../src/application/service";

async function withTempProject<T>(fn: (projectDir: string, homeDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-auto-bind-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-auto-bind-home-"));
  try {
    return await fn(projectDir, homeDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function createRootBinding(projectDir: string, homeDir: string, rootSid = "root1") {
  const charter = await createCharter(projectDir, {
    objective: "Auto-bind child sessions",
    now: "2026-05-18T00:00:00.000Z",
  });
  await bindCharterToSession(projectDir, {
    charterId: charter.charterId,
    sessionId: rootSid,
    homeDir,
    now: "2026-05-18T00:01:00.000Z",
  });
  return charter;
}

function statePath(projectDir: string, charterId: string): string {
  return join(projectDir, ".pi/charters", charterId, "state.json");
}

let previousRootSid: string | undefined;
let previousForkSid: string | undefined;

beforeEach(() => {
  previousRootSid = process.env.PI_SUBAGENT_ROOT_SESSION_ID;
  previousForkSid = process.env.PI_SUBAGENT_FORK_SESSION_ID;
  delete process.env.PI_SUBAGENT_ROOT_SESSION_ID;
  delete process.env.PI_SUBAGENT_FORK_SESSION_ID;
});

afterEach(() => {
  if (previousRootSid === undefined) delete process.env.PI_SUBAGENT_ROOT_SESSION_ID;
  else process.env.PI_SUBAGENT_ROOT_SESSION_ID = previousRootSid;
  if (previousForkSid === undefined) delete process.env.PI_SUBAGENT_FORK_SESSION_ID;
  else process.env.PI_SUBAGENT_FORK_SESSION_ID = previousForkSid;
});

describe("child session auto-bind", () => {
  it("writes a participant binding from the root binding", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createRootBinding(projectDir, homeDir);
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root1";

      await autoBindChildSession({ currentSid: "child1", homeDir });

      const child = await readSessionBinding({ sessionId: "child1", homeDir });
      expect(child).toMatchObject({
        sessionId: "child1",
        charterId: charter.charterId,
        projectDir,
        role: "participant",
      });
    });
  });

  it("does not write without a root env var", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      await createRootBinding(projectDir, homeDir);

      const result = await autoBindChildSession({ currentSid: "child1", homeDir });

      expect(result).toBeNull();
      expect(await readSessionBinding({ sessionId: "child1", homeDir })).toBeNull();
    });
  });

  it("does not write or throw for an unknown root sessionId", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      await createRootBinding(projectDir, homeDir);
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "nope";

      await expect(autoBindChildSession({ currentSid: "child1", homeDir })).resolves.toBeNull();
      expect(await readSessionBinding({ sessionId: "child1", homeDir })).toBeNull();
    });
  });

  it("does not self-bind when the root env var equals the current sessionId", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      await createRootBinding(projectDir, homeDir);
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "child1";

      const result = await autoBindChildSession({ currentSid: "child1", homeDir });

      expect(result).toBeNull();
      expect(await readSessionBinding({ sessionId: "child1", homeDir })).toBeNull();
    });
  });

  it("does not write for fork sessions", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      await createRootBinding(projectDir, homeDir);
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root1";
      process.env.PI_SUBAGENT_FORK_SESSION_ID = "child1";

      const result = await autoBindChildSession({ currentSid: "child1", homeDir });

      expect(result).toBeNull();
      expect(await readSessionBinding({ sessionId: "child1", homeDir })).toBeNull();
    });
  });

  it("preserves an existing owner binding", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createRootBinding(projectDir, homeDir);
      await writeChildBinding({
        sessionId: "child1",
        charterId: charter.charterId,
        projectDir,
        role: "owner",
        homeDir,
        boundAt: "2026-05-18T00:02:00.000Z",
      });
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root1";

      const result = await autoBindChildSession({ currentSid: "child1", homeDir });

      expect(result).toBeNull();
      const child = await readSessionBinding({ sessionId: "child1", homeDir });
      expect(child).toMatchObject({
        sessionId: "child1",
        charterId: charter.charterId,
        projectDir,
        role: "owner",
        boundAt: "2026-05-18T00:02:00.000Z",
      });
    });
  });

  it("skips when the root binding's charter is terminal", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createRootBinding(projectDir, homeDir);
      await forceCompleteCharter(projectDir, {
        charterId: charter.charterId,
        target: "abandoned",
        reason: "test",
        now: "2026-05-18T00:03:00.000Z",
      });
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root1";

      const result = await autoBindChildSession({ currentSid: "child1", homeDir });

      expect(result).toBeNull();
      expect(await readSessionBinding({ sessionId: "child1", homeDir })).toBeNull();
    });
  });

  it("leaves the root forward pointer unchanged after auto-bind", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      const charter = await createRootBinding(projectDir, homeDir);
      process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root1";

      await autoBindChildSession({ currentSid: "child1", homeDir });

      const state = JSON.parse(await readFile(statePath(projectDir, charter.charterId), "utf8"));
      expect(state.sessionId).toBe("root1");
    });
  });
});
