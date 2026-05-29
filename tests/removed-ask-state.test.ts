import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCharter, createCharter, resumeCharter } from "../src/application/service";
import { CharterToolError } from "../src/application/errors";
import { RALPH_SKIP_STATUSES } from "../src/application/ralph-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-ask-state-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("removed ask state", () => {
  test("ask throws ask.removed", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Clarify the charter plan",
        charterId: "ask-state-1",
        now: "2026-05-21T01:00:00.000Z",
      });
      let caught: unknown;
      try {
        await askCharter(projectDir, { charterId: created.charterId });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CharterToolError);
      expect((caught as CharterToolError).code).toBe("ask.removed");
    });
  });

  test("resume only works from paused", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Resume probe",
        charterId: "ask-state-resume",
        now: "2026-05-21T01:00:00.000Z",
      });
      let caught: unknown;
      try {
        await resumeCharter(projectDir, { charterId: created.charterId });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CharterToolError);
      expect((caught as CharterToolError).code).toBe("lifecycle.wrong_state");
    });
  });

  test("RALPH_SKIP_STATUSES excludes only completed, abandoned, paused", () => {
    expect(RALPH_SKIP_STATUSES.has("completed")).toBe(true);
    expect(RALPH_SKIP_STATUSES.has("abandoned")).toBe(true);
    expect(RALPH_SKIP_STATUSES.has("paused")).toBe(true);
    expect(RALPH_SKIP_STATUSES.has("active")).toBe(false);
  });
});
