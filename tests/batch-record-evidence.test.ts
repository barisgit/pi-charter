import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence, recordEvidenceBatch } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-batch-evidence-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Batch evidence probe",
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
      "Batch evidence probe.",
      "",
      "## Criteria",
      "",
      "### VAL-A — A",
      "Description: First criterion.",
      "Verifier: manual",
      "",
      "### VAL-B — B",
      "Description: Second criterion.",
      "Verifier: manual",
      "",
      "### VAL-C — C",
      "Description: Third criterion.",
      "Verifier: manual",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "fa.md"),
    `---\nid: fa\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-A\n  - VAL-B\n  - VAL-C\npreconditions: []\n---\n\n# FA\n`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z", legacy: true });
  return dir;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("recordEvidenceBatch — VAL-6 within-call atomicity", () => {
  test("happy path: 3 entries write 3 evidence files, populate criterion-state, preserve request order", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a1";
      const dir = await makeActiveCharter(projectDir, charterId);

      const response = await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", featureId: "fa", outcome: "pass", summary: "A done", because: "reviewed A" },
          { criterionId: "VAL-B", featureId: "fa", outcome: "pass", summary: "B done", because: "reviewed B" },
          { criterionId: "VAL-C", featureId: "fa", outcome: "partial", summary: "C partial", because: "still wip" },
        ],
      });

      expect(response.entries.length).toBe(3);
      expect(response.entries.map((entry) => entry.criterionId)).toEqual([
        "VAL-A",
        "VAL-B",
        "VAL-C",
      ]);

      const evidenceDir = join(dir, "work", "fa", "evidence");
      const files = await readdir(evidenceDir);
      expect(files.length).toBe(3);
      // Each response.path must exist on disk.
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
      const dir = await makeActiveCharter(projectDir, charterId);

      const stateBefore = await readFile(join(dir, "criterion-state.json"), "utf8");
      const hashBefore = sha256(stateBefore);

      const entries = [
        { criterionId: "VAL-A", featureId: "fa", outcome: "pass" as const, summary: "A done", because: "reviewed" },
        // Slot 1 — missing summary.
        { criterionId: "VAL-B", featureId: "fa", outcome: "pass" as const, summary: "   ", because: "reviewed" },
        { criterionId: "VAL-C", featureId: "fa", outcome: "pass" as const, summary: "C done", because: "reviewed" },
      ];

      await expect(
        recordEvidenceBatch(projectDir, {
          charterId,
          now: "2026-05-15T03:00:00.000Z",
          entries,
        }),
      ).rejects.toThrow(/entry 1/);

      // criterion-state.json unchanged.
      const stateAfter = await readFile(join(dir, "criterion-state.json"), "utf8");
      expect(sha256(stateAfter)).toBe(hashBefore);

      // No evidence files written for any of the three criteria.
      const evidenceDir = join(dir, "work", "fa", "evidence");
      const files = await readdir(evidenceDir).catch(() => [] as string[]);
      expect(files.length).toBe(0);
    });
  });

  test("backwards compat: single-entry recordEvidence still works and returns the same shape", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a3";
      const dir = await makeActiveCharter(projectDir, charterId);

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-A",
        featureId: "fa",
        outcome: "pass",
        summary: "single entry path",
        because: "stable rationale",
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.charterId).toBe(charterId);
      expect(result.criterionId).toBe("VAL-A");
      expect(result.outcome).toBe("pass");
      expect(result.path).toContain("work/fa/evidence/VAL-A__");
      expect(result.ts).toBe("2026-05-15T03:00:00.000Z");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toBe("single entry path");
      expect(stored.because).toBe("stable rationale");
    });
  });

  test("mutual exclusion: both criterionId and entries rejects with the documented message", async () => {
    // Exercised through the registration handler surface. Reach into the
    // execute function directly via the registered tool descriptor.
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a4";
      await makeActiveCharter(projectDir, charterId);

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
            criterionId: "VAL-A",
            outcome: "pass",
            summary: "single",
            because: "x",
            entries: [
              { criterionId: "VAL-B", outcome: "pass", summary: "batch", because: "y" },
            ],
          },
          undefined,
          () => {},
          ctx,
        ),
      ).rejects.toThrow(/provide either single-entry fields or a batch `entries` array, not both/);
    });
  });

  test("same-now stamp collision: 3 entries with identical now produce 3 distinct filenames", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000a5";
      const dir = await makeActiveCharter(projectDir, charterId);

      const response = await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", featureId: "fa", outcome: "pass", summary: "A", because: "ra" },
          { criterionId: "VAL-B", featureId: "fa", outcome: "pass", summary: "B", because: "rb" },
          { criterionId: "VAL-C", featureId: "fa", outcome: "pass", summary: "C", because: "rc" },
        ],
      });

      const paths = response.entries.map((entry) => entry.path);
      const unique = new Set(paths);
      expect(unique.size).toBe(3);

      const files = await readdir(join(dir, "work", "fa", "evidence"));
      expect(new Set(files).size).toBe(3);
    });
  });
});
