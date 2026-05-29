import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvidence, recordEvidenceBatch } from "../src/application/record-service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-record-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function criteriaSpecs() {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `VAL-R-${String(index).padStart(2, "0")}`,
    title: `Criterion ${index}`,
    because: `manual rationale ${index}`,
  }));
}

describe("concurrent record evidence", () => {
  test("parallel single recordEvidence calls preserve every criterion update", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-concurrent-record-single";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Concurrent record probe",
        now: "2026-05-15T00:00:00.000Z",
        criteria: criteriaSpecs(),
      });

      await Promise.all(Array.from({ length: 10 }, (_, index) => recordEvidence(projectDir, {
        charterId,
        criterionId: `VAL-R-${String(index).padStart(2, "0")}`,
        outcome: "pass",
        summary: `single ${index}`,
        because: `manual rationale ${index}`,
        now: `2026-05-15T01:00:${String(index).padStart(2, "0")}.000Z`,
      })));

      const state = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      for (let index = 0; index < 10; index += 1) {
        const id = `VAL-R-${String(index).padStart(2, "0")}`;
        expect(state.criteria[id]?.lastSummary).toBe(`single ${index}`);
      }
    });
  });

  test("parallel recordEvidenceBatch calls preserve every criterion update", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-concurrent-record-batch";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Concurrent record probe",
        now: "2026-05-15T00:00:00.000Z",
        criteria: criteriaSpecs(),
      });

      await Promise.all(Array.from({ length: 10 }, (_, index) => {
        const first = 10 + index * 2;
        return recordEvidenceBatch(projectDir, {
          charterId,
          now: `2026-05-15T02:00:${String(index).padStart(2, "0")}.000Z`,
          entries: [first, first + 1].map((criterionIndex) => ({
            criterionId: `VAL-R-${String(criterionIndex).padStart(2, "0")}`,
            outcome: "pass" as const,
            summary: `batch ${criterionIndex}`,
            because: `batch rationale ${criterionIndex}`,
          })),
        });
      }));

      const state = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      for (let index = 10; index < 30; index += 1) {
        const id = `VAL-R-${String(index).padStart(2, "0")}`;
        expect(state.criteria[id]?.lastSummary).toBe(`batch ${index}`);
      }
    });
  });
});
