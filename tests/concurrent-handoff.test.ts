import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-handoff-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, { objective: "Concurrent handoff probe", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = charterDir(projectDir, charterId);
  const ids = Array.from({ length: 13 }, (_, index) => `VAL-H-${String(index).padStart(2, "0")}`);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Concurrent handoff probe.",
      "",
      "## Criteria",
      "",
      ...ids.map((id, index) => [`### ${id} — Criterion ${index}`, `Description: Criterion ${index}.`, "Verifier: manual", ""].join("\n")),
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n${ids.map((id) => `  - ${id}`).join("\n")}\npreconditions: []\n---\n\n# F1\n`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T00:30:00.000Z", legacy: true });
  return dir;
}

describe("concurrent applyHandoff", () => {
  test("parallel multi-criterion handoffs preserve all criteria and reviewer handoffs preserve implementer session", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-concurrent-handoff";
      const dir = await makeActiveCharter(projectDir, charterId);

      await applyHandoff(projectDir, {
        charterId,
        featureId: "f1",
        subagentSessionId: "worker-implementer-1",
        handoffNote: "Implementer seeded the feature.",
        completedCriteria: [{ criterionId: "VAL-H-00", outcome: "pass", summary: "implemented 0" }],
        now: "2026-05-15T01:00:00.000Z",
      });

      await Promise.all(Array.from({ length: 6 }, (_, index) => {
        const first = 1 + index * 2;
        return applyHandoff(projectDir, {
          charterId,
          featureId: "f1",
          subagentSessionId: `charter-verifier-${index}`,
          handoffNote: `Verifier reviewed pair ${index}.`,
          completedCriteria: [first, first + 1].map((criterionIndex) => ({
            criterionId: `VAL-H-${String(criterionIndex).padStart(2, "0")}`,
            outcome: "pass" as const,
            summary: `reviewed ${criterionIndex}`,
          })),
          now: `2026-05-15T01:01:${String(index).padStart(2, "0")}.000Z`,
        });
      }));

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      for (let index = 0; index < 13; index += 1) {
        const id = `VAL-H-${String(index).padStart(2, "0")}`;
        expect(criterionState.criteria[id]?.outcome).toBe("pass");
        expect(criterionState.criteria[id]?.source).toBe("subagent");
      }

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features.f1.status).toBe("completed");
      expect(featureState.features.f1.lastWorkerSessionId).toBe("worker-implementer-1");
    });
  });
});
