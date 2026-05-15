import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff } from "../src/application/record-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-handoff-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId = "cha-handoff-1") {
  const charterMd = [
    "# Charter cha-handoff-1",
    "",
    "## Objective",
    "Wire the auth flow.",
    "",
    "## Criteria",
    "",
    "### VAL-H-001 — Token exchange works",
    "Verifier: manual",
    "",
    "### VAL-H-002 — Tokens persist",
    "Verifier: manual",
    "",
    "## Scope and constraints",
    "",
    "- Stay inside auth module.",
    "",
  ].join("\n");
  const feature = (id: string, fulfills: string[]) =>
    [
      "---",
      `id: ${id}`,
      "milestone: m1",
      "order: 1",
      `fulfills: [${fulfills.join(", ")}]`,
      "preconditions: []",
      "---",
      "",
      `# ${id}`,
      "",
    ].join("\n");
  await createCharter(projectDir, { objective: "Wire auth", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1.md"), feature("f1", ["VAL-H-001"]), "utf8");
  await writeFile(join(dir, "plan", "f2.md"), feature("f2", ["VAL-H-002"]), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
}

describe("charter_record handoff_apply", () => {
  test("writes handoff envelope, applies evidence per criterion, and updates feature-state", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");

      const result = await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "sess_worker_42",
        handoffNote: "Worker completed token exchange.",
        completedCriteria: [
          {
            criterionId: "VAL-H-001",
            outcome: "pass",
            summary: "Token exchange returns access_token",
            artifacts: ["src/auth/callback.ts"],
            details: { reviewer: "self" },
          },
        ],
        now: "2026-05-15T02:00:00.000Z",
      });

      expect(result.charterId).toBe("cha-handoff-1");
      expect(result.featureId).toBe("f1");
      expect(result.handoffPath).toMatch(/handoffs\/.*__f1__sess_worker_42\.json$/);
      expect(result.appliedCount).toBe(1);

      const handoffDir = join(dir, "handoffs");
      const entries = await readdir(handoffDir);
      expect(entries.length).toBe(1);
      const envelope = JSON.parse(await readFile(join(handoffDir, entries[0]), "utf8"));
      expect(envelope.subagentSessionId).toBe("sess_worker_42");
      expect(envelope.handoffNote).toContain("token exchange");

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-H-001"].outcome).toBe("pass");
      expect(criterionState.criteria["VAL-H-001"].source).toBe("subagent");

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f1"].lastWorkerSessionId).toBe("sess_worker_42");
    });
  });

  test("rejects empty completedCriteria", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        applyHandoff(projectDir, {
          charterId: "cha-handoff-1",
          featureId: "f1",
          subagentSessionId: "sess",
          handoffNote: "nothing",
          completedCriteria: [],
          now: "2026-05-15T02:00:00.000Z",
        }),
      ).rejects.toThrow(/completedCriteria|at least one/i);
    });
  });

  test("rejects unknown criterion in completedCriteria", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        applyHandoff(projectDir, {
          charterId: "cha-handoff-1",
          featureId: "f1",
          subagentSessionId: "sess",
          handoffNote: "x",
          completedCriteria: [{ criterionId: "VAL-XYZ", outcome: "pass", summary: "bogus" }],
          now: "2026-05-15T02:00:00.000Z",
        }),
      ).rejects.toThrow(/unknown criterion/i);
    });
  });
});
