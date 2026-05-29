import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { registerCharterRalphLoop } from "../src/application/registration";
import { createCharter } from "../src/application/service";
import { makeActiveCharter } from "./helpers/charter-fixtures";
import { logger } from "../src/infrastructure/logger";
import { SUBAGENT_ALL_IDLE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../src/infrastructure/subagent-bridge";

type PiHandler = (event: unknown, ctx: FakeTurnContext) => unknown | Promise<unknown>;

interface FakePi {
  on(event: string, handler: PiHandler): void;
  events: {
    on(event: string, handler: (payload: unknown) => unknown): () => void;
    emit(event: string, payload: unknown): void;
  };
  sendMessage(message: unknown, options: { deliverAs?: string; triggerTurn?: boolean }): void;
  sentMessages: Array<{ message: unknown; options: { deliverAs?: string; triggerTurn?: boolean } }>;
  handlers: Map<string, PiHandler[]>;
  eventHandlers: Map<string, Array<(payload: unknown) => unknown>>;
}

interface FakeTurnContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify(message: string, level?: string): void };
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, PiHandler[]>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const sentMessages: FakePi["sentMessages"] = [];
  return {
    handlers,
    eventHandlers,
    events: {
      on(event, handler) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
        return () => {
          const current = eventHandlers.get(event) ?? [];
          eventHandlers.set(event, current.filter((entry) => entry !== handler));
        };
      },
      emit(event, payload) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
    },
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
  const charterId = `ralph-active-${input.sessionId}`;
  await makeActiveCharter({
    projectDir: input.projectDir,
    charterId,
    objective: "Ship Ralph loop",
    now: "2026-05-15T00:00:00.000Z",
    criteria: [
      { id: "VAL-1", title: "Blocked verdict continues Ralph loop", because: "registration tests need a minimal valid active charter fixture" },
      { id: "VAL-2", title: "Drifting verdict continues Ralph loop", because: "registration tests need a minimal valid active charter fixture" },
      { id: "VAL-3", title: "Ready verdict continues Ralph loop", because: "registration tests need a minimal valid active charter fixture" },
      { id: "VAL-4", title: "On-track verdict does not continue Ralph loop", because: "registration tests need a minimal valid active charter fixture" },
      { id: "VAL-5", title: "Dormant statuses do not continue Ralph loop", because: "registration tests need a minimal valid active charter fixture" },
      { id: "VAL-6", title: "Same verdict dedup suppresses steer and trigger", because: "registration tests need a minimal valid active charter fixture" },
    ],
  });
  await bindCharterToSession(input.projectDir, {
    charterId,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    now: "2026-05-15T00:02:00.000Z",
  });
  return charterId;
}

async function createBoundPlanningCharter(input: { projectDir: string; homeDir: string; sessionId: string }): Promise<string> {
  const charter = await createCharter(input.projectDir, {
    objective: "Ship Ralph loop",
    now: "2026-05-15T00:00:00.000Z",
  });
  await bindCharterToSession(input.projectDir, {
    charterId: charter.charterId,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    now: "2026-05-15T00:02:00.000Z",
  });
  return charter.charterId;
}

function ctxFor(projectDir: string, sessionId: string, input: { idle?: boolean; pendingMessages?: boolean } = {}): FakeTurnContext {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    isIdle: () => input.idle ?? true,
    hasPendingMessages: () => input.pendingMessages ?? false,
  };
}


async function fireLifecycle(pi: FakePi, event: string, ctx: FakeTurnContext): Promise<void> {
  const handlers = pi.handlers.get(event) ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) await handler({}, ctx);
}

async function waitForSentMessages(pi: FakePi, count: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (pi.sentMessages.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface DebugSpy {
  calls: Array<{ message: string; context?: Record<string, unknown> }>;
  restore: () => void;
}

let activeDebugSpy: DebugSpy | undefined;
afterEach(() => {
  activeDebugSpy?.restore();
  activeDebugSpy = undefined;
  logger.setLevel("info");
});

function spyOnDebug(): DebugSpy {
  const calls: DebugSpy["calls"] = [];
  const spy = spyOn(logger, "debug").mockImplementation((message, context) => {
    calls.push({ message, context });
  });
  return { calls, restore: () => spy.mockRestore() };
}

async function waitForDebugMessage(spy: DebugSpy, message: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (spy.calls.some((call) => call.message === message)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}


describe("charter ralph loop idle gate", () => {
  test.each([
    ["active" as const, createBoundActiveCharter, "active"],
    ["active" as const, createBoundPlanningCharter, "active"],
  ])("fires in %s when root and async subagents are idle", async (status, createBound, promptCase) => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = `session-ralph-${status}`;
      await createBound({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();
      const ctx = ctxFor(projectDir, sessionId);

      registerCharterRalphLoop(pi as never, { homeDir, debounceMs: 0, minIntervalMs: 0 });
      await fireLifecycle(pi, "session_start", ctx);
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await waitForSentMessages(pi, 1);

      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0]!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
      const message = pi.sentMessages[0]!.message as { content?: string; details?: { promptCase?: string } };
      expect(message.details?.promptCase).toBe(promptCase);
      expect(message.content).toContain("status: active");
      expect(message.content).toContain("legalNextActions:");
    });
  });

  test("reschedules itself when min-interval blocks a fire so no all-idle dropout can stall ralph", async () => {
    // Repro of the dedupe blackhole: ralph fires once, then a second all-idle
    // arrives inside the min-interval window. Without self-heal that second
    // call would just `return` and rely on a future external all-idle to
    // escape — which may never come (idle host + idle subagents = no events).
    // The reschedule must guarantee ralph fires again once the window clears.
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-ralph-selfheal";
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();
      const ctx = ctxFor(projectDir, sessionId);

      let clock = 1_000;
      const now = () => clock;
      // 0ms debounce so the test runs fast; 50ms min-interval gives us a real
      // window to verify the self-heal path schedules a retry.
      registerCharterRalphLoop(pi as never, { homeDir, debounceMs: 0, minIntervalMs: 50, now });
      await fireLifecycle(pi, "session_start", ctx);

      // First fire — records lastSentAt = 1000.
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await waitForSentMessages(pi, 1);
      expect(pi.sentMessages).toHaveLength(1);

      // Second all-idle 10ms later — inside min-interval, must NOT send but
      // MUST self-reschedule. Advance the simulated clock to mid-window.
      clock = 1_010;
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      // Give the synchronous setTimeout chain a brief tick to install the
      // rescheduled timer, but stay inside the 50ms window so it can't yet
      // refire on its own.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(pi.sentMessages).toHaveLength(1);

      // Advance the clock past the min-interval and wait for the rescheduled
      // retry. No further all-idle events fire here — if the loop weren't
      // self-healing, this assertion would time out.
      clock = 1_100;
      await waitForSentMessages(pi, 2);
      expect(pi.sentMessages).toHaveLength(2);
    });
  });

  test("emits an ordered debug trace for debounce, min-interval suppression, reschedule, and send", async () => {
    logger.setLevel("debug");
    const debugSpy = spyOnDebug();
    activeDebugSpy = debugSpy;

    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-ralph-debug-trace";
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();
      const ctx = ctxFor(projectDir, sessionId);

      let clock = 1_000;
      const now = () => clock;
      registerCharterRalphLoop(pi as never, { homeDir, debounceMs: 5, minIntervalMs: 50, now });
      await fireLifecycle(pi, "session_start", ctx);

      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await waitForSentMessages(pi, 1);

      clock = 1_010;
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await waitForDebugMessage(debugSpy, "ralph: min-interval suppressed; rescheduling");
      expect(pi.sentMessages).toHaveLength(1);

      clock = 1_100;
      await waitForSentMessages(pi, 2);

      expect(debugSpy.calls.map((call) => call.message)).toEqual([
        "ralph: all-idle event received",
        "ralph: debounce scheduled",
        "ralph: debounce fired",
        "ralph: message sent",
        "ralph: all-idle event received",
        "ralph: debounce scheduled",
        "ralph: debounce fired",
        "ralph: min-interval suppressed; rescheduling",
        "ralph: reschedule timer fired",
        "ralph: message sent",
      ]);
      expect(debugSpy.calls[0]!.context).toEqual({ component: "ralph-loop" });
      expect(debugSpy.calls[1]!.context).toEqual({ component: "ralph-loop", debounceMs: 5 });
      expect(debugSpy.calls[2]!.context).toEqual({ component: "ralph-loop" });
      expect(debugSpy.calls[7]!.context).toEqual({ component: "ralph-loop", remainingMs: 40, minIntervalMs: 50 });
      expect(debugSpy.calls[8]!.context).toEqual({ component: "ralph-loop" });
      expect(debugSpy.calls[9]!.context).toMatchObject({ component: "ralph-loop", payloadKind: "charter-ralph-continue" });
      expect(typeof debugSpy.calls[9]!.context?.payloadLength).toBe("number");
      expect(debugSpy.calls[9]!.context?.payloadLength).toBeGreaterThan(0);
    });
  });

  test("stays silent while an async child is busy", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const sessionId = "session-ralph-async-busy";
      await createBoundActiveCharter({ projectDir, homeDir, sessionId });
      const pi = makeFakePi();
      const ctx = ctxFor(projectDir, sessionId);

      registerCharterRalphLoop(pi as never, { homeDir, debounceMs: 0, minIntervalMs: 0 });
      await fireLifecycle(pi, "session_start", ctx);
      pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { runId: "busy-child" });
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(pi.sentMessages).toHaveLength(0);

      pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "busy-child", exitCode: 0 });
      pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, {});
      await waitForSentMessages(pi, 1);

      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0]!.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
    });
  });
});
