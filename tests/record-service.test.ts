import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvidence, verifyCriterion } from "../src/application/record-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-record-service-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("recordEvidence — because + recordedBy identity", () => {
  test("rejects manual evidence without a non-empty because, naming the criterionId", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000901";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Trust ordering probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [
          { id: "VAL-MAN-001", title: "Manual criterion", verifier: "manual" },
          { id: "VAL-CMD-001", title: "Command criterion", verifier: "command", command: "echo trust" },
        ],
      });

      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-MAN-001",
          outcome: "pass",
          summary: "looks good",
          source: "manual",
          now: "2026-05-15T03:00:00.000Z",
        }),
      ).rejects.toThrow(/VAL-MAN-001/);

      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-MAN-001",
          outcome: "pass",
          summary: "looks good",
          source: "manual",
          because: "   ",
          now: "2026-05-15T03:00:00.000Z",
        }),
      ).rejects.toThrow(/VAL-MAN-001/);
    });
  });

  test("manual evidence with because + recordedBy='agent:root' round-trips through criterion-state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000902";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Trust ordering probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-MAN-001", title: "Manual criterion", verifier: "manual" }],
      });

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-MAN-001",
        outcome: "pass",
        summary: "manual review pass",
        source: "manual",
        because: "stable rationale",
        now: "2026-05-15T03:00:00.000Z",
      });

      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.because).toBe("stable rationale");
      expect(stored.recordedBy).toBe("agent:root");
      expect(stored.source).toBe("manual");

      const criterionState = JSON.parse(
        await readFile(join(dir, "criterion-state.json"), "utf8"),
      );
      expect(criterionState.criteria["VAL-MAN-001"].recordedBy).toBe("agent:root");
      expect(criterionState.criteria["VAL-MAN-001"].because).toBe("stable rationale");
    });
  });

  test("verifyCriterion writes recordedBy='agent:root' on the synthesized command-result record", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000903";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Trust ordering probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-CMD-001", title: "Command criterion", verifier: "command", command: "echo trust" }],
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-CMD-001",
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.recordedBy).toBe("agent:root");
      expect(stored.source).toBe("verifier");
    });
  });
});
