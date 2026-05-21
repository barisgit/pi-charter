import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff, recordEvidence } from "../src/application/record-service";
import {
  buildEvaluatorContext,
  buildEvaluatorPrompt,
  readEvaluatorLog,
  reminderFromEntry,
  runEvaluator,
  type EvaluatorAssessment,
  type EvaluatorEntry,
  type EvaluatorModelFn,
} from "../src/application/evaluator-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-eval-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
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

async function makeActiveCharter(projectDir: string): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Ship evaluator",
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", charter.charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nShip evaluator\n## Criteria\n### VAL-EVAL-001 — happy path\nVerifier: manual\n### VAL-EVAL-002 — drift\nVerifier: manual\n## Scope and constraints\n- none\n`,
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-EVAL-001]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
  );
  await writeFile(
    join(dir, "plan/f2.md"),
    `---\nid: f2\nmilestone: m1\norder: 2\nfulfills: [VAL-EVAL-002]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
  );
  await lockPlan(projectDir, { charterId: charter.charterId, legacy: true });
  return charter.charterId;
}

async function makePlanningCharter(projectDir: string, input: { criteria: string; feature?: string }): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Plan evaluator",
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", charter.charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nPlan evaluator\n## Criteria\n${input.criteria}\n## Scope and constraints\n- none\n`,
  );
  if (input.feature) {
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFile(join(dir, "plan/f1.md"), input.feature);
  }
  return charter.charterId;
}

function fakeModel(assessment: EvaluatorAssessment): EvaluatorModelFn {
  return async () => assessment;
}

function countingModel(assessment: EvaluatorAssessment): { model: EvaluatorModelFn; calls: () => number } {
  let callCount = 0;
  return {
    calls: () => callCount,
    model: async () => {
      callCount += 1;
      return assessment;
    },
  };
}

describe("charter evaluator", () => {
  it("skips the model in planning when no criteria exist", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makePlanningCharter(projectDir, { criteria: "" });
      const { model, calls } = countingModel({
        verdict: "drifting",
        confidence: 0.7,
        reason: "should not run",
        steerReminder: "should not run",
        cites: [],
      });

      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T00:30:00.000Z",
      });

      expect(calls()).toBe(0);
      expect(entry.verdict).toBe("on_track");
      expect(entry.steerReminder).toBeUndefined();
    });
  });

  it("skips the model in planning when criteria exist but no features or evidence exist", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makePlanningCharter(projectDir, {
        criteria: "### VAL-PLAN-001 — planned\nVerifier: manual\n",
      });
      const { model, calls } = countingModel({
        verdict: "drifting",
        confidence: 0.7,
        reason: "should not run",
        steerReminder: "should not run",
        cites: [],
      });

      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T00:30:00.000Z",
      });

      expect(calls()).toBe(0);
      expect(entry.verdict).toBe("on_track");
      expect(entry.steerReminder).toBeUndefined();
    });
  });

  it("still evaluates planning charters once criteria and features exist", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makePlanningCharter(projectDir, {
        criteria: "### VAL-PLAN-001 — planned\nVerifier: manual\n",
        feature: `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-PLAN-001]\npreconditions: []\n---\nbody\n`,
      });
      const { model, calls } = countingModel({
        verdict: "drifting",
        confidence: 0.8,
        reason: "VAL-PLAN-001 needs lock_plan",
        steerReminder: "Run charter_plan lock_plan.",
        cites: [{ criterionId: "VAL-PLAN-001" }, { featureId: "f1" }],
      });

      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T00:30:00.000Z",
      });

      expect(calls()).toBe(1);
      expect(entry.verdict).toBe("drifting");
      expect(entry.steerReminder).toBe("Run charter_plan lock_plan.");
    });
  });

  it("builds a context with criteria + drift snapshot", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVAL-001",
        outcome: "pass",
        summary: "passed",
        because: "manual confirmation for evaluator probe",
        now: "2026-05-15T01:00:00.000Z",
      });
      const ctx = await buildEvaluatorContext(projectDir, charterId, {
        recentUserMessages: ["please continue"],
        recentToolNames: ["charter_status", "charter_record"],
      });
      expect(ctx.objective).toBe("Ship evaluator");
      expect(ctx.status).toBe("active");
      expect(ctx.criteria.map((c) => c.id)).toEqual(["VAL-EVAL-001", "VAL-EVAL-002"]);
      expect(ctx.criteria.find((c) => c.id === "VAL-EVAL-001")?.outcome).toBe("pass");
      expect(ctx.drift.uncovered.map((u) => u.criterionId)).toContain("VAL-EVAL-002");
      expect(ctx.recentUserMessages).toEqual(["please continue"]);
    });
  });

  it("persists verdict in evaluator-log.jsonl and truncates to last 10", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);

      const model = fakeModel({
        verdict: "drifting",
        confidence: 0.7,
        reason: "VAL-EVAL-002 still uncovered",
        steerReminder: "Pick f2 next; it fulfils VAL-EVAL-002.",
        cites: [{ criterionId: "VAL-EVAL-002" }, { featureId: "f2" }],
      });

      // Run 12 times to verify truncation.
      for (let i = 0; i < 12; i++) {
        await runEvaluator(projectDir, {
          charterId,
          trigger: "turn_end",
          modelFn: model,
          now: `2026-05-15T0${i % 9}:00:00.000Z`,
        });
      }

      const log = await readEvaluatorLog(projectDir, charterId);
      expect(log).toHaveLength(10);
      const raw = await readFile(
        join(projectDir, ".pi/charters", charterId, "evaluator-log.jsonl"),
        "utf8",
      );
      expect(raw.split(/\r?\n/).filter(Boolean)).toHaveLength(10);
    });
  });

  it("never marks the charter complete", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const model = fakeModel({
        verdict: "ready_to_complete",
        confidence: 0.95,
        reason: "looks shippable",
        steerReminder: "Call charter_manage:complete after running verifiers.",
        cites: [],
      });
      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T02:00:00.000Z",
      });
      // The evaluator can ONLY recommend; the charter status must not move.
      const stateRaw = JSON.parse(
        await readFile(join(projectDir, ".pi/charters", charterId, "state.json"), "utf8"),
      );
      expect(stateRaw.status).toBe("active");
      expect(entry.verdict).toBe("ready_to_complete");
    });
  });

  it("reminderFromEntry omits text when on_track with no steer", () => {
    const entry: EvaluatorEntry = {
      ts: "2026-05-15T00:00:00.000Z",
      charterId: "c1",
      trigger: "turn_end",
      verdict: "on_track",
      confidence: 0.9,
      reason: "fine",
      cites: [],
    };
    expect(reminderFromEntry(entry)).toBeUndefined();
  });

  it("reminderFromEntry surfaces drift steer text with cites", () => {
    const entry: EvaluatorEntry = {
      ts: "2026-05-15T00:00:00.000Z",
      charterId: "c1",
      trigger: "turn_end",
      verdict: "drifting",
      confidence: 0.7,
      reason: "VAL-EVAL-002 uncovered",
      steerReminder: "Pick f2 next.",
      cites: [{ criterionId: "VAL-EVAL-002" }, { featureId: "f2" }],
    };
    const text = reminderFromEntry(entry);
    expect(text).toContain("drifting");
    expect(text).toContain("VAL-EVAL-002 uncovered");
    expect(text).toContain("Pick f2 next.");
    expect(text).toContain("VAL-EVAL-002, f2");
  });

  it("buildEvaluatorPrompt includes the schema and the cite rule", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const ctx = await buildEvaluatorContext(projectDir, charterId);
      const prompt = buildEvaluatorPrompt(ctx);
      expect(prompt).toContain('"verdict"');
      expect(prompt).toContain("ready_to_complete");
      expect(prompt).toContain("Cite an id from");
      expect(prompt).toContain("VAL-EVAL-001");
    });
  });

  it("steer text contains unreviewed milestoneId; disappears after charter-reviewer review (VAL-11)", async () => {
    await withTempProject(async (projectDir) => {
      // Fresh fixture so the milestone id is a unique greppable token.
      const MILESTONE = "m1-eval-review-signal";
      const charter = await createCharter(projectDir, {
        objective: "Evaluator milestone steer",
        now: "2026-05-15T00:00:00.000Z",
      });
      const dir = join(projectDir, ".pi/charters", charter.charterId);
      await writeFile(
        join(dir, "charter.md"),
        `# Charter\n## Objective\nSteer\n## Criteria\n### VAL-EVAL-301 — a\nVerifier: manual\n### VAL-EVAL-302 — b\nVerifier: manual\n## Scope and constraints\n- none\n`,
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(
        join(dir, "plan/f1.md"),
        `---\nid: f1\nmilestone: ${MILESTONE}\norder: 1\nfulfills: [VAL-EVAL-301]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
      );
      await writeFile(
        join(dir, "plan/f2.md"),
        `---\nid: f2\nmilestone: ${MILESTONE}\norder: 2\nfulfills: [VAL-EVAL-302]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
      );
      await lockPlan(projectDir, { charterId: charter.charterId, legacy: true });
      await recordEvidence(projectDir, {
        charterId: charter.charterId,
        criterionId: "VAL-EVAL-301",
        featureId: "f1",
        outcome: "pass",
        summary: "f1 done",
        because: "manual sign-off f1",
        recordedBy: "agent:root",
        now: "2026-05-15T01:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: charter.charterId,
        criterionId: "VAL-EVAL-302",
        featureId: "f2",
        outcome: "pass",
        summary: "f2 done",
        because: "manual sign-off f2",
        recordedBy: "agent:root",
        now: "2026-05-15T01:01:00.000Z",
      });

      // Model that returns a steer omitting the milestone id; the renderer
      // must inject the deterministic `(milestone: <id>)` suffix.
      const model = fakeModel({
        verdict: "drifting",
        confidence: 0.7,
        reason: "keep moving",
        steerReminder: "Continue with the next feature.",
        cites: [],
      });
      const entry = await runEvaluator(projectDir, {
        charterId: charter.charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T01:30:00.000Z",
      });
      const text = reminderFromEntry(entry) ?? "";
      expect(text).toContain(MILESTONE);

      await applyHandoff(projectDir, {
        charterId: charter.charterId,
        featureId: "f1",
        subagentSessionId: "charter-reviewer-eval-1",
        handoffNote: "reviewed both VALs",
        completedCriteria: [
          { criterionId: "VAL-EVAL-301", outcome: "pass", summary: "reviewed 301" },
          { criterionId: "VAL-EVAL-302", outcome: "pass", summary: "reviewed 302" },
        ],
        now: "2026-05-15T02:00:00.000Z",
      });
      const entry2 = await runEvaluator(projectDir, {
        charterId: charter.charterId,
        trigger: "turn_end",
        modelFn: model,
        now: "2026-05-15T02:30:00.000Z",
      });
      const text2 = reminderFromEntry(entry2) ?? "";
      expect(text2).not.toContain(MILESTONE);
    });
  });
});
