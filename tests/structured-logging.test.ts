import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHookSubscribers } from "../src/application/hooks";
import { recordEvidence } from "../src/application/record-service";
import { abandonCharter, completeCharter, pauseCharter, resumeCharter } from "../src/application/service";
import { __resetSubagentApiForTests } from "../src/application/subagent-api";
import { logger, type LogContext } from "../src/infrastructure/logger";
import { makeActiveCharter, seedReportReadyForCompletion } from "./helpers/charter-fixtures";

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

function info(message: string): InfoLog {
  const entry = infoLogs.find((log) => log.message === message);
  expect(entry).toBeDefined();
  return entry!;
}

async function recordTrustedPass(projectDir: string, charterId: string, now = "2026-05-27T12:10:00.000Z"): Promise<void> {
  await recordEvidence(projectDir, {
    charterId,
    criterionId: "VAL-LOG-001",
    outcome: "pass",
    summary: "trusted pass evidence",
    source: "subagent",
    recordedBy: "subagent:charter-reviewer:structured-logging",
    now,
  });
}

describe("structured info logging", () => {
  test("completion blocked and completion success emit structured logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-completion";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Structured logging probe",
        now: "2026-05-27T12:00:00.000Z",
        criteria: [{ id: "VAL-LOG-001", title: "Logging criterion", verifier: "manual" }],
      });
      infoLogs = [];

      await expect(completeCharter(projectDir, { charterId, now: "2026-05-27T13:00:00.000Z" })).rejects.toThrow(/Cannot complete charter/);
      expect(info("completion blocked").context).toMatchObject({
        component: "service",
        charterId,
        valNotPass: ["VAL-LOG-001"],
      });
      expect(info("completion blocked").context?.blockingReasons).toContain("no pass evidence yet");

      await recordTrustedPass(projectDir, charterId);
      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", charterId));
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
        valCount: 1,
      });
    });
  });

  test("pause, resume, and abandon emit status transition logs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "structured-pause-resume";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Structured logging probe",
        now: "2026-05-27T12:00:00.000Z",
        criteria: [{ id: "VAL-LOG-001", title: "Logging criterion", verifier: "manual" }],
      });
      infoLogs = [];

      await pauseCharter(projectDir, { charterId, reason: "waiting", now: "2026-05-27T12:15:00.000Z" });
      await resumeCharter(projectDir, { charterId, now: "2026-05-27T12:16:00.000Z" });
      await abandonCharter(projectDir, { charterId, reason: "superseded", now: "2026-05-27T12:17:00.000Z" });

      const transitions = infoLogs.filter((log) => log.message === "charter status transition");
      expect(transitions.map((log) => log.context)).toEqual([
        { component: "service", charterId, from: "active", to: "paused", reason: "waiting" },
        { component: "service", charterId, from: "paused", to: "active", reason: undefined },
        { component: "service", charterId, from: "active", to: "abandoned", reason: "superseded" },
      ]);
    });
  });
});
