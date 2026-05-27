import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFeature, lockPlan } from "../src/application/plan-service";
import { handoff, recordEvidence } from "../src/application/record-service";
import { registerCharterTools } from "../src/application/registration";
import { amendCharter, completeCharter, createCharter } from "../src/application/service";
import { charterDir, loadCharterState, writeCharterState } from "../src/infrastructure/store";
import type { HandoffRecordInput } from "../src/persistence/handoff-store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v23-triage-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = `## Validation

### Happy
- check: triage-gate-happy
  command: true

### Edge
- check: triage-gate-edge
  command: true
`;

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Gate completion on handoff triage",
    charterId,
    now: "2026-05-27T12:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Gate completion on handoff triage.",
      "",
      "## Criteria",
      "",
      "### VAL-TRIAGE-001 — Main feature passes",
      "Description: The main feature has enough evidence to complete once handoff leftovers are triaged.",
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
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-TRIAGE-001]\npreconditions: []\n---\n\n# f1\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-27T12:05:00.000Z" });
  await recordEvidence(projectDir, {
    charterId,
    criterionId: "VAL-TRIAGE-001",
    featureId: "f1",
    outcome: "pass",
    summary: "main feature passed",
    source: "subagent",
    recordedBy: "subagent:charter-reviewer:reviewer-triage-1",
    now: "2026-05-27T12:10:00.000Z",
  });
  return dir;
}

function validHandoff(overrides: Partial<HandoffRecordInput> = {}): HandoffRecordInput {
  return {
    sessionId: "fixer-triage-1",
    featureId: "f1",
    agent: "fixer",
    startedAt: "2026-05-27T12:20:00.000Z",
    completedAt: "2026-05-27T12:30:00.000Z",
    successState: "success",
    validatorsPassed: true,
    fulfills: ["VAL-TRIAGE-001"],
    whatWasImplemented: "Implemented enough of the charter feature for this test to exercise the completion triage gate and handoff scanning path.",
    whatWasLeftUndone: "",
    verification: {
      commandsRun: [
        { command: "bun test tests/v23-triage-gate.test.ts", exitCode: 0, observation: "Targeted triage gate tests passed." },
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

async function expectCompleteBlocked(projectDir: string, charterId: string): Promise<Error> {
  let caught: unknown;
  try {
    await completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" });
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) throw new Error("expected completeCharter to throw");
  return caught;
}

async function callManage(projectDir: string, params: Record<string, unknown>): Promise<unknown> {
  const tools: Array<{ name: string; execute: Function }> = [];
  const fakePi: any = {
    registerTool(desc: any) {
      tools.push(desc);
    },
  };
  registerCharterTools(fakePi);
  const manageTool = tools.find((tool) => tool.name === "charter_manage")!;
  const ctx: any = {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => undefined },
  };
  return await manageTool.execute("call-1", params, new AbortController().signal, () => {}, ctx);
}

describe("v2.3 handoff triage completion gate", () => {
  test("complete blocks when a handoff has non-empty whatWasLeftUndone and no triage entry covers it", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-left-undone";
      await makeActiveCharter(projectDir, charterId);
      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-left-undone-1",
          whatWasLeftUndone: "Wire the dashboard follow-up after this charter completes.",
        }),
      });

      const error = await expectCompleteBlocked(projectDir, charterId);
      expect(error.message).toContain("untriaged-handoff-items");
      expect(error.message).toContain(join("work", "f1", "handoffs", "fixer-left-undone-1.handoff.json"));
      expect(error.message).toContain("Wire the dashboard follow-up");
    });
  });

  test("complete blocks when a handoff has a blocking untriaged discovered issue", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-blocking-issue";
      await makeActiveCharter(projectDir, charterId);
      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-blocking-issue-1",
          discoveredIssues: [
            {
              severity: "blocking",
              kind: "discovered_issue",
              description: "A blocking production follow-up needs a scoped owner.",
              triageState: "untriaged",
            },
          ],
        }),
      });

      const error = await expectCompleteBlocked(projectDir, charterId);
      expect(error.message).toContain("untriaged-handoff-items");
      expect(error.message).toContain("discoveredIssues[0]");
      expect(error.message).toContain("blocking production follow-up");
    });
  });

  test("complete blocks when a handoff has a non-blocking untriaged discovered issue", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-non-blocking-issue";
      await makeActiveCharter(projectDir, charterId);
      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-non-blocking-issue-1",
          discoveredIssues: [
            {
              severity: "non_blocking",
              kind: "critical_context",
              description: "A non-blocking follow-up still needs an explicit triage decision.",
              triageState: "untriaged",
            },
          ],
        }),
      });

      const error = await expectCompleteBlocked(projectDir, charterId);
      expect(error.message).toContain("untriaged-handoff-items");
      expect(error.message).toContain("non-blocking follow-up");
    });
  });

  test("complete passes when state triage marks all handoff items as cut", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-cut-state";
      const dir = await makeActiveCharter(projectDir, charterId);
      const response = await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-cut-state-1",
          whatWasLeftUndone: "A deliberately cut integration remains out of scope.",
        }),
      });
      const state = await loadCharterState(dir);
      state.triage = [
        {
          handoffPath: response.handoffPath,
          itemId: "whatWasLeftUndone",
          decision: "cut",
          reason: "Integration is out of scope for this charter.",
          decidedAt: "2026-05-27T12:40:00.000Z",
        },
      ];
      await writeCharterState(dir, state);

      const result = await completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });

  test("complete passes when a follow-up plan body mentions the same sessionId", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-follow-up-feature";
      await makeActiveCharter(projectDir, charterId);
      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-follow-up-1",
          whatWasLeftUndone: "Create a follow-up feature for the cleanup trail.",
        }),
      });
      await amendCharter(projectDir, {
        charterId,
        target: "planning",
        reason: "Add follow-up feature for handoff leftovers.",
        now: "2026-05-27T12:35:00.000Z",
      });
      await addFeature(projectDir, {
        charterId,
        id: "f2-follow-up",
        milestone: "m2-follow-up",
        order: 2,
        category: "infrastructure",
        fulfills: [],
        body: `Follow-up feature absorbs leftover work from session fixer-follow-up-1.\n\n${VALIDATION_MD}`,
        now: "2026-05-27T12:36:00.000Z",
      });
      await lockPlan(projectDir, { charterId, now: "2026-05-27T12:40:00.000Z" });

      const result = await completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });

  test("amend_charter triage cut entries write state.json idempotently", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-amend-cut";
      const dir = await makeActiveCharter(projectDir, charterId);
      const response = await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-amend-cut-1",
          whatWasLeftUndone: "Cut this leftover from the charter.",
        }),
      });

      await callManage(projectDir, {
        action: "amend_charter",
        charterId,
        target: "planning",
        reason: "Cut a handoff leftover from charter scope.",
        triage: [
          { handoffPath: response.handoffPath, itemId: "whatWasLeftUndone", decision: "cut", reason: "Explicitly out of scope." },
          { handoffPath: response.handoffPath, itemId: "whatWasLeftUndone", decision: "cut", reason: "Explicitly out of scope." },
        ],
      });

      const state = await loadCharterState(dir);
      expect(state.triage).toEqual([
        {
          handoffPath: response.handoffPath,
          itemId: "whatWasLeftUndone",
          decision: "cut",
          reason: "Explicitly out of scope.",
          decidedAt: expect.any(String),
        },
      ]);
    });
  });

  test("suggestion severity discovered issues do not block complete", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v23-triage-suggestion";
      await makeActiveCharter(projectDir, charterId);
      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-suggestion-1",
          discoveredIssues: [
            {
              severity: "suggestion",
              kind: "discovered_issue",
              description: "Optional cleanup could make future tests clearer.",
              triageState: "untriaged",
            },
          ],
        }),
      });

      const result = await completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });
});
