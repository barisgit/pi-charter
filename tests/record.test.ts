import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pauseCharter } from "../src/application/service";
import { recordEvidence } from "../src/application/record-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-record-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("charter_record evidence", () => {
  test("writes an evidence record under the charter work directory and updates criterion-state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000301";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Implement OAuth callback",
        now: "2026-05-15T02:00:00.000Z",
        milestones: [{
          id: "m1-auth",
          criteria: [
            {
              id: "VAL-AUTH-001",
              title: "Callback validates state",
              body: "Invalid state is rejected.",
              verifier: "manual",
            },
            {
              id: "VAL-AUTH-002",
              title: "Tokens are persisted",
              body: "Tokens are stored.",
              verifier: "manual",
            },
          ],
        }],
      });

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-AUTH-001",
        outcome: "pass",
        summary: "bun test tests/auth.test.ts pass",
        because: "manual capture of bun test result",
        artifacts: ["tests/auth.test.ts"],
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.criterionId).toBe("VAL-AUTH-001");
      expect(result.outcome).toBe("pass");
      expect(result.path).toBe(join("work", "_charter", "evidence", "2026-05-15T03-00-00-000Z", "evidence.json"));

      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toBe("bun test tests/auth.test.ts pass");
      expect(stored.artifacts).toEqual(["tests/auth.test.ts"]);

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-AUTH-001"].outcome).toBe("pass");
      expect(criterionState.criteria["VAL-AUTH-001"].lastEvidencePath).toBe(result.path);
      expect(result.nextActions.length).toBeGreaterThan(0);
    });
  });

  test("rejects evidence for unknown criterion", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000302";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "OAuth callback",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-AUTH-001", title: "Callback validates state" }],
      });
      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-UNKNOWN-999",
          outcome: "pass",
          summary: "x",
          because: "probe",
        }),
      ).rejects.toThrow(/unknown criterion/i);
    });
  });

  test("rejects evidence when charter is paused", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000303";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "x",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-X-001", title: "X" }],
      });
      await pauseCharter(projectDir, { charterId, now: "2026-05-15T02:01:00.000Z" });
      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-X-001",
          outcome: "pass",
          summary: "x",
          because: "probe",
        }),
      ).rejects.toThrow(/paused|status/i);
    });
  });
});
