import { beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { recordEvidence } from "../src/application/record-service";
import { registerCharterFlags, registerCharterTools } from "../src/application/registration";
import { registerCharterRemindersBridge, removeCharterReminder, upsertCharterReminder } from "../src/application/reminders-bridge";
import { clearHookSubscribers } from "../src/application/hooks";

interface EmittedEvent {
  channel: string;
  payload: any;
}

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

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-reminders-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makePiHarness(options: { throwOnReminderEvents?: boolean } = {}) {
  const events: EmittedEvent[] = [];
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const flags = new Map<string, unknown>();
  const pi: any = {
    events: {
      emit(channel: string, payload: unknown) {
        if (options.throwOnReminderEvents && channel.startsWith("reminder:")) {
          throw new Error(`reminder bus failed for ${channel}`);
        }
        events.push({ channel, payload });
      },
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerFlag(name: string, config: { default?: unknown }) {
      flags.set(name, config.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    on(name: string, handler: Function) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
  };
  registerCharterTools(pi);
  return { events, tools, pi, handlers };
}

function toolContext(projectDir: string, sessionId?: string) {
  return {
    cwd: projectDir,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify() {} },
  } as any;
}

async function executeTool(tool: any, params: Record<string, unknown>, projectDir: string, sessionId?: string) {
  return tool.execute("test-call", params, new AbortController().signal, () => undefined, toolContext(projectDir, sessionId));
}

async function createCharterWithTool(
  projectDir: string,
  tools: Map<string, any>,
  events: EmittedEvent[],
  name = "reminder-test",
): Promise<string> {
  await executeTool(tools.get("charter_manage"), {
    action: "create",
    objective: "Ship reminder bridge",
    name,
  }, projectDir);
  const createReminder = events.find((event) => event.channel === "reminder:upsert");
  return createReminder?.payload.metadata.charterId as string;
}

async function writeCharter(projectDir: string, charterId: string, body: string) {
  await writeFile(join(projectDir, ".pi/charters", charterId, "charter.md"), body, "utf8");
}

async function writeFeature(projectDir: string, charterId: string, body: string) {
  const planDir = join(projectDir, ".pi/charters", charterId, "plan");
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, "f1.md"), body, "utf8");
}

async function writeReadyPlan(projectDir: string, charterId: string, criteria = ["VAL-REM-001"]) {
  await writeCharter(
    projectDir,
    charterId,
    [
      "# Charter",
      "## Objective",
      "Ship reminder bridge",
      "## Criteria",
      ...criteria.flatMap((criterionId) => [
        `### ${criterionId} Covered criterion`,
        "Description: Covered by f1.",
        "Verifier: manual",
        "Because: reminder bridge probe verified by hand",
        "Fresh evidence required: false",
        "",
      ]),
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
  );
  await writeFeature(
    projectDir,
    charterId,
    [
      "---",
      "id: f1",
      "milestone: m1",
      "order: 1",
      "fulfills:",
      ...criteria.map((criterionId) => `  - ${criterionId}`),
      "preconditions: []",
      "---",
      "Implement reminder bridge.",
      "",
      VALIDATION_MD,
    ].join("\n"),
  );
}

describe("charter reminders bridge", () => {
  beforeEach(() => clearHookSubscribers());

  it("registers reminders on charter_manage create and charter_plan lock_plan", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "reminder-reg");
      expect(events.filter((event) => event.channel === "reminder:upsert")).toHaveLength(1);

      await writeReadyPlan(projectDir, charterId);
      await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);

      const upserts = events.filter((event) => event.channel === "reminder:upsert");
      expect(upserts).toHaveLength(2);
      expect(upserts[1].payload.id).toBe(`pi-charter:${charterId}`);
      expect(upserts[1].payload.source).toBe("pi-charter");
      expect(upserts[1].payload.repeatEveryTurns).toBe(8);
      expect(upserts[1].payload.metadata.status).toBe("active");
      expect(upserts[1].payload.text).toContain("Next: f1");
    });
  });

  it("backfills a reminder on session_start for an already-bound active charter", async () => {
    await withTempProject(async (projectDir) => {
      const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-reminders-home-"));
      try {
        const sessionId = "session-reminder-backfill";
        const { events, tools, pi, handlers } = makePiHarness();
        const charterId = await createCharterWithTool(projectDir, tools, events, "reload-backfill");
        await writeReadyPlan(projectDir, charterId);
        await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);
        await bindCharterToSession(projectDir, { charterId, sessionId, homeDir });
        registerCharterFlags(pi, { homeDir });

        events.length = 0;
        for (const handler of handlers.get("session_start") ?? []) {
          await handler({}, toolContext(projectDir, sessionId));
        }

        expect(events).toHaveLength(1);
        expect(events[0].channel).toBe("reminder:upsert");
        expect(events[0].payload.id).toBe(`pi-charter:${charterId}`);
        // The active-state guidance now teaches the batch shape + bound-charter default.
        expect(events[0].payload.text).toContain("charter_record action=evidence");
        expect(events[0].payload.text).toContain("defaults to the bound charter");
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  });

  it("refreshes reminder progress after evidence and handoff records", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "progress-refresh");
      await writeReadyPlan(projectDir, charterId, ["VAL-REM-001", "VAL-REM-002"]);
      await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);

      events.length = 0;
      await executeTool(tools.get("charter_record"), {
        action: "evidence",
        charterId,
        criterionId: "VAL-REM-001",
        featureId: "f1",
        outcome: "pass",
        summary: "first criterion passed",
        because: "manual sign-off for first reminder criterion",
      }, projectDir);
      expect(events.at(-1)?.channel).toBe("reminder:upsert");
      expect(events.at(-1)?.payload.text).toContain("1/2 VAL pass");

      await executeTool(tools.get("charter_record"), {
        action: "handoff_apply",
        charterId,
        featureId: "f1",
        subagentSessionId: "reviewer-session",
        handoffNote: "Reviewer passed second criterion.",
        completedCriteria: [{ criterionId: "VAL-REM-002", outcome: "pass", summary: "second criterion passed" }],
      }, projectDir);
      expect(events.at(-1)?.channel).toBe("reminder:upsert");
      expect(events.at(-1)?.payload.text).toContain("2/2 VAL pass");
    });
  });

  it("unregisters reminders on charter_manage complete and force_complete", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "reminder-done");
      await writeReadyPlan(projectDir, charterId);
      await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-REM-001",
        featureId: "f1",
        outcome: "pass",
        summary: "reviewer pass",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-rem-done",
      });

      events.length = 0;
      await executeTool(tools.get("charter_manage"), { action: "complete", charterId }, projectDir);
      expect(events).toEqual([
        { channel: "reminder:remove", payload: { id: `pi-charter:${charterId}`, source: "pi-charter" } },
      ]);
    });

    await withTempProject(async (projectDir) => {
      const { events, tools } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "reminder-force");

      events.length = 0;
      await executeTool(tools.get("charter_manage"), {
        action: "force_complete",
        charterId,
        reason: "test cleanup",
        target: "abandoned",
      }, projectDir);
      expect(events).toEqual([
        { channel: "reminder:remove", payload: { id: `pi-charter:${charterId}`, source: "pi-charter" } },
      ]);
    });
  });

  it("does not fail lifecycle tools when reminder events throw", async () => {
    await withTempProject(async (projectDir) => {
      const { tools } = makePiHarness({ throwOnReminderEvents: true });
      const createResult = await executeTool(tools.get("charter_manage"), {
        action: "create",
        objective: "Ship reminder bridge",
        name: "ambient-reminders",
      }, projectDir);
      const charterId = createResult.details.charterId as string;

      await writeReadyPlan(projectDir, charterId);
      await expect(executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir)).resolves.toMatchObject({
        details: { status: "active" },
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-REM-001",
        featureId: "f1",
        outcome: "pass",
        summary: "reviewer pass",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-rem-throw",
      });
      await expect(executeTool(tools.get("charter_manage"), { action: "complete", charterId }, projectDir)).resolves.toMatchObject({
        details: { status: "completed" },
      });
    });

    await withTempProject(async (projectDir) => {
      const { tools } = makePiHarness({ throwOnReminderEvents: true });
      const createResult = await executeTool(tools.get("charter_manage"), {
        action: "create",
        objective: "Ship reminder bridge",
        name: "ambient-reminders-force",
      }, projectDir);
      const charterId = createResult.details.charterId as string;

      await expect(executeTool(tools.get("charter_manage"), {
        action: "force_complete",
        charterId,
        reason: "test cleanup",
        target: "abandoned",
      }, projectDir)).resolves.toMatchObject({
        details: { status: "abandoned" },
      });
    });
  });

  it("renders charter progress, next action, and subagent instruction", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools, pi } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "named-charter");
      await writeReadyPlan(projectDir, charterId, ["VAL-REM-001", "VAL-REM-002"]);
      await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-REM-001",
        featureId: "f1",
        outcome: "pass",
        summary: "first criterion passed",
        because: "manual sign-off for reminder progress probe",
      });

      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);

      expect(events).toHaveLength(1);
      const reminder = events[0].payload;
      expect(reminder.label).toBe("Charter");
      expect(reminder.text).toContain("named-charter (active)");
      expect(reminder.text).toContain("1/2 VAL pass");
      expect(reminder.text).toContain("Next: f1");
      expect(reminder.text).toContain("async subagents");
      expect(reminder.metadata).toMatchObject({ charterId, projectDir, passCount: 1, totalCount: 2, next: "f1" });
    });
  });

  it("surfaces actionable planning-phase next step (no criteria → no features → uncovered → lock_plan)", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools, pi } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "planning-stages");

      // 1. Empty charter.md (no VAL criteria yet).
      await writeCharter(projectDir, charterId, [
        "# Charter",
        "## Objective",
        "Reach planning surface stages",
        "## Criteria",
        "## Scope and constraints",
        "- none",
        "",
      ].join("\n"));
      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);
      expect(events.at(-1)?.payload.text).toContain("author charter.md VAL-* criteria");
      expect(events.at(-1)?.payload.text).toContain("do not start implementation");

      // 2. VAL criteria present but no features yet.
      await writeCharter(projectDir, charterId, [
        "# Charter",
        "## Objective",
        "Reach planning surface stages",
        "## Criteria",
        "### VAL-PLAN-001 first stage",
        "Description: first stage covered.",
        "Verifier: manual",
        "Because: manual planning probe sign-off",
        "### VAL-PLAN-002 second stage",
        "Description: second stage covered.",
        "Verifier: manual",
        "Because: manual planning probe sign-off",
        "## Scope and constraints",
        "- none",
        "",
      ].join("\n"));
      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);
      expect(events.at(-1)?.payload.text).toContain("add features that fulfill VAL-* criteria");

      // 3. Add a feature covering only VAL-PLAN-001 → VAL-PLAN-002 still uncovered.
      await writeFeature(projectDir, charterId, [
        "---",
        "id: f1",
        "milestone: m1",
        "order: 1",
        "fulfills:",
        "  - VAL-PLAN-001",
        "preconditions: []",
        "---",
        "covers first only.",
        "",
      ].join("\n"));
      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);
      expect(events.at(-1)?.payload.text).toContain("cover uncovered VAL(s): VAL-PLAN-002");

      // 4. Cover the missing VAL → plan is ready to lock.
      await writeFile(join(projectDir, ".pi/charters", charterId, "plan", "f1.md"), [
        "---",
        "id: f1",
        "milestone: m1",
        "order: 1",
        "fulfills:",
        "  - VAL-PLAN-001",
        "  - VAL-PLAN-002",
        "preconditions: []",
        "---",
        "covers both.",
        "",
      ].join("\n"));
      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);
      expect(events.at(-1)?.payload.text).toContain("charter_plan action=lock_plan");
    });
  });

  it("converts an upsert on a completed charter into a remove (defense in depth)", async () => {
    await withTempProject(async (projectDir) => {
      const { events, tools, pi } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "upsert-on-completed");
      await writeReadyPlan(projectDir, charterId);
      await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-REM-001",
        featureId: "f1",
        outcome: "pass",
        summary: "reviewer pass",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-upsert-after-done",
      });
      await executeTool(tools.get("charter_manage"), { action: "complete", charterId }, projectDir);

      events.length = 0;
      await upsertCharterReminder(pi, projectDir, charterId);
      expect(events).toEqual([
        { channel: "reminder:remove", payload: { id: `pi-charter:${charterId}`, source: "pi-charter" } },
      ]);
    });
  });

  it("clears a stale reverse session binding pointing at a completed charter on session_start", async () => {
    await withTempProject(async (projectDir) => {
      const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-reminders-home-"));
      try {
        const sessionId = "session-stale-terminal-binding";
        const { events, tools, pi, handlers } = makePiHarness();
        const charterId = await createCharterWithTool(projectDir, tools, events, "stale-binding");
        await writeReadyPlan(projectDir, charterId);
        await executeTool(tools.get("charter_plan"), { action: "lock_plan", charterId }, projectDir);
        await recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-REM-001",
          featureId: "f1",
          outcome: "pass",
          summary: "reviewer pass",
          source: "subagent",
          recordedBy: "subagent:charter-reviewer:sess-stale-binding",
        });
        await bindCharterToSession(projectDir, { charterId, sessionId, homeDir });
        await executeTool(tools.get("charter_manage"), { action: "complete", charterId }, projectDir);

        registerCharterFlags(pi, { homeDir });
        events.length = 0;
        for (const handler of handlers.get("session_start") ?? []) {
          await handler({}, toolContext(projectDir, sessionId));
        }

        // Reload should remove (not upsert) the dead reminder.
        const removes = events.filter((event) => event.channel === "reminder:remove");
        const upserts = events.filter((event) => event.channel === "reminder:upsert");
        expect(removes.length).toBeGreaterThanOrEqual(1);
        expect(upserts).toHaveLength(0);

        // Reverse session binding under home should be gone.
        const { readSessionBinding } = await import("../src/application/binding-service");
        const reverse = await readSessionBinding({ sessionId, homeDir });
        expect(reverse).toBeNull();
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  });

  it("is a no-op when pi-reminders is absent", async () => {
    await withTempProject(async (projectDir) => {
      const silentPi: any = { events: { emit() {} } };
      const { events, tools } = makePiHarness();
      const charterId = await createCharterWithTool(projectDir, tools, events, "silent-charter");

      expect(() => registerCharterRemindersBridge(silentPi)).not.toThrow();
      await expect(upsertCharterReminder(silentPi, projectDir, charterId)).resolves.toBeUndefined();
      expect(() => removeCharterReminder(silentPi, charterId)).not.toThrow();
    });
  });
});
