import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCharter, completeCharter, abandonCharter, listCharterSummaries, pauseCharter } from "../src/application/service";
import { RALPH_WIDGET_WARNING_CLEAR_EVENT, RALPH_WIDGET_WARNING_EVENT, registerCharterCommands, registerCharterRalphLoop, registerCharterWidget } from "../src/application/registration";
import * as store from "../src/infrastructure/store";

const LIFECYCLE_EVENT = "pi-charter:lifecycle-changed";

/** Wait for an asynchronous widget update by its visible effect, not a fixed delay. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

type SetWidgetCall = {
  key: string;
  content: unknown;
  options?: unknown;
};

type FakeCtx = {
  cwd: string;
  hasUI: boolean;
  ui: {
    setWidget: (key: string, content: unknown, options?: unknown) => void;
    notify: (message: string) => void;
  };
  sessionManager: { getSessionId: () => string | undefined };
};

function makeFakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>();
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const commands = new Map<string, { handler(args: string, ctx: FakeCtx): Promise<void> }>();
  const sent: string[] = [];
  return {
    handlers,
    commands,
    sendMessage(message: { content: string }) {
      sent.push(message.content);
    },
    sent,
    registerCommand(name: string, command: { handler(args: string, ctx: FakeCtx): Promise<void> }) {
      commands.set(name, command);
    },
    on(event: string, handler: (event: unknown, ctx: FakeCtx) => Promise<void> | void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on(event: string, listener: (payload: unknown) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
      },
      emit(event: string, payload: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
    },
  };
}

function makeCtx(projectDir: string, sessionId: string): { ctx: FakeCtx; calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  return {
    calls,
    ctx: {
      cwd: projectDir,
      hasUI: true,
      ui: {
        setWidget(key, content, options) {
          calls.push({ key, content, options });
        },
        notify() {},
      },
      sessionManager: { getSessionId: () => sessionId },
    },
  };
}

async function fireEvent(pi: ReturnType<typeof makeFakePi>, name: string, ctx: FakeCtx): Promise<void> {
  for (const h of pi.handlers.get(name) ?? []) await h({}, ctx);
}

describe("glance widget cleanup", () => {
  test("multi-charter widget file and identifiers are absent", async () => {
    await access("src/ui/multi-charter-widget.ts").then(
      () => expect.unreachable("src/ui/multi-charter-widget.ts should not exist"),
      (error: NodeJS.ErrnoException) => expect(error.code).toBe("ENOENT"),
    );

    for (const pattern of [
      "renderMultiCharterWidget",
      "buildMultiCharterViewModel",
      "MultiCharterWidgetVM",
      "MULTI_WIDGET_KEY",
      "charter-multi",
    ]) {
      const proc = Bun.spawn(["grep", "-r", pattern, "src/"], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(1);
    }
  });

  test("session-bound charter renders the detail widget", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-glance-project-"));
    const sessionId = "session-bound";
    const created = await createCharter(projectDir, {
      objective: "glance widget fixture",
      now: "2026-07-02T10:00:00.000Z",
      sessionId,
    });

    const pi = makeFakePi();
    registerCharterWidget(pi as never);
    const { ctx, calls } = makeCtx(projectDir, sessionId);
    await fireEvent(pi, "session_start", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe('pi-extension-utils-fallback:["pi-charter","aboveEditor","charter-detail"]');
    expect(typeof calls[0]?.content).toBe("function");
    expect(calls[0]?.options).toEqual({ placement: "aboveEditor" });

    const factory = calls[0]!.content as (tui: { terminal?: { columns?: number } }, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] };
    const lines = factory({ terminal: { columns: 100 } }, { fg: (_color, text) => text }).render(100);
    expect(lines.join("\n")).toContain("glance-widget-fixture");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(100);
    expect(created.charterId).toContain("glance-widget-fixture");
  });

  test("completion and abandonment remove the widget without removing dashboard history", async () => {
    for (const close of [completeCharter, abandonCharter]) {
      const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-terminal-widget-"));
      const created = await createCharter(projectDir, { objective: "Demo", sessionId: "s1" });
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir, "s1");
      await fireEvent(pi, "session_start", ctx);
      expect(typeof calls.at(-1)?.content).toBe("function");
      await close(projectDir, { sessionId: "s1", note: "Demo closed." });
      pi.events.emit(LIFECYCLE_EVENT, { action: "complete" });
      await until(() => calls.at(-1)?.content === undefined);
      expect(JSON.stringify(await listCharterSummaries(projectDir))).toContain(created.charterId);
    }
  });

  test("missing session binding removes only the detail widget", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-glance-project-"));
    const sessionId = "session-bound";
    await createCharter(projectDir, {
      objective: "glance widget fixture",
      now: "2026-07-02T10:00:00.000Z",
      sessionId,
    });

    const pi = makeFakePi();
    registerCharterWidget(pi as never);
    const { ctx, calls } = makeCtx(projectDir, sessionId);
    await fireEvent(pi, "session_start", ctx);
    ctx.sessionManager.getSessionId = () => "other-session";
    await fireEvent(pi, "session_start", ctx);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ key: 'pi-extension-utils-fallback:["pi-charter","aboveEditor","charter-detail"]', content: undefined, options: { placement: "aboveEditor" } });
  });

  describe("refresh publication", () => {
    type Component = { render(width: number): string[] };
    type Factory = (tui: unknown, theme: { fg(color: string, text: string): string }) => Component;

    /** Mounts published factories like Pi does, so later updates arrive as requestRender calls. */
    function makeMountedCtx(projectDir: string, sessionId: string) {
      const state = { publications: 0, removals: 0, mounted: undefined as Component | undefined };
      const tui = { requestRender: () => { state.publications += 1; } };
      const ctx: FakeCtx = {
        cwd: projectDir,
        hasUI: true,
        ui: {
          setWidget(_key, content) {
            if (typeof content === "function") {
              state.publications += 1;
              state.mounted = (content as Factory)(tui, { fg: (_color, text) => text });
            } else {
              state.removals += 1;
              state.mounted = undefined;
            }
          },
          notify() {},
        },
        sessionManager: { getSessionId: () => sessionId },
      };
      return { ctx, state, text: () => state.mounted?.render(100).join("\n") ?? "" };
    }

    const shutdowns: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const shutdown of shutdowns.splice(0)) await shutdown();
    });

    async function setupWithTicks() {
      const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-widget-ticks-"));
      await createCharter(projectDir, { objective: "Refresh fixture", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
      const clock = { now: Date.parse("2026-07-02T11:00:00.000Z") };
      const pi = makeFakePi();
      registerCharterWidget(pi as never, { warningRefreshMs: 5, now: () => clock.now });
      const mounted = makeMountedCtx(projectDir, "s1");
      await fireEvent(pi, "session_start", mounted.ctx);
      shutdowns.push(() => fireEvent(pi, "session_shutdown", mounted.ctx));
      return { projectDir, clock, pi, ...mounted };
    }

    async function setup() {
      const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-widget-refresh-"));
      await createCharter(projectDir, { objective: "Refresh fixture", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
      const clock = { now: Date.parse("2026-07-02T11:00:00.000Z") };
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      registerCharterWidget(pi as never, { warningRefreshMs: 0, now: () => clock.now });
      const mounted = makeMountedCtx(projectDir, "s1");
      await fireEvent(pi, "session_start", mounted.ctx);
      shutdowns.push(() => fireEvent(pi, "session_shutdown", mounted.ctx));
      return { projectDir, clock, pi, ...mounted };
    }

    test("lifecycle changes republish; ordinary tool results, turn ends and passing time do not read or publish", async () => {
      const { projectDir, clock, pi, ctx, state, text } = await setup();
      await pauseCharter(projectDir, { sessionId: "s1", note: "Paused for review." });
      const reads = [spyOn(store, "loadCharterState"), spyOn(store, "listCharterIds"), spyOn(store, "loadCharterText")];
      try {
        clock.now += 3_600_000;
        for (const event of ["tool_result", "turn_end", "tool_result"]) await fireEvent(pi, event, ctx);
        await Bun.sleep(20);
        expect(state.publications).toBe(1);
        expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);

        pi.events.emit(LIFECYCLE_EVENT, { action: "pause" });
        await until(() => state.publications === 2);
        expect(text()).toBe("charter refresh-fixture · paused");
      } finally {
        for (const spy of reads) spy.mockRestore();
      }
    });

    test("slash lifecycle commands update the widget without waiting for a turn, also after a session restart", async () => {
      const { pi, ctx, text } = await setup();
      const charter = pi.commands.get("charter")!;
      // Lifecycle listeners refresh asynchronously; wait for the visible state,
      // not a fixed delay that depends on filesystem speed and test-runner load.
      const expectWidget = async (expected: string): Promise<void> => {
        const deadline = Date.now() + 2_000;
        while (text() !== expected && Date.now() < deadline) await Bun.sleep(5);
        expect(text()).toBe(expected);
      };
      await charter.handler("pause", ctx);
      await expectWidget("charter refresh-fixture · paused");

      await fireEvent(pi, "session_shutdown", ctx);
      await fireEvent(pi, "session_start", ctx);
      await charter.handler("resume", ctx);
      await expectWidget("charter refresh-fixture · active");

      await charter.handler("complete Done.", ctx);
      await expectWidget("");
    });

    test("Ralph countdown ticks render from the cached view without filesystem access and stop when cleared", async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-widget-countdown-"));
      await createCharter(projectDir, { objective: "Refresh fixture", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
      const clock = { now: Date.parse("2026-07-02T11:00:00.000Z") };
      const pi = makeFakePi();
      registerCharterWidget(pi as never, { warningRefreshMs: 5, now: () => clock.now });
      const { ctx, state, text } = makeMountedCtx(projectDir, "s1");
      await fireEvent(pi, "session_start", ctx);
      shutdowns.push(() => fireEvent(pi, "session_shutdown", ctx));

      pi.events.emit(RALPH_WIDGET_WARNING_EVENT, { sessionId: "s1", deadlineAt: clock.now + 5_000 });
      await until(() => text().includes("continues in 5s"));

      const reads = [spyOn(store, "loadCharterState"), spyOn(store, "listCharterIds"), spyOn(store, "loadCharterText"), spyOn(store, "withCharterLock")];
      try {
        clock.now += 1_000;
        await until(() => text().includes("continues in 4s"));
        clock.now += 1_000;
        await until(() => text().includes("continues in 3s"));
        const beforeClear = state.publications;

        pi.events.emit(RALPH_WIDGET_WARNING_CLEAR_EVENT, { sessionId: "s1" });
        await until(() => text() === "charter refresh-fixture · active");
        const afterClear = state.publications;
        expect(afterClear).toBe(beforeClear + 1);
        clock.now += 10_000;
        await Bun.sleep(40);
        expect(state.publications).toBe(afterClear);
        expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
      } finally {
        for (const spy of reads) spy.mockRestore();
      }
    });

    test("an expired countdown drops itself and stops ticking", async () => {
      const { clock, pi, state, text } = await setupWithTicks();
      pi.events.emit(RALPH_WIDGET_WARNING_EVENT, { sessionId: "s1", deadlineAt: clock.now + 2_000 });
      await until(() => text().includes("continues in 2s"));
      clock.now += 2_000;
      await until(() => text() === "charter refresh-fixture · active");
      const settled = state.publications;
      clock.now += 5_000;
      await Bun.sleep(40);
      expect(state.publications).toBe(settled);
    });

    test("Ralph recovery and guard pause reach the widget through the real Ralph loop", async () => {
      const { projectDir, clock, pi, ctx, text } = await setupWithTicks();
      const [charterId] = await store.listCharterIds(projectDir);
      const journaled: unknown[] = [];
      const poll = setInterval(() => void store.readEvents(store.charterDir(projectDir, charterId!)).then((events) => {
        journaled.splice(0, journaled.length, ...events.filter((event) => event.type === "ralph_activated"));
      }), 5);
      shutdowns.push(async () => clearInterval(poll));
      registerCharterRalphLoop(pi as never, { debounceMs: 0, warningLeadMs: 0, minIntervalMs: 0, now: () => clock.now });
      const loop = Object.assign(ctx, { isIdle: () => true, hasPendingMessages: () => false });
      await fireEvent(pi, "session_start", loop);
      for (let sent = 1; sent <= 5; sent += 1) {
        await fireEvent(pi, "agent_end", loop);
        await until(() => pi.sent.length === sent);
        await until(() => journaled.length === sent); // the guard write ends the send; the next event would be skipped before it
        clock.now += 1_000;
      }
      await until(() => text() === "charter refresh-fixture · active · Ralph guard warning");
      await fireEvent(pi, "agent_end", loop);
      await until(() => text() === "charter refresh-fixture · paused by Ralph guard · /charter resume");
      expect(pi.sent).toHaveLength(5);
    });

    /**
     * Hold the next call of a store read after it has computed its real result, so a test can
     * start a newer lookup before this older one resolves (or fails).
     */
    function holdNextRead(name: "loadCharterState" | "listCharterIds") {
      const original: (...args: never[]) => Promise<unknown> = store[name];
      let settle!: (failure?: Error) => void;
      const gate = new Promise<void>((resolve, reject) => { settle = (failure) => (failure ? reject(failure) : resolve()); });
      const spy = spyOn(store, name).mockImplementationOnce((async (...args: never[]) => {
        const result = await original(...args);
        await gate;
        return result;
      }) as never);
      shutdowns.push(async () => spy.mockRestore());
      return { release: () => settle(), fail: (failure: Error) => settle(failure), started: () => spy.mock.calls.length > 0 };
    }

    test("an older binding read that resolves after a newer removal cannot bring the widget back", async () => {
      const { projectDir, pi, state, text } = await setup();
      const older = holdNextRead("loadCharterState");
      pi.events.emit(LIFECYCLE_EVENT, { action: "resume" });
      await until(older.started);

      await completeCharter(projectDir, { sessionId: "s1", note: "Done." });
      pi.events.emit(LIFECYCLE_EVENT, { action: "complete" });
      await until(() => state.removals === 1);

      older.release();
      await Bun.sleep(30);
      expect(text()).toBe("");
      expect(state).toMatchObject({ publications: 1, removals: 1 });
    });

    test("a binding read pending across a session restart is discarded, even for a reused context", async () => {
      const { pi, ctx, state, text } = await setup();
      const older = holdNextRead("loadCharterState");
      pi.events.emit(LIFECYCLE_EVENT, { action: "resume" });
      await until(older.started);

      await fireEvent(pi, "session_shutdown", ctx);
      ctx.sessionManager.getSessionId = () => "unbound";
      await fireEvent(pi, "session_start", ctx);
      expect(state.removals).toBe(1);

      older.release();
      await Bun.sleep(30);
      expect(text()).toBe("");
      expect(state).toMatchObject({ publications: 1, removals: 1 });
    });

    test("a superseded read that fails late does not detach the current context", async () => {
      const { projectDir, pi, ctx, text } = await setup();
      const older = holdNextRead("listCharterIds");
      pi.events.emit(LIFECYCLE_EVENT, { action: "resume" });
      await until(older.started);

      await fireEvent(pi, "session_start", ctx);
      older.fail(new Error("stale after session replacement"));
      await Bun.sleep(30);

      await pauseCharter(projectDir, { sessionId: "s1" });
      pi.events.emit(LIFECYCLE_EVENT, { action: "pause" });
      await until(() => text() === "charter refresh-fixture · paused");
    });

    test("a new session start republishes unchanged state and removal is not repeated", async () => {
      const { pi, ctx, state, text } = await setup();
      ctx.sessionManager.getSessionId = () => "unbound";
      await fireEvent(pi, "session_start", ctx);
      await fireEvent(pi, "session_start", ctx);
      expect(state).toMatchObject({ publications: 1, removals: 1 });

      ctx.sessionManager.getSessionId = () => "s1";
      await fireEvent(pi, "session_start", ctx);
      expect(state.publications).toBe(2);

      await fireEvent(pi, "session_shutdown", ctx);
      await fireEvent(pi, "session_start", ctx);
      expect(state.publications).toBe(3);
      expect(text()).toContain("refresh-fixture");
    });
  });
});
