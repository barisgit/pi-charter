import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvidence } from "../src/application/record-service";

import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-evidence-dir-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function stamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

describe("evidence dir-per-run layout", () => {
  test("dir-per-run layout: writes evidence.json inside <ts> dir", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d201";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence dir-per-run probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [
          { id: "VAL-EVIDENCE-DIR-PER-RUN", title: "Evidence layout", verifier: "manual" },
          { id: "VAL-EVIDENCE-DIR-EDGE", title: "Evidence edge", verifier: "manual" },
        ],
      });
      const now = "2026-05-21T12:00:00.000Z";

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        outcome: "pass",
        summary: "dir-per-run evidence stored",
        because: "the writer returned a run-directory evidence path",
        now,
      });

      expect(result.path).toBe(join("work", "_charter", "evidence", stamp(now), "evidence.json"));
      const evidenceDirEntries = await readdir(join(dir, "work", "_charter", "evidence"));
      expect(evidenceDirEntries).toContain(stamp(now));
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.criterionId).toBe("VAL-EVIDENCE-DIR-PER-RUN");
      expect(stored.ts).toBe(now);
    });
  });

  test("same-now stamp collision: second write uses -1 suffix", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d202";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence dir-per-run probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [
          { id: "VAL-EVIDENCE-DIR-PER-RUN", title: "Evidence layout", verifier: "manual" },
          { id: "VAL-EVIDENCE-DIR-EDGE", title: "Evidence edge", verifier: "manual" },
        ],
      });
      const now = "2026-05-21T12:00:00.000Z";

      const first = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        outcome: "pass",
        summary: "first",
        because: "first write",
        now,
      });
      const second = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-EDGE",
        outcome: "pass",
        summary: "second",
        because: "second write at same timestamp",
        now,
      });

      expect(first.path).toBe(join("work", "_charter", "evidence", stamp(now), "evidence.json"));
      expect(second.path).toBe(join("work", "_charter", "evidence", `${stamp(now)}-1`, "evidence.json"));
      const entries = await readdir(join(dir, "work", "_charter", "evidence"));
      expect(entries.sort()).toEqual([stamp(now), `${stamp(now)}-1`].sort());
    });
  });

  test("criterion-state records lastEvidencePath for dir-per-run writes", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d203";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence dir-per-run probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [{ id: "VAL-EVIDENCE-DIR-PER-RUN", title: "Evidence layout", verifier: "manual" }],
      });
      const now = "2026-05-21T12:00:00.000Z";
      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        outcome: "pass",
        summary: "status probe",
        because: "status should list last evidence path",
        now,
      });

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-EVIDENCE-DIR-PER-RUN"].lastEvidencePath).toBe(result.path);
    });
  });
});
