/**
 * VAL-8 — Backwards-compat for legacy single-entry call shapes.
 *
 * Legacy callers of `charter_plan action=add_feature` and
 * `charter_record action=evidence` keep working when they pass the old
 * inline scalar fields (no `features` / `entries` array). Every such call
 * emits ONE file-log warning that contains the literal string `"deprecated"`
 * so callers can grep and migrate. The literal `"deprecated"` is part of
 * the public contract (do not reword without bumping VAL-8).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { clearHookSubscribers } from "../src/application/hooks";
import { lockPlan } from "../src/application/plan-service";
// lockPlan re-used in the batch-no-warn test for the active-state evidence call.
import { registerCharterTools } from "../src/application/registration";
import { createCharter } from "../src/application/service";
import { logger, type LogEntry } from "../src/infrastructure/logger";

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

function ctx(projectDir: string, sessionId: string) {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
}

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-legacy-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-legacy-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

/**
 * Seed a charter that is still in `planning` (no lockPlan call). This is the
 * state where `add_feature` is legal. Both the legacy single-entry path and
 * the batch path require `state.status === "planning"`.
 */
async function seedPlanningCharter(input: { projectDir: string; homeDir: string; sessionId: string; charterId: string }) {
  await createCharter(input.projectDir, {
    objective: "Legacy shape regression",
    charterId: input.charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(input.projectDir, ".pi/charters", input.charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Legacy shape regression",
      "## Criteria",
      "### VAL-L-001 first criterion",
      "Description: covered by f1.",
      "Verifier: manual",
      "Because: manual probe for legacy",
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await bindCharterToSession(input.projectDir, {
    charterId: input.charterId,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    now: "2026-05-15T00:02:00.000Z",
  });
}

/**
 * Seed a charter that has been locked to `active` and has one feature
 * available to attach evidence to. This is the state where `recordEvidence`
 * is legal.
 */
async function seedActiveCharter(input: { projectDir: string; homeDir: string; sessionId: string; charterId: string }) {
  await createCharter(input.projectDir, {
    objective: "Legacy shape regression",
    charterId: input.charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(input.projectDir, ".pi/charters", input.charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Legacy shape regression",
      "## Criteria",
      "### VAL-L-001 first criterion",
      "Description: covered by f1.",
      "Verifier: manual",
      "Because: manual probe for legacy",
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
      "fulfills: [VAL-L-001]",
      "preconditions: []",
      "---",
      "Implement legacy probe.",
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

interface WarnSpy {
  calls: string[];
  restore: () => void;
}

function spyOnWarn(): WarnSpy {
  const calls: string[] = [];
  const handler = (entry: LogEntry) => {
    if (entry.level !== "warn") return;
    calls.push(entry.message);
  };
  logger.addHandler(handler);
  return { calls, restore: () => { logger.clearHandlers(); } };
}

let activeSpy: WarnSpy | undefined;
afterEach(() => {
  activeSpy?.restore();
  activeSpy = undefined;
});

describe("VAL-8: legacy single-entry call shapes still work and warn", () => {
  test("charter_plan action=add_feature with inline scalars logs ONE deprecation warning and still writes the feature", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "sess-legacy-add";
      const charterId = "ch-legacy-add";
      await seedPlanningCharter({ projectDir, homeDir, sessionId, charterId });
      const spy = spyOnWarn();
      activeSpy = spy;
      const { tools } = makeHarness(homeDir);
      const result = await tools.get("charter_plan")!.execute(
        "call-1",
        {
          action: "add_feature",
          id: "f-legacy",
          milestone: "m1",
          order: 9,
          fulfills: ["VAL-L-001"],
          body: "legacy single-entry add.",
        },
        new AbortController().signal,
        () => {},
        ctx(projectDir, sessionId),
      );
      // Behavior preserved: feature md file landed and response shape is unchanged.
      expect(result.details.featureId).toBe("f-legacy");
      const md = await readFile(join(projectDir, ".pi/charters", charterId, "plan/f-legacy.md"), "utf8");
      expect(md).toContain("id: f-legacy");
      // Exactly ONE warning. Literal "deprecated" string must appear so callers can grep.
      const matching = spy.calls.filter((line) => line.includes("deprecated"));
      expect(matching.length).toBe(1);
      expect(matching[0]).toContain("charter_plan action=add_feature");
    });
  });

  test("charter_record action=evidence with inline scalars logs ONE deprecation warning and still writes the evidence", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "sess-legacy-evidence";
      const charterId = "ch-legacy-evidence";
      await seedActiveCharter({ projectDir, homeDir, sessionId, charterId });
      const spy = spyOnWarn();
      activeSpy = spy;
      const { tools } = makeHarness(homeDir);
      const result = await tools.get("charter_record")!.execute(
        "call-1",
        {
          action: "evidence",
          criterionId: "VAL-L-001",
          featureId: "f1",
          outcome: "pass",
          summary: "manual probe pass",
          because: "ran probe locally",
        },
        new AbortController().signal,
        () => {},
        ctx(projectDir, sessionId),
      );
      expect(result.details.criterionId).toBe("VAL-L-001");
      expect(result.details.outcome).toBe("pass");
      const matching = spy.calls.filter((line) => line.includes("deprecated"));
      expect(matching.length).toBe(1);
      expect(matching[0]).toContain("charter_record action=evidence");
    });
  });

  test("batch shapes do NOT emit the deprecation warning (only the legacy path does)", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "sess-batch-no-warn";
      const charterId = "ch-batch-no-warn";
      // First seed planning + add a batch feature (planning required), then
      // separately seed an active charter to test the batch evidence path.
      await seedPlanningCharter({ projectDir, homeDir, sessionId, charterId });
      const spy = spyOnWarn();
      activeSpy = spy;
      const { tools } = makeHarness(homeDir);

      await tools.get("charter_plan")!.execute(
        "call-1",
        {
          action: "add_feature",
          features: [
            { id: "f-batch-a", milestone: "m1", order: 9, fulfills: ["VAL-L-001"], body: `batch a\n\n${VALIDATION_MD}` },
            { id: "f-batch-b", milestone: "m1", order: 10, fulfills: ["VAL-L-001"], body: `batch b\n\n${VALIDATION_MD}` },
          ],
        },
        new AbortController().signal,
        () => {},
        ctx(projectDir, sessionId),
      );

      // Lock the plan to transition to active so recordEvidence is legal.
      await lockPlan(projectDir, { charterId, now: "2026-05-15T00:03:00.000Z" });

      await tools.get("charter_record")!.execute(
        "call-2",
        {
          action: "evidence",
          entries: [
            { criterionId: "VAL-L-001", featureId: "f-batch-a", outcome: "pass", summary: "batch evidence", because: "probe" },
          ],
        },
        new AbortController().signal,
        () => {},
        ctx(projectDir, sessionId),
      );

      const matching = spy.calls.filter((line) => line.includes("deprecated"));
      expect(matching.length).toBe(0);
    });
  });
});
