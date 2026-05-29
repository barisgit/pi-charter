import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCharterStatusText } from "../src/application/registration";
import { recordEvidence } from "../src/application/record-service";
import { getCharterStatus } from "../src/application/service";
import { computeDrift } from "../src/application/drift-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-status-evidence-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("status and evidence boundary", () => {
  test("recordEvidence stamps lastToolWriteAt on criterion-state.json", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c501";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Sidecar stamp probe",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [{ id: "VAL-STAMP", title: "Stamp probe", verifier: "manual" }],
      });
      const toolWriteAt = "2026-05-15T03:00:00.000Z";
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-STAMP",
        outcome: "pass",
        summary: "Evidence recorded",
        because: "fixture sign-off",
        now: toolWriteAt,
      });
      const state = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(state.lastToolWriteAt).toBe(toolWriteAt);
    });
  });

  test("sidecar drift surfaces when criterion-state.json is hand-edited after tool write", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c502";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Sidecar drift probe",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [{ id: "VAL-DRIFT", title: "Drift probe", verifier: "manual" }],
      });
      const toolWriteAt = "2026-05-15T03:00:00.000Z";
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-DRIFT",
        outcome: "pass",
        summary: "Baseline evidence",
        because: "fixture sign-off",
        now: toolWriteAt,
      });
      const sidecarPath = join(dir, "criterion-state.json");
      const later = new Date("2026-05-15T04:00:00.000Z");
      await utimes(sidecarPath, later, later);

      const drift = await computeDrift(projectDir, { charterId, now: later.getTime() });
      expect(drift.sidecarDrift).toContainEqual({
        path: "criterion-state.json",
        lastToolWriteAt: toolWriteAt,
        fileMtimeMs: later.getTime(),
      });

      const status = await getCharterStatus(projectDir, { charterId });
      const text = formatCharterStatusText(status);
      expect(text).toContain("sidecar-drift:");
      expect(text).toContain("criterion-state.json(edited out-of-band)");
    });
  });

  test("milestone artifact reminder when milestone VALs pass without work/<milestone>/evidence/", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c503";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Milestone artifact probe",
        now: "2026-05-15T00:00:00.000Z",
        milestones: [
          {
            id: "m5-status-cleanup",
            title: "Status cleanup",
            criteria: [{ id: "VAL-ARTIFACT", title: "Artifact reminder", verifier: "manual" }],
          },
        ],
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-ARTIFACT",
        outcome: "pass",
        summary: "Milestone VAL satisfied",
        because: "fixture sign-off",
        now: "2026-05-15T03:00:00.000Z",
      });

      const drift = await computeDrift(projectDir, { charterId });
      expect(drift.milestoneArtifacts).toEqual([
        { milestoneId: "m5-status-cleanup", reason: "no-artifact-capture" },
      ]);

      const status = await getCharterStatus(projectDir, { charterId });
      const text = formatCharterStatusText(status);
      expect(text).toContain("milestone-artifacts:");
      expect(text).toContain("m5-status-cleanup(no-artifact-capture)");
    });
  });

  test("requireFreshEvidence marks evidence stale after src/ change", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c504";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Src freshness probe",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [
          {
            id: "VAL-FRESH",
            title: "Fresh evidence",
            verifier: "manual",
            requireFreshEvidence: true,
          },
        ],
      });
      await mkdir(join(projectDir, "src"), { recursive: true });
      await writeFile(join(projectDir, "src", "index.ts"), "export {}\n", "utf8");
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-FRESH",
        outcome: "pass",
        summary: "Evidence before src edit",
        because: "fixture sign-off",
        now: "2026-05-15T01:00:00.000Z",
      });
      await writeFile(join(projectDir, "src", "index.ts"), "export const changed = true\n", "utf8");

      const drift = await computeDrift(projectDir, { charterId });
      expect(drift.stale).toEqual([
        expect.objectContaining({
          criterionId: "VAL-FRESH",
          reason: "src-change",
          lastTs: "2026-05-15T01:00:00.000Z",
        }),
      ]);
    });
  });
});
