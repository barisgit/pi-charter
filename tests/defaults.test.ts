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
 * VAL-1: Omitting `charterId` on every affected tool resolves to the session-
 * bound charter and produces a response semantically equal to the explicit-id
 * call. We compare `nextActions[]` deeply and the data payload after filtering
 * out volatile fields (`updatedAt`, `ts`, generated evidence paths).
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
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

const VOLATILE_FIELDS = new Set(["updatedAt", "ts", "boundAt", "lastTs", "createdAt", "completedAt", "terminatedAt", "startedAt"]);
const VOLATILE_PATH_FIELDS = new Set(["path", "lastEvidencePath", "lastHandoffPath", "handoffPath"]);

/**
 * Recursively scrub volatile timestamps and generated paths so that the
 * bound-path and explicit-path responses can be compared structurally.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_FIELDS.has(k)) continue;
      if (VOLATILE_PATH_FIELDS.has(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

async function seedActiveCharter(input: { projectDir: string; homeDir: string; sessionId: string; charterId: string }) {
  await createCharter(input.projectDir, {
    objective: "Ship defaults helper",
    charterId: input.charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(input.projectDir, ".pi/charters", input.charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Ship defaults helper",
      "## Criteria",
      "### VAL-D-001 first criterion",
      "Description: bound calls resolve the first criterion.",
      "Verifier: manual",
      "Because: manual probe for defaults",
      "### VAL-D-002 second criterion",
      "Description: bound calls resolve the second criterion.",
      "Verifier: manual",
      "Because: manual probe for defaults",
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
      "fulfills: [VAL-D-001, VAL-D-002]",
      "preconditions: []",
      "---",
      "Implement defaults helper.",
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

async function callTool(tool: FakeTool, params: Record<string, unknown>, projectDir: string, sessionId?: string) {
  return tool.execute("c", params, new AbortController().signal, () => undefined, ctx(projectDir, sessionId));
}

describe("VAL-1 charterId defaults to session-bound charter", () => {
  test("charter_status: bound and explicit return semantically equal payloads", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-status";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-status" });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_status")!, { charterId }, projectDir, "sess-status");
      const bound = await callTool(tools.get("charter_status")!, {}, projectDir, "sess-status");

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      expect(scrub(bound.details)).toEqual(scrub(explicit.details));
    });
  });

  test("charter_plan action=view: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-plan-view";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-plan-view" });
      const { tools } = makeHarness(homeDir);
      const explicit = await callTool(tools.get("charter_plan")!, { action: "view", charterId }, projectDir, "sess-plan-view");
      const bound = await callTool(tools.get("charter_plan")!, { action: "view" }, projectDir, "sess-plan-view");
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      expect(scrub(bound.details)).toEqual(scrub(explicit.details));
    });
  });

  test("charter_plan action=add_feature/update_feature: bound matches explicit in a planning charter", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-plan-add";
      // Create a planning charter (not active) for add_feature.
      await createCharter(projectDir, { objective: "Plan defaults", charterId, now: "2026-05-15T00:00:00.000Z" });
      const dir = join(projectDir, ".pi/charters", charterId);
      await writeFile(
        join(dir, "charter.md"),
        [
          "# Charter",
          "## Objective",
          "Plan defaults",
          "## Criteria",
          "### VAL-D-100 covered",
          "Description: covered.",
          "Verifier: manual",
          "Because: manual probe",
          "## Scope and constraints",
          "- none",
          "",
        ].join("\n"),
        "utf8",
      );
      await bindCharterToSession(projectDir, { charterId, sessionId: "sess-plan-add", homeDir });
      const { tools } = makeHarness(homeDir);

      // add_feature once explicitly, then again bound, with a different id
      // (re-adding the same id is rejected by the service). We compare the
      // shape of the two results structurally.
      const explicit = await callTool(tools.get("charter_plan")!, {
        action: "add_feature",
        charterId,
        id: "f-explicit",
        milestone: "m1",
        order: 1,
        fulfills: ["VAL-D-100"],
        body: "body",
      }, projectDir, "sess-plan-add");
      const bound = await callTool(tools.get("charter_plan")!, {
        action: "add_feature",
        id: "f-bound",
        milestone: "m1",
        order: 2,
        fulfills: ["VAL-D-100"],
        body: "body",
      }, projectDir, "sess-plan-add");

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      // featureId / path differ by design (different ids); compare the shape
      // by replacing the id-bearing fields with a constant marker.
      const norm = (d: any) => ({ ...scrub(d) as object, featureId: "_", message: "_" });
      expect(norm(bound.details)).toEqual(norm(explicit.details));

      // update_feature bound vs explicit on the same id.
      const updExplicit = await callTool(tools.get("charter_plan")!, {
        action: "update_feature",
        charterId,
        id: "f-explicit",
        body: "updated body",
      }, projectDir, "sess-plan-add");
      const updBound = await callTool(tools.get("charter_plan")!, {
        action: "update_feature",
        id: "f-bound",
        body: "updated body",
      }, projectDir, "sess-plan-add");
      expect(updBound.details.nextActions).toEqual(updExplicit.details.nextActions);
      expect(norm(updBound.details)).toEqual(norm(updExplicit.details));
    });
  });

  test("charter_plan action=lock_plan: bound matches explicit when each call has its own charter", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "sess-lock";
      const explicitId = "cha-lock-explicit";
      const boundId = "cha-lock-bound";
      await seedPlanningWithFeature(projectDir, explicitId);
      await seedPlanningWithFeature(projectDir, boundId);
      await bindCharterToSession(projectDir, { charterId: boundId, sessionId, homeDir });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_plan")!, { action: "lock_plan", charterId: explicitId }, projectDir, sessionId);
      const bound = await callTool(tools.get("charter_plan")!, { action: "lock_plan" }, projectDir, sessionId);

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      const norm = (d: any) => {
        const { charterId: _id, message: _m, ...rest } = scrub(d) as Record<string, unknown>;
        return rest;
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter_record action=evidence: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-evidence";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-evidence" });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_record")!, {
        action: "evidence",
        charterId,
        criterionId: "VAL-D-001",
        featureId: "f1",
        outcome: "pass",
        summary: "explicit summary",
        because: "manual probe for defaults",
      }, projectDir, "sess-evidence");
      const bound = await callTool(tools.get("charter_record")!, {
        action: "evidence",
        criterionId: "VAL-D-002",
        featureId: "f1",
        outcome: "pass",
        summary: "explicit summary",
        because: "manual probe for defaults",
      }, projectDir, "sess-evidence");

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      // criterionId differs to avoid clobbering the same record; everything
      // else should match structurally after scrub.
      const norm = (d: any) => {
        const { criterionId: _c, ...rest } = scrub(d) as Record<string, unknown>;
        return rest;
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter_record action=handoff_apply: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-handoff";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-handoff" });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_record")!, {
        action: "handoff_apply",
        charterId,
        featureId: "f1",
        subagentSessionId: "subagent-A",
        handoffNote: "applied explicit",
        completedCriteria: [{ criterionId: "VAL-D-001", outcome: "pass", summary: "ok" }],
      }, projectDir, "sess-handoff");
      const bound = await callTool(tools.get("charter_record")!, {
        action: "handoff_apply",
        featureId: "f1",
        subagentSessionId: "subagent-B",
        handoffNote: "applied bound",
        completedCriteria: [{ criterionId: "VAL-D-002", outcome: "pass", summary: "ok" }],
      }, projectDir, "sess-handoff");

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      const norm = (d: any) => {
        const { subagentSessionId: _s, ...rest } = scrub(d) as Record<string, unknown>;
        return rest;
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter_manage action=pause: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-pause-explicit";
      const boundSession = "sess-pause-bound";
      const explicitId = "cha-pause-explicit";
      const boundId = "cha-pause-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_manage")!, { action: "pause", charterId: explicitId }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter_manage")!, { action: "pause" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      const norm = (d: any) => {
        const { charterId: _id, message: _m, data, ...rest } = scrub(d) as Record<string, unknown>;
        const { charterId: _did, sessionId: _sid, ...dataRest } = (data as Record<string, unknown>) ?? {};
        return { ...rest, data: dataRest };
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter_manage action=resume: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-resume-explicit";
      const boundSession = "sess-resume-bound";
      const explicitId = "cha-resume-explicit";
      const boundId = "cha-resume-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      await pauseCharter(projectDir, { charterId: explicitId, now: "2026-05-15T01:00:00.000Z" });
      await pauseCharter(projectDir, { charterId: boundId, now: "2026-05-15T01:00:00.000Z" });
      const { tools } = makeHarness(homeDir);

      const resumeExplicit = await callTool(tools.get("charter_manage")!, { action: "resume", charterId: explicitId }, projectDir, explicitSession);
      const resumeBound = await callTool(tools.get("charter_manage")!, { action: "resume" }, projectDir, boundSession);
      expect(resumeBound.details.nextActions).toEqual(resumeExplicit.details.nextActions);
      const norm = (d: any) => {
        const { charterId: _id, message: _m, data, ...rest } = scrub(d) as Record<string, unknown>;
        const { charterId: _did, sessionId: _sid, ...dataRest } = (data as Record<string, unknown>) ?? {};
        return { ...rest, data: dataRest };
      };
      expect(norm(resumeBound.details)).toEqual(norm(resumeExplicit.details));
    });
  });

  test("charter_manage action=force_complete: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-force-explicit";
      const boundSession = "sess-force-bound";
      const explicitId = "cha-force-explicit";
      const boundId = "cha-force-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_manage")!, {
        action: "force_complete", charterId: explicitId, reason: "test", target: "abandoned",
      }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter_manage")!, {
        action: "force_complete", reason: "test", target: "abandoned",
      }, projectDir, boundSession);

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=amend_charter: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-amend-explicit";
      const boundSession = "sess-amend-bound";
      const explicitId = "cha-amend-explicit";
      const boundId = "cha-amend-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      await forceCompleteCharter(projectDir, { charterId: explicitId, reason: "x", target: "abandoned", now: "2026-05-15T01:00:00.000Z" });
      await forceCompleteCharter(projectDir, { charterId: boundId, reason: "x", target: "abandoned", now: "2026-05-15T01:00:00.000Z" });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_manage")!, {
        action: "amend_charter", charterId: explicitId, reason: "reopen", target: "review",
      }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter_manage")!, {
        action: "amend_charter", reason: "reopen", target: "review",
      }, projectDir, boundSession);

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter_manage action=complete: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-complete-explicit";
      const boundSession = "sess-complete-bound";
      const explicitId = "cha-complete-explicit";
      const boundId = "cha-complete-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      // High-trust evidence to satisfy the completion gate for both charters.
      for (const id of [explicitId, boundId]) {
        await recordEvidence(projectDir, {
          charterId: id, criterionId: "VAL-D-001", featureId: "f1",
          outcome: "pass", summary: "ok", source: "subagent",
          recordedBy: `subagent:charter-reviewer:rev-${id}`,
        });
        await recordEvidence(projectDir, {
          charterId: id, criterionId: "VAL-D-002", featureId: "f1",
          outcome: "pass", summary: "ok", source: "subagent",
          recordedBy: `subagent:charter-reviewer:rev-${id}`,
        });
      }
      const { tools } = makeHarness(homeDir);
      const explicit = await callTool(tools.get("charter_manage")!, { action: "complete", charterId: explicitId }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter_manage")!, { action: "complete" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });
});

async function seedPlanningWithFeature(projectDir: string, charterId: string): Promise<void> {
  await createCharter(projectDir, { objective: "lock_plan defaults", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi/charters", charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "lock_plan defaults",
      "## Criteria",
      "### VAL-D-LOCK-001 covered",
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
      "fulfills: [VAL-D-LOCK-001]",
      "preconditions: []",
      "---",
      "body",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
}
