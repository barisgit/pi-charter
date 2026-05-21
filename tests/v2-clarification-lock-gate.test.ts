import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCharter, createCharter, resumeCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { CharterToolError } from "../src/application/errors";
import { loadCharterState } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-clarification-lock-"));
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

async function seedLockablePlanningCharter(projectDir: string, charterId = "clarification-lock") {
  await createCharter(projectDir, {
    objective: "Clarification lock gate test",
    charterId,
    now: "2026-05-21T02:00:00.000Z",
  });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), [
    `# Charter ${charterId}`,
    "",
    "## Objective",
    "Clarification lock gate test.",
    "",
    "## Criteria",
    "",
    "### VAL-CLARIFICATION — Clarification criterion",
    "Verifier: manual",
    "Because: the test seeds a valid manual verifier rationale.",
    "",
    "## Scope and constraints",
    "",
    "- Keep it small.",
    "",
  ].join("\n"), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1.md"), [
    "---",
    "id: f1",
    "milestone: m1-clarification",
    "order: 1",
    "fulfills: [VAL-CLARIFICATION]",
    "preconditions: []",
    "---",
    "",
    "# Feature f1",
    "",
    VALIDATION_MD,
  ].join("\n"), "utf8");
}

async function expectCharterToolError(promise: Promise<unknown>): Promise<CharterToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CharterToolError);
    return err as CharterToolError;
  }
  throw new Error("Expected CharterToolError");
}

describe("v2 clarification lock gate", () => {
  test("fails when awaiting clarification before lock_plan", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "clarification-awaiting";
      await seedLockablePlanningCharter(projectDir, charterId);
      await askCharter(projectDir, {
        charterId,
        note: "Which path should we lock?",
        now: "2026-05-21T02:01:00.000Z",
      });

      const err = await expectCharterToolError(lockPlan(projectDir, { charterId, now: "2026-05-21T02:02:00.000Z" }));

      expect(err.code).toBe("lock_plan.awaiting_clarification");
    });
  });

  test("ask sets unansweredClarification flag", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "clarification-ask-flag";
      await seedLockablePlanningCharter(projectDir, charterId);

      await askCharter(projectDir, {
        charterId,
        note: "Which scope should ship?",
        now: "2026-05-21T02:01:00.000Z",
      });

      const state = await loadCharterState(projectDir, charterId);
      expect(state.unansweredClarification).toBe(true);
    });
  });

  test("resume with acknowledgement clears unansweredClarification and lock succeeds", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "clarification-resume-ack";
      await seedLockablePlanningCharter(projectDir, charterId);
      await askCharter(projectDir, {
        charterId,
        note: "Which scope should ship?",
        now: "2026-05-21T02:01:00.000Z",
      });

      await resumeCharter(projectDir, {
        charterId,
        acknowledgeClarification: true,
        now: "2026-05-21T02:02:00.000Z",
      });

      const state = await loadCharterState(projectDir, charterId);
      expect(state.status).toBe("planning");
      expect(state.unansweredClarification).toBe(false);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T02:03:00.000Z" });
      expect(result.status).toBe("active");
    });
  });

  test("fails with unansweredClarification true after resume without acknowledgement", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "clarification-flag-true";
      await seedLockablePlanningCharter(projectDir, charterId);
      await askCharter(projectDir, {
        charterId,
        note: "Which path should we lock?",
        now: "2026-05-21T02:01:00.000Z",
      });
      await resumeCharter(projectDir, { charterId, now: "2026-05-21T02:02:00.000Z" });

      const state = await loadCharterState(projectDir, charterId);
      expect(state.status).toBe("planning");
      expect(state.unansweredClarification).toBe(true);
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId, now: "2026-05-21T02:03:00.000Z" }));

      expect(err.code).toBe("lock_plan.unanswered_clarification");
    });
  });
});
