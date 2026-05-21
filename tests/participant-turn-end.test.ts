import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession, writeChildBinding } from "../src/application/binding-service";
import { lockPlan } from "../src/application/plan-service";
import { registerCharterEvaluator } from "../src/application/registration";
import { createCharter, forceCompleteCharter } from "../src/application/service";
import type { EvaluatorAssessment, EvaluatorModelFn } from "../src/application/evaluator-service";

type PiHandler = (event: unknown, ctx: FakeTurnContext) => unknown | Promise<unknown>;

interface EmittedEvent {
  channel: string;
  payload: any;
}

interface FakePi {
  on(event: string, handler: PiHandler): void;
  sendMessage(message: unknown, options: { deliverAs?: string; triggerTurn?: boolean }): void;
  sentMessages: Array<{ message: unknown; options: { deliverAs?: string; triggerTurn?: boolean } }>;
  emittedEvents: EmittedEvent[];
  events: { emit(channel: string, payload: unknown): void };
  handlers: Map<string, PiHandler[]>;
}

interface FakeTurnContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify(message: string, level?: string): void };
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
  };
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

function makeFakePi(): FakePi {
  const handlers = new Map<string, PiHandler[]>();
  const sentMessages: FakePi["sentMessages"] = [];
  const emittedEvents: EmittedEvent[] = [];
  return {
    handlers,
    sentMessages,
    emittedEvents,
    events: {
      emit(channel, payload) {
        emittedEvents.push({ channel, payload });
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
}

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-participant-project-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-participant-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function createActiveCharter(projectDir: string): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Keep child sessions cheap",
    now: "2026-05-18T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", charter.charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nKeep child sessions cheap\n## Criteria\n### VAL-PARTICIPANT-NO-EVAL Participant skips evaluator\nVerifier: manual\n## Scope and constraints\n- none\n`,
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-PARTICIPANT-NO-EVAL]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
  );
  await lockPlan(projectDir, { charterId: charter.charterId, now: "2026-05-18T00:01:00.000Z", legacy: true });
  return charter.charterId;
}

function ctxFor(projectDir: string, sessionId: string): FakeTurnContext {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  };
}

function countingModel(counter: { calls: number }): EvaluatorModelFn {
  const assessment: EvaluatorAssessment = {
    verdict: "on_track",
    confidence: 0.9,
    reason: "No drift for VAL-PARTICIPANT-NO-EVAL.",
    steerReminder: "Keep going.",
    cites: [{ criterionId: "VAL-PARTICIPANT-NO-EVAL" }],
  };
  return async () => {
    counter.calls += 1;
    return assessment;
  };
}

async function fireTurnEnd(pi: FakePi, ctx: FakeTurnContext): Promise<void> {
  const handlers = pi.handlers.get("turn_end") ?? [];
  expect(handlers).toHaveLength(1);
  await handlers[0]!({}, ctx);
}

function evaluatorLogPath(projectDir: string, charterId: string): string {
  return join(projectDir, ".pi/charters", charterId, "evaluator-log.jsonl");
}

async function fileByteCount(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function reversePath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".pi/agent/sessions", sessionId, "charter.json");
}

describe("participant turn_end evaluator handling", () => {
  test("participant skips evaluator and upserts the charter reminder", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-participant";
      const charterId = await createActiveCharter(projectDir);
      await writeChildBinding({ sessionId, charterId, projectDir, homeDir, role: "participant" });
      const beforeBytes = await fileByteCount(evaluatorLogPath(projectDir, charterId));
      const counter = { calls: 0 };
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: countingModel(counter) });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(counter.calls).toBe(0);
      expect(await fileByteCount(evaluatorLogPath(projectDir, charterId))).toBe(beforeBytes);
      expect(pi.emittedEvents).toContainEqual(
        expect.objectContaining({
          channel: "reminder:upsert",
          payload: expect.objectContaining({ source: "pi-charter" }),
        }),
      );
    });
  });

  test("owner runs the evaluator", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-owner";
      const charterId = await createActiveCharter(projectDir);
      await bindCharterToSession(projectDir, { charterId, sessionId, homeDir });
      const counter = { calls: 0 };
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: countingModel(counter) });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(counter.calls).toBe(1);
      expect(await readFile(evaluatorLogPath(projectDir, charterId), "utf8")).toContain("on_track");
    });
  });

  test("legacy binding without role is treated as owner and runs the evaluator", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-legacy";
      const charterId = await createActiveCharter(projectDir);
      const path = reversePath(homeDir, sessionId);
      await mkdir(join(homeDir, ".pi/agent/sessions", sessionId), { recursive: true });
      await writeFile(
        path,
        JSON.stringify(
          {
            sessionId,
            charterId,
            projectDir,
            boundAt: "2026-05-18T00:02:00.000Z",
          },
          null,
          2,
        ),
      );
      const counter = { calls: 0 };
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: countingModel(counter) });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(counter.calls).toBe(1);
      expect(await readFile(evaluatorLogPath(projectDir, charterId), "utf8")).toContain("on_track");
    });
  });

  test("status skip wins before participant reminder upsert", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-participant-completed";
      const charterId = await createActiveCharter(projectDir);
      await writeChildBinding({ sessionId, charterId, projectDir, homeDir, role: "participant" });
      await forceCompleteCharter(projectDir, {
        charterId,
        target: "completed",
        reason: "done",
        now: "2026-05-18T00:03:00.000Z",
      });
      const beforeBytes = await fileByteCount(evaluatorLogPath(projectDir, charterId));
      const counter = { calls: 0 };
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: countingModel(counter) });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(counter.calls).toBe(0);
      expect(await fileByteCount(evaluatorLogPath(projectDir, charterId))).toBe(beforeBytes);
      expect(pi.emittedEvents).toHaveLength(0);
    });
  });
});
