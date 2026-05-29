import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { recordEvidence } from "../src/application/record-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-drift-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId = "cha-drift-1") {
  const criteriaMd = [
    "# Criteria",
    "",
    "## m1-auth Auth module",
    "",
    "### VAL-D-001 — Callback works",
    "Verifier: manual",
    "Because: test fixture rationale",
    "",
    "### VAL-D-002 — Tokens persisted",
    "Verifier: manual",
    "Because: test fixture rationale",
    "Require fresh evidence: true",
    "",
    "### VAL-D-003 — Logging",
    "Verifier: manual",
    "Because: test fixture rationale",
    "",
  ].join("\n");
  await createCharter(projectDir, { objective: "Ship auth", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "criteria.md"), criteriaMd, "utf8");
  await mkdir(join(projectDir, "src"), { recursive: true });
  await writeFile(join(projectDir, "src", "index.ts"), "export {}\n", "utf8");
}

describe("charter_status drift views", () => {
  test("reports uncovered criteria, readyNext VAL, and stale fresh-evidence criteria", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: "cha-drift-1",
        criterionId: "VAL-D-002",
        outcome: "pass",
        summary: "tokens persisted before src change",
        because: "manual sign-off before src edit",
        now: "2026-05-15T01:00:00.000Z",
      });
      await writeFile(join(projectDir, "src", "index.ts"), "export const changed = true\n", "utf8");
      const status = await getCharterStatus(projectDir, { charterId: "cha-drift-1" });
      const uncoveredIds = status.drift.uncovered.map((entry) => entry.criterionId);
      expect(uncoveredIds).toContain("VAL-D-001");
      expect(uncoveredIds).toContain("VAL-D-003");
      expect(uncoveredIds).not.toContain("VAL-D-002");
      const staleIds = status.drift.stale.map((entry) => entry.criterionId);
      expect(staleIds).toContain("VAL-D-002");
      expect(status.drift.readyNext).toEqual([{ criterionId: "VAL-D-001", milestoneId: "m1-auth" }]);
    });
  });
});
