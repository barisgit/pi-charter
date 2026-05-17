import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence, verifyCriterion } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-record-service-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Trust ordering probe",
    charterId,
    now: "2026-05-15T02:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Trust ordering probe.",
      "",
      "## Criteria",
      "",
      "### VAL-MAN-001 — Manual criterion",
      "Description: Manual rationale required.",
      "Verifier: manual",
      "",
      "### VAL-CMD-001 — Command criterion",
      "Description: Command-verifier criterion.",
      "Verifier: command",
      "Command: echo trust",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-MAN-001\npreconditions: []\n---\n\n# F1\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "plan", "f2.md"),
    `---\nid: f2\nmilestone: m1\norder: 2\nfulfills:\n  - VAL-CMD-001\npreconditions: []\n---\n\n# F2\n`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z" });
  return dir;
}

describe("recordEvidence — because + recordedBy identity", () => {
  test("rejects manual evidence without a non-empty because, naming the criterionId", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000901";
      await makeActiveCharter(projectDir, charterId);

      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-MAN-001",
          featureId: "f1",
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
          featureId: "f1",
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
      const dir = await makeActiveCharter(projectDir, charterId);

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-MAN-001",
        featureId: "f1",
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
      const dir = await makeActiveCharter(projectDir, charterId);

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-CMD-001",
        featureId: "f2",
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.recordedBy).toBe("agent:root");
      expect(stored.source).toBe("verifier");
    });
  });
});
