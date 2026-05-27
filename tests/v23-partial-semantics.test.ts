import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { completeCharter, createCharter } from "../src/application/service";
import { handoff, readLatestHandoff, recordEvidence } from "../src/application/record-service";
import { charterDir, loadCharterState } from "../src/infrastructure/store";
import type { HandoffRecordInput } from "../src/persistence/handoff-store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v23-partial-"));
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

async function makeActiveCharter(projectDir: string, charterId = "cha-v23-partial"): Promise<string> {
  await createCharter(projectDir, {
    objective: "Exercise partial semantics",
    charterId,
    now: "2026-05-27T10:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Exercise partial semantics.",
      "",
      "## Criteria",
      "",
      "### VAL-PARTIAL-001 — First criterion passes",
      "Description: First validation target.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-PARTIAL-002 — Second criterion passes",
      "Description: Second validation target.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "## Scope and constraints",
      "",
      "- Keep the charter local to the test.",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-PARTIAL-001, VAL-PARTIAL-002]\npreconditions: []\n---\n\n# f1\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-27T10:05:00.000Z" });
  return dir;
}

async function recordPass(projectDir: string, charterId: string, criterionId: string, now: string): Promise<void> {
  await recordEvidence(projectDir, {
    charterId,
    criterionId,
    featureId: "f1",
    outcome: "pass",
    summary: `${criterionId} passed`,
    source: "subagent",
    recordedBy: "subagent:charter-reviewer:v23-pass",
    now,
  });
}

async function completeFeature(projectDir: string, charterId: string): Promise<void> {
  await recordPass(projectDir, charterId, "VAL-PARTIAL-001", "2026-05-27T10:10:00.000Z");
  await recordPass(projectDir, charterId, "VAL-PARTIAL-002", "2026-05-27T10:11:00.000Z");
}

function validHandoff(overrides: Partial<HandoffRecordInput> = {}): HandoffRecordInput {
  return {
    sessionId: "fixer-session-1",
    featureId: "f1",
    agent: "fixer",
    startedAt: "2026-05-27T10:20:00.000Z",
    completedAt: "2026-05-27T10:30:00.000Z",
    successState: "success",
    validatorsPassed: true,
    fulfills: ["VAL-PARTIAL-001", "VAL-PARTIAL-002"],
    whatWasImplemented: "Implemented enough of the feature for this test handoff record to exercise the resume context and status projection behavior.",
    whatWasLeftUndone: "",
    verification: {
      commandsRun: [
        { command: "bun test tests/v23-partial-semantics.test.ts", exitCode: 0, observation: "Targeted test command passed for the worker handoff." },
      ],
    },
    discoveredIssues: [],
    skillFeedback: {
      followedProcedure: true,
      deviations: [],
      suggestedChanges: [],
    },
    ...overrides,
  };
}

describe("v23 partial semantics", () => {
  test("evidence outcome=partial on a feature criterion reverts feature status to pending", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-evidence-partial";
      const dir = await makeActiveCharter(projectDir, charterId);
      await completeFeature(projectDir, charterId);

      let featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features.f1.status).toBe("completed");

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-PARTIAL-001",
        featureId: "f1",
        outcome: "partial",
        summary: "First criterion needs more work",
        because: "the validation only partially passed",
        now: "2026-05-27T10:12:00.000Z",
      });

      featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features.f1.status).toBe("pending");
      expect(featureState.features.f1.completedAt).toBeUndefined();
    });
  });

  test("handoff successState=failure reverts feature status to pending", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-handoff-failure";
      const dir = await makeActiveCharter(projectDir, charterId);
      await completeFeature(projectDir, charterId);

      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-failure-1",
          successState: "failure",
          validatorsPassed: false,
          completedAt: "2026-05-27T10:40:00.000Z",
          whatWasLeftUndone: "The worker found a blocking failure after the feature had previously been marked complete.",
        }),
      });

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features.f1.status).toBe("pending");
      expect(featureState.features.f1.completedAt).toBeUndefined();
      expect(featureState.features.f1.lastWorkerSessionId).toBe("fixer-failure-1");
    });
  });

  test("completion gate blocks when any VAL has outcome=partial", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-complete-partial";
      await makeActiveCharter(projectDir, charterId);
      await recordPass(projectDir, charterId, "VAL-PARTIAL-001", "2026-05-27T10:10:00.000Z");
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-PARTIAL-002",
        featureId: "f1",
        outcome: "partial",
        summary: "Second criterion is incomplete",
        because: "the validation only partially passed",
        now: "2026-05-27T10:11:00.000Z",
      });

      await expect(
        completeCharter(projectDir, { charterId, now: "2026-05-27T11:00:00.000Z" }),
      ).rejects.toThrow(/VAL-PARTIAL-002.*val-not-pass/i);
      const state = await loadCharterState(charterDir(projectDir, charterId));
      expect(state.status).toBe("active");
    });
  });

  test("completion gate blocks when any VAL has outcome=fail", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-complete-fail";
      await makeActiveCharter(projectDir, charterId);
      await recordPass(projectDir, charterId, "VAL-PARTIAL-001", "2026-05-27T10:10:00.000Z");
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-PARTIAL-002",
        featureId: "f1",
        outcome: "fail",
        summary: "Second criterion failed",
        because: "the validation failed outright",
        now: "2026-05-27T10:11:00.000Z",
      });

      await expect(
        completeCharter(projectDir, { charterId, now: "2026-05-27T11:00:00.000Z" }),
      ).rejects.toThrow(/VAL-PARTIAL-002.*val-not-pass/i);
    });
  });

  test("completion gate passes when all VALs have outcome=pass", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-complete-pass";
      await makeActiveCharter(projectDir, charterId);
      await completeFeature(projectDir, charterId);

      const result = await completeCharter(projectDir, { charterId, now: "2026-05-27T11:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });

  test("readLatestHandoff returns the most recent handoff sorted by completedAt desc", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-latest-handoff";
      await makeActiveCharter(projectDir, charterId);

      await handoff(projectDir, {
        charterId,
        ...validHandoff({ sessionId: "a-newer", completedAt: "2026-05-27T10:45:00.000Z" }),
      });
      await handoff(projectDir, {
        charterId,
        ...validHandoff({ sessionId: "z-older", completedAt: "2026-05-27T10:25:00.000Z" }),
      });

      const latest = await readLatestHandoff(projectDir, charterId, "f1");
      expect(latest?.sessionId).toBe("a-newer");
      expect(latest?.completedAt).toBe("2026-05-27T10:45:00.000Z");
    });
  });
});
