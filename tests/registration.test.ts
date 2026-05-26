import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { lockPlan } from "../src/application/plan-service";
import { registerCharterRalphLoop } from "../src/application/registration";
import { amendCharter, createCharter, forceCompleteCharter } from "../src/application/service";
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
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-1, VAL-2, VAL-3, VAL-4, VAL-5, VAL-6]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
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

async function createBoundReviewCharter(input: { projectDir: string; homeDir: string; sessionId: string }): Promise<string> {
  const charterId = await createBoundActiveCharter(input);
  await forceCompleteCharter(input.projectDir, {
    charterId,
    target: "abandoned",
    reason: "test review fixture",
    now: "2026-05-15T00:03:00.000Z",
  });
  await amendCharter(input.projectDir, {
    charterId,
    target: "review",
    reason: "test review fixture",
    now: "2026-05-15T00:04:00.000Z",
  });
  return charterId;
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


describe("charter ralph loop idle gate", () => {
  test.each([
    ["planning" as const, createBoundPlanningCharter, "planning"],
    ["active" as const, createBoundActiveCharter, "active"],
    ["review" as const, createBoundReviewCharter, "active"],
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
      expect(message.content).toContain(`status: ${status}`);
      expect(message.content).toContain("legalNextActions:");
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
