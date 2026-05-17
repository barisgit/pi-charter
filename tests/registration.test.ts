import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { lockPlan } from "../src/application/plan-service";
import { registerCharterEvaluator } from "../src/application/registration";
import { createCharter, forceCompleteCharter, pauseCharter } from "../src/application/service";
import type { EvaluatorAssessment, EvaluatorModelFn, EvaluatorVerdict } from "../src/application/evaluator-service";

type PiHandler = (event: unknown, ctx: FakeTurnContext) => unknown | Promise<unknown>;

interface FakePi {
  on(event: string, handler: PiHandler): void;
  sendMessage(message: unknown, options: { deliverAs?: string; triggerTurn?: boolean }): void;
  sentMessages: Array<{ message: unknown; options: { deliverAs?: string; triggerTurn?: boolean } }>;
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

function makeFakePi(): FakePi {
  const handlers = new Map<string, PiHandler[]>();
  const sentMessages: FakePi["sentMessages"] = [];
  return {
    handlers,
    sentMessages,
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
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-registration-project-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-registration-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function createBoundActiveCharter(input: { projectDir: string; homeDir: string; sessionId: string }): Promise<string> {
  const charter = await createCharter(input.projectDir, {
    objective: "Ship Ralph loop",
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(input.projectDir, ".pi/charters", charter.charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nShip Ralph loop\n## Criteria\n### VAL-1 Blocked verdict continues Ralph loop\nVerifier: manual\n### VAL-2 Drifting verdict continues Ralph loop\nVerifier: manual\n### VAL-3 Ready verdict continues Ralph loop\nVerifier: manual\n### VAL-4 On-track verdict does not continue Ralph loop\nVerifier: manual\n### VAL-5 Dormant statuses do not continue Ralph loop\nVerifier: manual\n### VAL-6 Same verdict dedup suppresses steer and trigger\nVerifier: manual\n## Scope and constraints\n- none\n`,
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-1, VAL-2, VAL-3, VAL-4, VAL-5, VAL-6]\npreconditions: []\n---\nbody\n`,
  );
  await lockPlan(input.projectDir, { charterId: charter.charterId, now: "2026-05-15T00:01:00.000Z", legacy: true });
  await bindCharterToSession(input.projectDir, {
    charterId: charter.charterId,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    now: "2026-05-15T00:02:00.000Z",
  });
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

function modelReturning(verdict: EvaluatorVerdict): EvaluatorModelFn {
  const assessment: EvaluatorAssessment = {
    verdict,
    confidence: 0.9,
    reason: `${verdict} reason for VAL-1`,
    steerReminder: `Handle ${verdict} next.`,
    cites: [{ criterionId: "VAL-1" }],
  };
  return async () => assessment;
}

async function fireTurnEnd(pi: FakePi, ctx: FakeTurnContext): Promise<void> {
  const handlers = pi.handlers.get("turn_end") ?? [];
  expect(handlers).toHaveLength(1);
  await handlers[0]!({}, ctx);
}

describe("charter evaluator registration", () => {
  test.each([
    ["blocked" as const],
    ["drifting" as const],
    ["ready_to_complete" as const],
  ])("%s verdict sends a steer that continues the Ralph loop", async (verdict) => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = `session-${verdict}`;
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: modelReturning(verdict) });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0]!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
    });
  });

  test("on_track verdict can send a steer without continuing the Ralph loop", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-on-track";
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: modelReturning("on_track") });
      await fireTurnEnd(pi, ctxFor(projectDir, sessionId));

      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0]!.options).toMatchObject({ deliverAs: "steer", triggerTurn: false });
    });
  });

  test("paused and budget_limited charters do not continue the Ralph loop", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const pausedSession = "session-paused";
      const pausedId = await createBoundActiveCharter({ projectDir, homeDir, sessionId: pausedSession });
      await pauseCharter(projectDir, { charterId: pausedId, now: "2026-05-15T00:03:00.000Z" });
      const pausedPi = makeFakePi();
      registerCharterEvaluator(pausedPi as never, { homeDir, modelFn: modelReturning("blocked") });
      await fireTurnEnd(pausedPi, ctxFor(projectDir, pausedSession));
      expect(pausedPi.sentMessages).toHaveLength(0);

      const limitedSession = "session-budget-limited";
      const limitedId = await createBoundActiveCharter({ projectDir, homeDir, sessionId: limitedSession });
      await forceCompleteCharter(projectDir, {
        charterId: limitedId,
        target: "budget_limited",
        reason: "turn budget exhausted",
        now: "2026-05-15T00:04:00.000Z",
      });
      const limitedPi = makeFakePi();
      registerCharterEvaluator(limitedPi as never, { homeDir, modelFn: modelReturning("blocked") });
      await fireTurnEnd(limitedPi, ctxFor(projectDir, limitedSession));
      expect(limitedPi.sentMessages).toHaveLength(0);
    });
  });

  test("same-verdict dedup suppresses both steer text and triggerTurn", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-dedup";
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();

      registerCharterEvaluator(pi as never, { homeDir, modelFn: modelReturning("drifting") });
      const ctx = ctxFor(projectDir, sessionId);
      await fireTurnEnd(pi, ctx);
      await fireTurnEnd(pi, ctx);

      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0]!.options.triggerTurn).toBe(true);
    });
  });
});
