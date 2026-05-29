import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCharterStatus } from "../src/application/service";
import { recordEvidence } from "../src/application/record-service";
import { formatCharterStatusText } from "../src/application/registration";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-status-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("getCharterStatus.details.blockingForComplete", () => {
  test("includes every VAL with low-trust evidence; renders single line", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-status-1";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Ship status surface",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [
          { id: "VAL-S-001", title: "First criterion", because: "author rationale 1" },
          { id: "VAL-S-002", title: "Second criterion", because: "author rationale 2" },
        ],
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-S-001",
        outcome: "pass",
        summary: "did it",
        because: "low-trust manual record",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-S-002",
        outcome: "pass",
        summary: "did it too",
        because: "another low-trust manual record",
        now: "2026-05-15T02:01:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.details).toBeDefined();
      expect(Array.isArray(status.details?.blockingForComplete)).toBe(true);
      expect(status.details!.blockingForComplete).toHaveLength(2);
      const ids = status.details!.blockingForComplete.map((row) => row.criterionId).sort();
      expect(ids).toEqual(["VAL-S-001", "VAL-S-002"]);
      for (const row of status.details!.blockingForComplete) {
        expect(typeof row.reason).toBe("string");
        expect(row.reason.length).toBeGreaterThan(0);
      }

      const text = formatCharterStatusText(status);
      const matchingLines = text.split("\n").filter((line) => line.includes("blocking-for-complete:"));
      expect(matchingLines).toHaveLength(1);
      const line = matchingLines[0];
      expect(line).toContain("blocking-for-complete: 2 VAL(s):");
      expect(line).toContain("VAL-S-001(");
      expect(line).toContain("VAL-S-002(");
    });
  });

  test("omits blocking-for-complete line entirely when array is empty", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-status-1";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Ship status surface",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [
          { id: "VAL-S-001", title: "First criterion" },
          { id: "VAL-S-002", title: "Second criterion" },
        ],
      });
      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.details?.blockingForComplete ?? []).toEqual([]);
      const text = formatCharterStatusText(status);
      expect(text).not.toContain("blocking-for-complete:");
    });
  });
});

describe("getCharterStatus empty-register signal", () => {
  test("an active charter with zero parsed criteria reports registerEmpty and renders a loud line", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-empty-1";
      // criteria: [] => criteria.md has the header but no VAL leaves => 0 parsed.
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Charter whose criteria never got authored",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [],
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.valTotal).toBe(0);
      expect(status.valPass).toBe(0);
      expect(status.registerEmpty).toBe(true);

      const text = formatCharterStatusText(status);
      expect(text).toContain("REGISTER EMPTY");
      // The healthy VAL totals line must NOT appear when the register is empty.
      expect(text).not.toContain("VAL totals:");
    });
  });

  test("a charter with parsed criteria reports totals and is not flagged empty", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-empty-2";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Charter with real criteria",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [
          { id: "VAL-E-001", title: "One", because: "r1" },
          { id: "VAL-E-002", title: "Two", because: "r2" },
        ],
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.valTotal).toBe(2);
      expect(status.valPass).toBe(0);
      expect(status.registerEmpty).toBe(false);

      const text = formatCharterStatusText(status);
      expect(text).toContain("VAL totals: 0/2 pass");
      expect(text).not.toContain("REGISTER EMPTY");
    });
  });

  test("counts ungrouped flat criteria mixed with milestone-grouped criteria", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-mixed-1";
      // makeActiveCharter renders milestones XOR flat; to exercise the mixed
      // register (a flat `## VAL-*` alongside a `## M1` group) we author
      // criteria.md directly. Old code summed only milestone buckets and would
      // report valTotal=1 here; the true parsed count is 2.
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Charter with a mixed flat + milestone register",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [],
      });
      const criteriaMd = [
        "# Criteria",
        "",
        "## VAL-FLAT-001 A flat ungrouped criterion",
        "Body.",
        "Verifier: manual",
        "Because: rationale",
        "",
        "## M1 First milestone",
        "",
        "### VAL-M1-001 Grouped criterion",
        "Body.",
        "Verifier: manual",
        "Because: rationale",
        "",
      ].join("\n");
      await writeFile(join(projectDir, ".pi", "charters", charterId, "criteria.md"), criteriaMd, "utf8");

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.valTotal).toBe(2);
      expect(status.valPass).toBe(0);
      expect(status.registerEmpty).toBe(false);
      const text = formatCharterStatusText(status);
      expect(text).toContain("VAL totals: 0/2 pass");
    });
  });
});
