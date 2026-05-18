import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { loadCriterionState } from "../src/application/record-service";
import { amendCharter, createCharter, forceCompleteCharter, getCharterStatus } from "../src/application/service";
import { charterDir, loadCharterState, writeCharterState } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-amend-active-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const FEATURE_MD = [
  "---",
  "id: f1-active",
  "milestone: m1",
  "order: 1",
  "fulfills: [VAL-ACTIVE-001]",
  "preconditions: []",
  "---",
  "",
  "# Active amend feature",
  "",
].join("\n");

const CHARTER_MD = [
  "# Charter",
  "",
  "## Objective",
  "Exercise amend from active.",
  "",
  "## Criteria",
  "",
  "### VAL-ACTIVE-001 Active amend works",
  "Verifier: manual",
  "Because: deterministic service-level test is sufficient",
  "",
  "## Scope and constraints",
  "",
  "- Keep amend side effects bounded.",
  "",
].join("\n");

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Exercise amend from active",
    charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), CHARTER_MD, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1-active.md"), FEATURE_MD, "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
  return dir;
}

async function makeReviewCharter(projectDir: string, charterId: string): Promise<string> {
  const dir = await makeActiveCharter(projectDir, charterId);
  await forceCompleteCharter(projectDir, {
    charterId,
    reason: "done",
    target: "completed",
    now: "2026-05-15T02:00:00.000Z",
  });
  await amendCharter(projectDir, {
    charterId,
    reason: "review reopened",
    target: "review",
    now: "2026-05-15T03:00:00.000Z",
  });
  return dir;
}

function hasNextAction(result: { nextActions: Array<{ tool: string; action?: string }> }, tool: string, action: string): boolean {
  return result.nextActions.some((nextAction) => nextAction.tool === tool && nextAction.action === action);
}

async function expectCharterToolError(promise: Promise<unknown>): Promise<CharterToolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof CharterToolError)) {
    throw new Error(`expected CharterToolError, got ${caught === undefined ? "no throw" : String(caught)}`);
  }
  return caught;
}

async function snapshotPlanFiles(dir: string): Promise<Record<string, string>> {
  const planDir = join(dir, "plan");
  const entries = (await readdir(planDir)).sort();
  const out: Record<string, string> = {};
  for (const entry of entries) out[entry] = await readFile(join(planDir, entry), "utf8");
  return out;
}

function parseEvents(raw: string): Array<Record<string, unknown>> {
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("amendCharter active/review -> planning", () => {
  test("active -> planning succeeds and returns planning nextActions", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-active-success";
      const dir = await makeActiveCharter(projectDir, charterId);
      const state = await loadCharterState(dir);
      state.completedAt = "2026-05-14T00:00:00.000Z";
      state.terminatedAt = "2026-05-14T01:00:00.000Z";
      state.completionReason = "historical note";
      await writeCharterState(dir, state);

      const result = await amendCharter(projectDir, {
        charterId,
        reason: "planning gap found",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      expect(result.status).toBe("planning");
      expect(hasNextAction(result, "charter_plan", "view")).toBe(true);
      expect(hasNextAction(result, "charter_plan", "lock_plan")).toBe(true);
      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.phase).toBe("planning");
      const updated = await loadCharterState(dir);
      expect(updated.status).toBe("planning");
      expect(updated.updatedAt).toBe("2026-05-15T04:00:00.000Z");
      expect(updated.completedAt).toBe("2026-05-14T00:00:00.000Z");
      expect(updated.terminatedAt).toBe("2026-05-14T01:00:00.000Z");
      expect(updated.completionReason).toBe("historical note");
    });
  });

  test("review -> planning succeeds", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-review-success";
      const dir = await makeReviewCharter(projectDir, charterId);

      const result = await amendCharter(projectDir, {
        charterId,
        reason: "review found missing planning",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      expect(result.status).toBe("planning");
      expect(hasNextAction(result, "charter_plan", "view")).toBe(true);
      expect(hasNextAction(result, "charter_plan", "lock_plan")).toBe(true);
      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.phase).toBe("planning");
      expect((await loadCharterState(dir)).status).toBe("planning");
    });
  });

  test("state sidecars and plan files are preserved byte-for-byte", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-preserve";
      const dir = await makeActiveCharter(projectDir, charterId);
      await writeFile(join(dir, "criterion-state.json"), `${JSON.stringify({
        charterId,
        criteria: {
          "VAL-ACTIVE-001": {
            outcome: "pass",
            lastEvidencePath: "work/f1/evidence/e.json",
            lastTs: "2026-05-15T01:30:00.000Z",
            lastSummary: "seeded",
            lastFeatureId: "f1-active",
          },
        },
      }, null, 2)}\n`, "utf8");
      await writeFile(join(dir, "feature-state.json"), `${JSON.stringify({
        charterId,
        features: {
          "f1-active": { status: "completed", completedAt: "2026-05-15T01:30:00.000Z" },
        },
      }, null, 2)}\n`, "utf8");
      await writeFile(join(dir, "evaluator-log.jsonl"), "{\"ts\":\"2026-05-15T01:45:00.000Z\",\"verdict\":\"on_track\"}\n", "utf8");
      const beforeCriterion = await readFile(join(dir, "criterion-state.json"), "utf8");
      const beforeFeature = await readFile(join(dir, "feature-state.json"), "utf8");
      const beforeEvaluator = await readFile(join(dir, "evaluator-log.jsonl"), "utf8");
      const beforePlan = await snapshotPlanFiles(dir);

      await amendCharter(projectDir, {
        charterId,
        reason: "preserve sidecars",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      expect(await readFile(join(dir, "criterion-state.json"), "utf8")).toBe(beforeCriterion);
      expect(await readFile(join(dir, "feature-state.json"), "utf8")).toBe(beforeFeature);
      expect(await readFile(join(dir, "evaluator-log.jsonl"), "utf8")).toBe(beforeEvaluator);
      expect(await snapshotPlanFiles(dir)).toEqual(beforePlan);
    });
  });

  test("event log appends an audit entry with from and to states", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-event";
      const dir = await makeActiveCharter(projectDir, charterId);
      const beforeEvents = await readFile(join(dir, "events.jsonl"), "utf8");

      await amendCharter(projectDir, {
        charterId,
        reason: "audit trail",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      const afterEvents = await readFile(join(dir, "events.jsonl"), "utf8");
      expect(afterEvents.startsWith(beforeEvents)).toBe(true);
      const events = parseEvents(afterEvents);
      expect(events.at(-1)).toMatchObject({
        type: "charter_amended",
        ts: "2026-05-15T04:00:00.000Z",
        charterId,
        from: "active",
        to: "planning",
        reason: "audit trail",
      });
    });
  });

  test("orphan criteria are tolerated and not auto-cleaned", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-orphan";
      const dir = await makeActiveCharter(projectDir, charterId);
      await writeFile(join(dir, "criterion-state.json"), `${JSON.stringify({
        charterId,
        criteria: {
          "VAL-GHOST": {
            outcome: "pass",
            lastEvidencePath: "work/f1/evidence/ghost.json",
            lastTs: "2026-05-15T01:30:00.000Z",
            lastSummary: "ghost evidence",
          },
        },
      }, null, 2)}\n`, "utf8");

      await amendCharter(projectDir, {
        charterId,
        reason: "replan without ghost criterion",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      const criterionState = await loadCriterionState(dir, charterId);
      expect(criterionState.criteria["VAL-GHOST"]?.lastSummary).toBe("ghost evidence");
      await writeFile(join(dir, "charter.md"), CHARTER_MD, "utf8");
      await lockPlan(projectDir, { charterId, now: "2026-05-15T05:00:00.000Z" });
      expect((await loadCharterState(dir)).status).toBe("active");
    });
  });

  test("target='review' from active still errors", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-active-review-error";
      await makeActiveCharter(projectDir, charterId);

      const error = await expectCharterToolError(amendCharter(projectDir, {
        charterId,
        reason: "bad source",
        target: "review",
        now: "2026-05-15T04:00:00.000Z",
      }));

      expect(error.code).toBe("amend.invalid_source_state");
      expect(error.message).toContain("active");
      expect(error.message).toContain("completed");
    });
  });

  test("planning -> planning still errors", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-planning-error";
      await createCharter(projectDir, {
        objective: "already planning",
        charterId,
        now: "2026-05-15T00:00:00.000Z",
      });

      const error = await expectCharterToolError(amendCharter(projectDir, {
        charterId,
        reason: "no-op",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      }));

      expect(error.code).toBe("amend.invalid_source_state");
      expect(error.message).toContain("planning");
    });
  });

  test("terminal -> planning still works", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-terminal-planning";
      const dir = await makeActiveCharter(projectDir, charterId);
      await forceCompleteCharter(projectDir, {
        charterId,
        reason: "done",
        target: "completed",
        now: "2026-05-15T02:00:00.000Z",
      });

      const result = await amendCharter(projectDir, {
        charterId,
        reason: "new planning needed",
        target: "planning",
        now: "2026-05-15T04:00:00.000Z",
      });

      expect(result.status).toBe("planning");
      const state = await loadCharterState(dir);
      expect(state.status).toBe("planning");
      expect(state.completedAt).toBeUndefined();
      expect(state.terminatedAt).toBeUndefined();
      expect(state.completionReason).toBeUndefined();
    });
  });
});
