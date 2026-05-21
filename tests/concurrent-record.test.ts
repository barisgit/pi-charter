import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence, recordEvidenceBatch } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-record-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, { objective: "Concurrent record probe", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = charterDir(projectDir, charterId);
  const criteria = Array.from({ length: 30 }, (_, index) => {
    const id = `VAL-R-${String(index).padStart(2, "0")}`;
    return [`### ${id} — Criterion ${index}`, `Description: Criterion ${index}.`, "Verifier: manual", ""].join("\n");
  });
  await writeFile(
    join(dir, "charter.md"),
    ["# Charter", "", "## Objective", "", "Concurrent record probe.", "", "## Criteria", "", ...criteria].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n${Array.from({ length: 30 }, (_, index) => `  - VAL-R-${String(index).padStart(2, "0")}`).join("\n")}\npreconditions: []\n---\n\n# F1\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T00:30:00.000Z", legacy: true });
  return dir;
}

describe("concurrent record evidence", () => {
  test("parallel single recordEvidence calls preserve every criterion update", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-concurrent-record-single";
      const dir = await makeActiveCharter(projectDir, charterId);

      await Promise.all(Array.from({ length: 10 }, (_, index) => recordEvidence(projectDir, {
        charterId,
        criterionId: `VAL-R-${String(index).padStart(2, "0")}`,
        featureId: "f1",
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
      const dir = await makeActiveCharter(projectDir, charterId);

      await Promise.all(Array.from({ length: 10 }, (_, index) => {
        const first = 10 + index * 2;
        return recordEvidenceBatch(projectDir, {
          charterId,
          now: `2026-05-15T02:00:${String(index).padStart(2, "0")}.000Z`,
          entries: [first, first + 1].map((criterionIndex) => ({
            criterionId: `VAL-R-${String(criterionIndex).padStart(2, "0")}`,
            featureId: "f1",
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
