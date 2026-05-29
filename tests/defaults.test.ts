import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { clearHookSubscribers } from "../src/application/hooks";
import { recordEvidence } from "../src/application/record-service";
import { registerCharterTools } from "../src/application/registration";
import { pauseCharter } from "../src/application/service";
import { makeActiveCharter as makeActiveCharterFixture, seedReportReadyForCompletion } from "./helpers/charter-fixtures";
import { charterDir } from "../src/infrastructure/store";

beforeEach(() => clearHookSubscribers());

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

const VOLATILE_FIELDS = new Set(["updatedAt", "ts", "boundAt", "lastTs", "createdAt", "completedAt", "terminatedAt", "startedAt", "lastToolWriteAt"]);
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
  await makeActiveCharterFixture({
    projectDir: input.projectDir,
    charterId: input.charterId,
    objective: "Ship defaults helper",
    now: "2026-05-15T00:00:00.000Z",
    criteria: [
      {
        id: "VAL-D-001",
        title: "first criterion",
        body: "bound calls resolve the first criterion.",
        because: "manual probe for defaults",
      },
      {
        id: "VAL-D-002",
        title: "second criterion",
        body: "bound calls resolve the second criterion.",
        because: "manual probe for defaults",
      },
    ],
  });
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

describe("charterId defaults to session-bound charter", () => {
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

  test("charter_record action=evidence: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const charterId = "cha-defaults-evidence";
      await seedActiveCharter({ projectDir, homeDir, charterId, sessionId: "sess-evidence" });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter_record")!, {
        action: "evidence",
        charterId,
        entries: [{
          criterionId: "VAL-D-001",
          outcome: "pass",
          summary: "explicit summary",
          because: "manual probe for defaults",
        }],
      }, projectDir, "sess-evidence");
      const bound = await callTool(tools.get("charter_record")!, {
        action: "evidence",
        entries: [{
          criterionId: "VAL-D-002",
          outcome: "pass",
          summary: "explicit summary",
          because: "manual probe for defaults",
        }],
      }, projectDir, "sess-evidence");

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      // criterionId differs to avoid clobbering the same record; everything
      // else should match structurally after scrub.
      const norm = (d: any) => {
        const scrubbed = scrub(d) as Record<string, any>;
        return {
          ...scrubbed,
          entries: scrubbed.entries.map((entry: Record<string, unknown>) => ({ ...entry, criterionId: "_" })),
        };
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter action=pause: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-pause-explicit";
      const boundSession = "sess-pause-bound";
      const explicitId = "cha-pause-explicit";
      const boundId = "cha-pause-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter")!, { action: "pause", charterId: explicitId }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter")!, { action: "pause" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
      const norm = (d: any) => {
        const { charterId: _id, message: _m, data, ...rest } = scrub(d) as Record<string, unknown>;
        const { charterId: _did, sessionId: _sid, ...dataRest } = (data as Record<string, unknown>) ?? {};
        return { ...rest, data: dataRest };
      };
      expect(norm(bound.details)).toEqual(norm(explicit.details));
    });
  });

  test("charter action=resume: bound matches explicit", async () => {
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

      const resumeExplicit = await callTool(tools.get("charter")!, { action: "resume", charterId: explicitId }, projectDir, explicitSession);
      const resumeBound = await callTool(tools.get("charter")!, { action: "resume" }, projectDir, boundSession);
      expect(resumeBound.details.nextActions).toEqual(resumeExplicit.details.nextActions);
      const norm = (d: any) => {
        const { charterId: _id, message: _m, data, ...rest } = scrub(d) as Record<string, unknown>;
        const { charterId: _did, sessionId: _sid, ...dataRest } = (data as Record<string, unknown>) ?? {};
        return { ...rest, data: dataRest };
      };
      expect(norm(resumeBound.details)).toEqual(norm(resumeExplicit.details));
    });
  });

  test("charter action=abandon: bound matches explicit", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const explicitSession = "sess-force-explicit";
      const boundSession = "sess-force-bound";
      const explicitId = "cha-force-explicit";
      const boundId = "cha-force-bound";
      await seedActiveCharter({ projectDir, homeDir, charterId: explicitId, sessionId: explicitSession });
      await seedActiveCharter({ projectDir, homeDir, charterId: boundId, sessionId: boundSession });
      const { tools } = makeHarness(homeDir);

      const explicit = await callTool(tools.get("charter")!, {
        action: "abandon", charterId: explicitId, reason: "test", target: "abandoned",
      }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter")!, {
        action: "abandon", reason: "test", target: "abandoned",
      }, projectDir, boundSession);

      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });

  test("charter action=complete: bound matches explicit", async () => {
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
          charterId: id, criterionId: "VAL-D-001",
          outcome: "pass", summary: "ok", source: "subagent",
          recordedBy: `subagent:charter-reviewer:rev-${id}`,
        });
        await recordEvidence(projectDir, {
          charterId: id, criterionId: "VAL-D-002",
          outcome: "pass", summary: "ok", source: "subagent",
          recordedBy: `subagent:charter-reviewer:rev-${id}`,
        });
        await seedReportReadyForCompletion(charterDir(projectDir, id));
      }
      const { tools } = makeHarness(homeDir);
      const explicit = await callTool(tools.get("charter")!, { action: "complete", charterId: explicitId }, projectDir, explicitSession);
      const bound = await callTool(tools.get("charter")!, { action: "complete" }, projectDir, boundSession);
      expect(bound.details.nextActions).toEqual(explicit.details.nextActions);
    });
  });
});
