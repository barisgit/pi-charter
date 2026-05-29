import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvidence, recordEvidenceBatch } from "../src/application/record-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-batch-evidence-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const BATCH_CHARTER_CRITERIA = [
  { id: "VAL-A", title: "A", body: "First criterion." },
  { id: "VAL-B", title: "B", body: "Second criterion." },
  { id: "VAL-C", title: "C", body: "Third criterion." },
];

describe("recordEvidenceBatch — within-call atomicity", () => {
  test("happy path: 3 entries write 3 evidence files, populate criterion-state, preserve request order", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a1";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Batch evidence probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: BATCH_CHARTER_CRITERIA,
      });

      const response = await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", outcome: "pass", summary: "A done", because: "reviewed A" },
          { criterionId: "VAL-B", outcome: "pass", summary: "B done", because: "reviewed B" },
          { criterionId: "VAL-C", outcome: "partial", summary: "C partial", because: "still wip" },
        ],
      });

      expect(response.entries.length).toBe(3);
      expect(response.entries.map((entry) => entry.criterionId)).toEqual([
        "VAL-A",
        "VAL-B",
        "VAL-C",
      ]);

      const evidenceDir = join(dir, "work", "_charter", "evidence");
      const files = await readdir(evidenceDir);
      expect(files.length).toBe(3);
      for (const entry of response.entries) {
        const stored = JSON.parse(await readFile(join(dir, entry.path), "utf8"));
        expect(stored.criterionId).toBe(entry.criterionId);
        expect(stored.outcome).toBe(entry.outcome);
      }

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(Object.keys(criterionState.criteria).sort()).toEqual(["VAL-A", "VAL-B", "VAL-C"]);
      expect(criterionState.criteria["VAL-A"].outcome).toBe("pass");
      expect(criterionState.criteria["VAL-C"].outcome).toBe("partial");
      expect(criterionState.criteria["VAL-B"].because).toBe("reviewed B");
    });
  });

  test("all-or-nothing on validation failure: bad entry at slot 1 writes no files and leaves criterion-state unchanged", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a2";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Batch evidence probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: BATCH_CHARTER_CRITERIA,
      });

      const stateBefore = await readFile(join(dir, "criterion-state.json"), "utf8");
      const hashBefore = sha256(stateBefore);

      const entries = [
        { criterionId: "VAL-A", outcome: "pass" as const, summary: "A done", because: "reviewed" },
        { criterionId: "VAL-B", outcome: "pass" as const, summary: "   ", because: "reviewed" },
        { criterionId: "VAL-C", outcome: "pass" as const, summary: "C done", because: "reviewed" },
      ];

      await expect(
        recordEvidenceBatch(projectDir, {
          charterId,
          now: "2026-05-15T03:00:00.000Z",
          entries,
        }),
      ).rejects.toThrow(/entry 1/);

      const stateAfter = await readFile(join(dir, "criterion-state.json"), "utf8");
      expect(sha256(stateAfter)).toBe(hashBefore);

      const evidenceDir = join(dir, "work", "_charter", "evidence");
      const files = await readdir(evidenceDir).catch(() => [] as string[]);
      expect(files.length).toBe(0);
    });
  });

  test("backwards compat: single-entry recordEvidence still works and returns the same shape", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a3";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Batch evidence probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-A", title: "A" }],
      });

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-A",
        outcome: "pass",
        summary: "single entry path",
        because: "stable rationale",
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.charterId).toBe(charterId);
      expect(result.criterionId).toBe("VAL-A");
      expect(result.outcome).toBe("pass");
      expect(result.path).toBe(join("work", "_charter", "evidence", "2026-05-15T03-00-00-000Z", "evidence.json"));
      expect(result.ts).toBe("2026-05-15T03:00:00.000Z");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toBe("single entry path");
      expect(stored.because).toBe("stable rationale");
    });
  });

  test("mutual exclusion: evidenceFile and entries rejects with the documented message", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a4";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Batch evidence probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: [{ id: "VAL-B", title: "B" }],
      });

      const { registerCharterTools } = await import("../src/application/registration");
      const tools: Array<{ name: string; execute: Function }> = [];
      const fakePi: any = {
        registerTool(desc: any) {
          tools.push(desc);
        },
      };
      registerCharterTools(fakePi);
      const recordTool = tools.find((tool) => tool.name === "charter_record")!;
      const ctx: any = {
        cwd: projectDir,
        hasUI: false,
        ui: { notify() {} },
        sessionManager: { getSessionId: () => undefined },
      };
      await expect(
        recordTool.execute(
          "call-1",
          {
            action: "evidence",
            charterId,
            evidenceFile: "ignored.json",
            entries: [
              { criterionId: "VAL-B", outcome: "pass", summary: "batch", because: "y" },
            ],
          },
          undefined,
          () => {},
          ctx,
        ),
      ).rejects.toThrow(/provide either evidenceFile or entries, not both/);
    });
  });

  test("same-now stamp collision: 3 entries with identical now produce 3 distinct filenames", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a5";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Batch evidence probe",
        now: "2026-05-15T02:00:00.000Z",
        criteria: BATCH_CHARTER_CRITERIA,
      });

      const response = await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", outcome: "pass", summary: "A", because: "ra" },
          { criterionId: "VAL-B", outcome: "pass", summary: "B", because: "rb" },
          { criterionId: "VAL-C", outcome: "pass", summary: "C", because: "rc" },
        ],
      });

      const paths = response.entries.map((entry) => entry.path);
      expect(new Set(paths).size).toBe(3);

      const files = await readdir(join(dir, "work", "_charter", "evidence"));
      expect(new Set(files).size).toBe(3);
    });
  });
});
