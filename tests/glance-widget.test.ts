import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCharter, completeCharter, abandonCharter, listCharterSummaries, pauseCharter } from "../src/application/service";
import { RALPH_WIDGET_WARNING_EVENT, registerCharterWidget } from "../src/application/registration";

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
  return {
    handlers,
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
      await fireEvent(pi, "turn_end", ctx);
      expect(calls.at(-1)?.content).toBeUndefined();
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
    await fireEvent(pi, "turn_end", ctx);

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

    async function setup(options: { refreshMs?: number } = {}) {
      const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-widget-refresh-"));
      await createCharter(projectDir, { objective: "Refresh fixture", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
      const clock = { now: Date.parse("2026-07-02T11:00:00.000Z") };
      const pi = makeFakePi();
      registerCharterWidget(pi as never, { refreshMs: options.refreshMs ?? 0, warningRefreshMs: 0, now: () => clock.now });
      const mounted = makeMountedCtx(projectDir, "s1");
      await fireEvent(pi, "session_start", mounted.ctx);
      shutdowns.push(() => fireEvent(pi, "session_shutdown", mounted.ctx));
      return { projectDir, clock, pi, ...mounted };
    }

    test("unchanged tool results and timer ticks do not republish", async () => {
      const { pi, ctx, state } = await setup({ refreshMs: 5 });
      await fireEvent(pi, "tool_result", ctx);
      await fireEvent(pi, "tool_result", ctx);
      await Bun.sleep(30);

      expect(state.publications).toBe(1);
    });

    test("lifecycle and displayed elapsed changes republish", async () => {
      const { projectDir, clock, pi, ctx, state, text } = await setup();
      await pauseCharter(projectDir, { sessionId: "s1", note: "Paused for review." });
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(2);
      expect(text()).toContain("paused · 1h 00m");

      clock.now += 59_000;
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(2);

      clock.now += 1_000;
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(3);
      expect(text()).toContain("paused · 1h 01m");
    });

    test("Ralph warning countdown republishes once per displayed second", async () => {
      const { clock, pi, ctx, state, text } = await setup();
      pi.events.emit(RALPH_WIDGET_WARNING_EVENT, { sessionId: "s1", deadlineAt: clock.now + 5_000 });
      await Bun.sleep(50); // the warning listener refreshes without awaiting
      expect(state.publications).toBe(2);
      expect(text()).toContain("continues in 5s");

      clock.now += 400;
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(2);

      clock.now += 1_000;
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(3);
      expect(text()).toContain("continues in 4s");
    });

    test("removal is not repeated and a new session republishes unchanged state", async () => {
      const { pi, ctx, state, text } = await setup();
      ctx.sessionManager.getSessionId = () => "unbound";
      await fireEvent(pi, "tool_result", ctx);
      await fireEvent(pi, "tool_result", ctx);
      expect(state).toMatchObject({ publications: 1, removals: 1 });

      ctx.sessionManager.getSessionId = () => "s1";
      await fireEvent(pi, "tool_result", ctx);
      expect(state.publications).toBe(2);

      await fireEvent(pi, "session_shutdown", ctx);
      await fireEvent(pi, "session_start", ctx);
      expect(state.publications).toBe(3);
      expect(text()).toContain("refresh-fixture");
    });
  });
});
