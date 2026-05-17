import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFeatureBatch, type FeatureEntry } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

/**
 * VAL-5: `add_feature` response preserves entry order. The response includes
 * a per-entry `{featureId, order, path}` triple matching the request indices
 * so callers can match results by index — independent of the entries'
 * `order` field, which sorts the rendered plan, not the response.
 */

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-batch-order-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function seedPlanningCharter(projectDir: string, charterId: string): Promise<void> {
  await createCharter(projectDir, {
    objective: "Batch order probe",
    charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Batch order probe",
      "## Criteria",
      "### VAL-O-001 cov",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("VAL-5 batch add_feature preserves request order", () => {
  test("5 entries with out-of-natural-order `order` values keep request order in response.features", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-batch-order";
      await seedPlanningCharter(projectDir, charterId);

      // Orders deliberately NOT monotonic. If the implementation accidentally
      // sorted by `order`, the response would come back as [10,20,30,40,50].
      const submitted: FeatureEntry[] = [
        { id: "f-fifty", milestone: "m1", order: 50, fulfills: ["VAL-O-001"], body: "fifty" },
        { id: "f-ten", milestone: "m1", order: 10, fulfills: ["VAL-O-001"], body: "ten" },
        { id: "f-thirty", milestone: "m1", order: 30, fulfills: ["VAL-O-001"], body: "thirty" },
        { id: "f-twenty", milestone: "m1", order: 20, fulfills: ["VAL-O-001"], body: "twenty" },
        { id: "f-forty", milestone: "m1", order: 40, fulfills: ["VAL-O-001"], body: "forty" },
      ];

      const result = await addFeatureBatch(projectDir, {
        charterId,
        features: submitted,
        now: "2026-05-15T00:10:00.000Z",
      });

      // Whole-array deep equality: response order MUST equal request order.
      expect(result.features.map((f) => f.featureId)).toEqual(submitted.map((e) => e.id));

      // Per-index shape: {featureId, order, path} matches each submitted entry.
      const planDir = join(charterDir(projectDir, charterId), "plan");
      expect(result.features).toEqual(submitted.map((entry) => ({
        featureId: entry.id,
        order: entry.order,
        path: join(planDir, `${entry.id}.md`),
      })));
    });
  });
});
