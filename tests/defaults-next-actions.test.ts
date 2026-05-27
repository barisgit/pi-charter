import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { clearHookSubscribers } from "../src/application/hooks";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { registerCharterTools } from "../src/application/registration";
import { createCharter, pauseCharter, forceCompleteCharter } from "../src/application/service";

beforeEach(() => clearHookSubscribers());

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

/**
 * VAL-3: `nextActions[]` is correctly populated on every affected tool
 * response when `charterId` is omitted. We assert deep equality against the
 * explicit-id call so any divergence (extra entries, reordering, missing
 * hints) is caught.
 */

interface FakeTool {
  execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: () => unknown, ctx: unknown) => Promise<{ details: any }>;
}

function makeHarness(homeDir: string): { tools: Map<string, FakeTool> } {
  const tools = new Map<string, FakeTool>();
  const pi: any = {
    events: { emit() {} },
    registerTool(tool: FakeTool & { name: string }) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return ""; },
    on() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  registerCharterTools(pi, { homeDir });
  return { tools };
}

function ctx(projectDir: string, sessionId?: string) {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
}

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-na-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-na-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function seedActiveCharter(input: { projectDir: string; homeDir: string; sessionId: string; charterId: string }) {
  await createCharter(input.projectDir, { objective: "Defaults next actions", charterId: input.charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(input.projectDir, ".pi/charters", input.charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Defaults next actions",
      "## Criteria",
      "### VAL-NA-001 covered",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "### VAL-NA-002 covered",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    [
      "---",
      "id: f1",
      "milestone: m1",
      "order: 1",
      "fulfills: [VAL-NA-001, VAL-NA-002]",
      "preconditions: []",
      "---",
      "body",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  await lockPlan(input.projectDir, { charterId: input.charterId, now: "2026-05-15T00:01:00.000Z" });
  await bindCharterToSession(input.projectDir, {
    charterId: input.charterId,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    now: "2026-05-15T00:02:00.000Z",
  });
}

async function call(tool: FakeTool, params: Record<string, unknown>, projectDir: string, sessionId?: string) {
  return tool.execute("c", params, new AbortController().signal, () => undefined, ctx(projectDir, sessionId));
}

describe("VAL-3 nextActions deep-equal across bound vs explicit calls", () => {
  test("charter_status", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-na-status";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-na" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_status")!, { charterId }, projectDir, "sess-na");
      const bound = await call(tools.get("charter_status")!, {}, projectDir, "sess-na");
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_plan action=view", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-na-plan-view";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-na" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_plan")!, { action: "view", charterId }, projectDir, "sess-na");
      const bound = await call(tools.get("charter_plan")!, { action: "view" }, projectDir, "sess-na");
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_record action=evidence", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-na-evidence";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-na" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_record")!, {
        action: "evidence", charterId,
        entries: [{
          criterionId: "VAL-NA-001", featureId: "f1",
          outcome: "pass", summary: "ok", because: "manual probe",
        }],
      }, projectDir, "sess-na");
      const bound = await call(tools.get("charter_record")!, {
        action: "evidence",
        entries: [{
          criterionId: "VAL-NA-002", featureId: "f1",
          outcome: "pass", summary: "ok", because: "manual probe",
        }],
      }, projectDir, "sess-na");
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_record action=handoff_apply", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-na-handoff";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-na" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_record")!, {
        action: "handoff_apply", charterId,
        featureId: "f1", subagentSessionId: "sub-A", handoffNote: "n",
        completedCriteria: [{ criterionId: "VAL-NA-001", outcome: "pass", summary: "ok" }],
      }, projectDir, "sess-na");
      const bound = await call(tools.get("charter_record")!, {
        action: "handoff_apply",
        featureId: "f1", subagentSessionId: "sub-B", handoffNote: "n",
        completedCriteria: [{ criterionId: "VAL-NA-002", outcome: "pass", summary: "ok" }],
      }, projectDir, "sess-na");
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=pause", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-na-pause-e";
      const boundSession = "sess-na-pause-b";
      const explicitId = "cha-na-pause-e";
      const boundId = "cha-na-pause-b";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_manage")!, { action: "pause", charterId: explicitId }, projectDir, explicitSession);
      const bound = await call(tools.get("charter_manage")!, { action: "pause" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=resume", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-na-resume-e";
      const boundSession = "sess-na-resume-b";
      const explicitId = "cha-na-resume-e";
      const boundId = "cha-na-resume-b";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      await pauseCharter(projectDir, { charterId: explicitId, now: "2026-05-15T01:00:00.000Z" });
      await pauseCharter(projectDir, { charterId: boundId, now: "2026-05-15T01:00:00.000Z" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_manage")!, { action: "resume", charterId: explicitId }, projectDir, explicitSession);
      const bound = await call(tools.get("charter_manage")!, { action: "resume" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=complete", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-na-complete-e";
      const boundSession = "sess-na-complete-b";
      const explicitId = "cha-na-complete-e";
      const boundId = "cha-na-complete-b";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      for (const id of [explicitId, boundId]) {
        for (const criterionId of ["VAL-NA-001", "VAL-NA-002"]) {
          await recordEvidence(projectDir, {
            charterId: id, criterionId, featureId: "f1",
            outcome: "pass", summary: "ok", source: "subagent",
            recordedBy: `subagent:charter-reviewer:rev-${id}`,
          });
        }
      }
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_manage")!, { action: "complete", charterId: explicitId }, projectDir, explicitSession);
      const bound = await call(tools.get("charter_manage")!, { action: "complete" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=force_complete", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-na-force-e";
      const boundSession = "sess-na-force-b";
      const explicitId = "cha-na-force-e";
      const boundId = "cha-na-force-b";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_manage")!, {
        action: "force_complete", charterId: explicitId, reason: "x", target: "abandoned",
      }, projectDir, explicitSession);
      const bound = await call(tools.get("charter_manage")!, {
        action: "force_complete", reason: "x", target: "abandoned",
      }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=amend_charter", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-na-amend-e";
      const boundSession = "sess-na-amend-b";
      const explicitId = "cha-na-amend-e";
      const boundId = "cha-na-amend-b";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      await forceCompleteCharter(projectDir, { charterId: explicitId, reason: "x", target: "abandoned", now: "2026-05-15T01:00:00.000Z" });
      await forceCompleteCharter(projectDir, { charterId: boundId, reason: "x", target: "abandoned", now: "2026-05-15T01:00:00.000Z" });
      const { tools } = makeHarness(homeDir);
      const explicit = await call(tools.get("charter_manage")!, {
        action: "amend_charter", charterId: explicitId, reason: "r", target: "review",
      }, projectDir, explicitSession);
      const bound = await call(tools.get("charter_manage")!, {
        action: "amend_charter", reason: "r", target: "review",
      }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });
});
