import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHookSubscribers } from "../src/application/hooks";
import { lockPlan } from "../src/application/plan-service";
import { handoff, recordEvidence, verifyCriterion } from "../src/application/record-service";
import { completeCharter, createCharter, forceCompleteCharter, pauseCharter, resumeCharter } from "../src/application/service";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import { logger, type LogContext } from "../src/infrastructure/logger";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";
import { charterDir } from "../src/infrastructure/store";
import type { HandoffRecordInput } from "../src/persistence/handoff-store";

interface InfoLog {
  message: string;
  context?: LogContext;
}

let infoLogs: InfoLog[] = [];
let originalInfo: (message: string, context?: LogContext) => void;

beforeEach(() => {
  clearHookSubscribers();
  __resetSubagentApiForTests();
  infoLogs = [];
  originalInfo = logger.info.bind(logger);
  logger.info = (message: string, context?: LogContext) => {
    infoLogs.push({ message, context });
  };
});

afterEach(() => {
  logger.info = originalInfo;
  __resetSubagentApiForTests();
  clearHookSubscribers();
});

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-structured-logging-"));
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

async function seedPlanningCharter(projectDir: string, charterId: string, options: { subagent?: boolean } = {}): Promise<string> {
  await createCharter(projectDir, {
    objective: "Structured logging probe",
    charterId,
    now: "2026-05-27T12:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    options.subagent
      ? [
        "# Charter",
        "",
        "## Objective",
        "",
        "Structured logging probe.",
        "",
        "## Criteria",
        "",
        "### VAL-LOG-001 — Subagent verifier",
        "Description: A verifier dispatch records structured logs.",
        "Verifier: subagent",
        "Agent: charter-reviewer",
        "Task: Review {charterId} {featureId} {criterionId} into {evidenceDir}.",
        "Fresh evidence required: false",
        "Review subagent required: false",
        "",
        "## Scope and constraints",
        "",
        "- Keep this charter local to the test.",
        "",
      ].join("\n")
      : [
        "# Charter",
        "",
        "## Objective",
        "",
        "Structured logging probe.",
        "",
        "## Criteria",
        "",
        "### VAL-LOG-001 — Logging criterion",
        "Description: Structured logs are emitted for audited surfaces.",
        "Verifier: manual",
        "Because: the test records trusted pass evidence explicitly",
        "",
        "## Scope and constraints",
        "",
        "- Keep this charter local to the test.",
        "",
      ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  return dir;
}

async function addFeature(dir: string, featureId = "f1"): Promise<void> {
  await writeFile(
    join(dir, "plan", `${featureId}.md`),
    `---\nid: ${featureId}\nmilestone: m1\norder: 1\nkind: impl\nfulfills:\n  - VAL-LOG-001\npreconditions: []\n---\n\n# ${featureId}\n\n${VALIDATION_MD}`,
    "utf8",
  );
}

async function makeActiveCharter(projectDir: string, charterId: string, options: { subagent?: boolean } = {}): Promise<string> {
  const dir = await seedPlanningCharter(projectDir, charterId, options);
  await addFeature(dir);
  await lockPlan(projectDir, { charterId, now: "2026-05-27T12:05:00.000Z" });
  return dir;
}

async function recordTrustedPass(projectDir: string, charterId: string, now = "2026-05-27T12:10:00.000Z"): Promise<void> {
  await recordEvidence(projectDir, {
    charterId,
    criterionId: "VAL-LOG-001",
    featureId: "f1",
    outcome: "pass",
    summary: "trusted pass evidence",
    source: "subagent",
    recordedBy: "subagent:charter-reviewer:structured-logging",
    now,
  });
}

function info(message: string): InfoLog {
  const entry = infoLogs.find((log) => log.message === message);
  expect(entry).toBeDefined();
  return entry!;
}

function validHandoff(overrides: Partial<HandoffRecordInput> = {}): HandoffRecordInput {
  return {
    sessionId: "fixer-structured-logging",
    featureId: "f1",
    agent: "fixer",
    startedAt: "2026-05-27T12:20:00.000Z",
    completedAt: "2026-05-27T12:30:00.000Z",
    successState: "success",
    validatorsPassed: true,
    fulfills: ["VAL-LOG-001"],
    whatWasImplemented: "Implemented enough structured logging behavior in this fixture to exercise handoff log payloads without touching real charter files.",
    whatWasLeftUndone: "",
    verification: {
      commandsRun: [
        { command: "bun test tests/structured-logging.test.ts", exitCode: 0, observation: "Structured logging fixture command passed." },
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

function installSubagentStub(): void {
  const api: SubagentExposedAPI = {
    async spawnRaw(_input: SpawnRawInput) {
      return { content: [{ type: "text", text: "stub verifier completed" }] };
    },
    list() {
      return [{ name: "charter-reviewer", description: "stub" }];
    },
  };
  setSubagentApiForBridge(api);
}

describe("structured info logging", () => {
  test("lock_plan success emits outcome and status transition logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-lock-success";
      const dir = await seedPlanningCharter(projectDir, charterId);
      await addFeature(dir);

      await lockPlan(projectDir, { charterId, now: "2026-05-27T12:05:00.000Z" });

      expect(info("lock_plan succeeded").context).toMatchObject({
        component: "plan-service",
        charterId,
        featureCount: 1,
        valCount: 1,
      });
      expect(info("lock_plan succeeded").context?.warnings).toBeArray();
      expect(info("lock_plan succeeded").context?.planDigest).toStartWith("sha256:");
      expect(info("charter status transition").context).toMatchObject({
        component: "service",
        charterId,
        from: "planning",
        to: "active",
      });
    });
  });

  test("lock_plan rejected emits failures", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-lock-rejected";
      await seedPlanningCharter(projectDir, charterId);

      await expect(lockPlan(projectDir, { charterId, now: "2026-05-27T12:05:00.000Z" })).rejects.toThrow(/Cannot lock plan/);

      expect(info("lock_plan rejected").context).toMatchObject({
        component: "plan-service",
        charterId,
        failures: ["plan/ has no feature files", "no feature claims this VAL: VAL-LOG-001"],
      });
    });
  });

  test("completion blocked and completion success emit structured logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-completion";
      await makeActiveCharter(projectDir, charterId);
      infoLogs = [];

      await expect(completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" })).rejects.toThrow(/Cannot complete charter/);
      expect(info("completion blocked").context).toMatchObject({
        component: "service",
        charterId,
        valNotPass: ["VAL-LOG-001"],
        untriagedHandoffItems: [],
      });
      expect(info("completion blocked").context?.blockingReasons).toContain("no pass evidence yet");

      await recordTrustedPass(projectDir, charterId);
      infoLogs = [];
      await completeCharter(projectDir, { charterId, completionNote: "done", now: "2026-05-27T13:05:00.000Z" });

      expect(info("charter status transition").context).toMatchObject({
        component: "service",
        charterId,
        from: "active",
        to: "completed",
        reason: "done",
      });
      expect(info("charter completed").context).toMatchObject({
        component: "service",
        charterId,
        featureCount: 1,
        valCount: 1,
      });
    });
  });

  test("pause, resume, and force_complete emit status transition logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-pause-resume";
      await makeActiveCharter(projectDir, charterId);
      infoLogs = [];

      await pauseCharter(projectDir, { charterId, reason: "waiting", now: "2026-05-27T12:15:00.000Z" });
      await resumeCharter(projectDir, { charterId, now: "2026-05-27T12:16:00.000Z" });
      await forceCompleteCharter(projectDir, { charterId, reason: "superseded", now: "2026-05-27T12:17:00.000Z" });

      const transitions = infoLogs.filter((log) => log.message === "charter status transition");
      expect(transitions.map((log) => log.context)).toEqual([
        { component: "service", charterId, from: "active", to: "paused", reason: "waiting" },
        { component: "service", charterId, from: "paused", to: "active", reason: undefined },
        { component: "service", charterId, from: "active", to: "abandoned", reason: "superseded" },
      ]);
    });
  });

  test("handoff writes and partial handoffs emit structured logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-handoff";
      await makeActiveCharter(projectDir, charterId);
      infoLogs = [];

      await handoff(projectDir, {
        charterId,
        ...validHandoff({
          sessionId: "fixer-partial-structured",
          successState: "partial",
          validatorsPassed: false,
          whatWasLeftUndone: "One blocking item remains.",
          discoveredIssues: [
            { severity: "blocking", kind: "discovered_issue", description: "Blocking issue remains." },
            { severity: "suggestion", kind: "critical_context", description: "Consider an optional follow-up." },
          ],
        }),
      });

      expect(info("handoff recorded").context).toMatchObject({
        component: "record-service",
        charterId,
        featureId: "f1",
        sessionId: "fixer-partial-structured",
        successState: "partial",
        undoneCount: 1,
        discoveredIssuesCount: 2,
        blockingIssues: 1,
      });
      expect(info("feature reverted to pending").context).toMatchObject({
        component: "record-service",
        charterId,
        featureId: "f1",
        source: "handoff",
        successState: "partial",
      });
    });
  });

  test("partial evidence emits feature reverted log", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-evidence-revert";
      await makeActiveCharter(projectDir, charterId);
      await recordTrustedPass(projectDir, charterId);
      infoLogs = [];

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-LOG-001",
        featureId: "f1",
        outcome: "partial",
        summary: "criterion only partially passed",
        because: "the evidence intentionally exercises the revert projection",
        now: "2026-05-27T12:20:00.000Z",
      });

      expect(info("feature reverted to pending").context).toMatchObject({
        component: "record-service",
        charterId,
        featureId: "f1",
        source: "evidence",
        criterionId: "VAL-LOG-001",
        outcome: "partial",
      });
    });
  });

  test("subagent verifier dispatch emits pre and post logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-verifier-dispatch";
      await makeActiveCharter(projectDir, charterId, { subagent: true });
      installSubagentStub();
      infoLogs = [];

      await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-LOG-001",
        featureId: "f1",
        now: "2026-05-27T12:30:00.000Z",
      });

      expect(info("verifier dispatch").context).toMatchObject({
        component: "subagent-dispatch",
        charterId,
        criterionId: "VAL-LOG-001",
        persona: "charter-reviewer",
        resolvedModel: "frontmatter-default",
        resolvedThinking: "frontmatter-default",
      });
      expect(info("verifier dispatch completed").context).toMatchObject({
        component: "subagent-dispatch",
        charterId,
        criterionId: "VAL-LOG-001",
        persona: "charter-reviewer",
        exitCode: 0,
      });
      expect(typeof info("verifier dispatch completed").context?.durationMs).toBe("number");
    });
  });
});
