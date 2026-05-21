import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { formatCharterStatusText } from "../src/application/registration";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-status-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = [
  "## Validation",
  "",
  "### Happy",
  "- check: smoke-happy",
  "  command: true",
  "",
  "### Edge",
  "- check: smoke-edge",
  "  command: true",
  "",
].join("\n");

async function makeActiveCharter(projectDir: string, charterId = "cha-status-1") {
  const charterMd = [
    "# Charter cha-status-1",
    "",
    "## Objective",
    "Ship the status surface.",
    "",
    "## Criteria",
    "",
    "### VAL-S-001 — First criterion",
    "Verifier: manual",
    "Because: author rationale 1",
    "",
    "### VAL-S-002 — Second criterion",
    "Verifier: manual",
    "Because: author rationale 2",
    "",
    "## Scope and constraints",
    "",
    "- Stay within status module.",
    "",
  ].join("\n");
  const featureMd = (id: string, fulfills: string[]) =>
    [
      "---",
      `id: ${id}`,
      "milestone: m1-status",
      "order: 1",
      `fulfills: [${fulfills.join(", ")}]`,
      "preconditions: []",
      "---",
      "",
      `# Feature ${id}`,
      "",
      VALIDATION_MD,
    ].join("\n");
  await createCharter(projectDir, { objective: "Ship status surface", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1.md"), featureMd("f1", ["VAL-S-001"]), "utf8");
  await writeFile(join(dir, "plan", "f2.md"), featureMd("f2", ["VAL-S-002"]), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
}

describe("getCharterStatus.details.blockingForComplete", () => {
  test("includes every VAL with low-trust evidence; renders single line", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      // Both criteria pass-evidenced by agent:root manual + because → low trust.
      await recordEvidence(projectDir, {
        charterId: "cha-status-1",
        criterionId: "VAL-S-001",
        featureId: "f1",
        outcome: "pass",
        summary: "did it",
        because: "low-trust manual record",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: "cha-status-1",
        criterionId: "VAL-S-002",
        featureId: "f2",
        outcome: "pass",
        summary: "did it too",
        because: "another low-trust manual record",
        now: "2026-05-15T02:01:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId: "cha-status-1" });
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
      await makeActiveCharter(projectDir);
      // No evidence yet → array empty (criteria without ANY pass evidence are
      // not "blocking-for-complete" in the trust sense — they're plain
      // "no pass evidence" gaps surfaced by the original complete gate).
      const status = await getCharterStatus(projectDir, { charterId: "cha-status-1" });
      expect(status.details?.blockingForComplete ?? []).toEqual([]);
      const text = formatCharterStatusText(status);
      expect(text).not.toContain("blocking-for-complete:");
    });
  });
});
