import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCharter, getCharterStatus, pauseCharter } from "../src/application/service";
import { RALPH_WIDGET_WARNING_EVENT, registerCharterCommands, registerCharterRalphLoop, registerCharterTools, registerCharterWidget } from "../src/application/registration";
import { charterDir, loadCharterState, writeCharterState } from "../src/infrastructure/store";
import { SUBAGENT_ALL_IDLE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../src/infrastructure/subagent-bridge";

function fakeEvents() {
  return {
    on: () => () => undefined,
    emit: () => undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRalphHarness(project: string, sessionId = "s1", ctxOverrides: Record<string, unknown> = {}) {
  const handlers: Record<string, (event: unknown, context: any) => void | Promise<void>> = {};
  const emitter = new EventEmitter();
  const sent: Array<{ message: any; options: any }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const widgetWarnings: unknown[] = [];
  const pi = {
    on: (eventName: string, handler: (event: unknown, context: any) => void | Promise<void>) => {
      handlers[eventName] = handler;
      return () => undefined;
    },
    events: {
      on: (eventName: string, handler: (event: unknown) => void) => {
        emitter.on(eventName, handler);
        return () => emitter.off(eventName, handler);
      },
      emit: (eventName: string, event: unknown) => emitter.emit(eventName, event),
    },
    sendMessage: (message: any, options: any) => {
      sent.push({ message, options });
    },
  } as any;
  pi.events.on(RALPH_WIDGET_WARNING_EVENT, (payload: unknown) => widgetWarnings.push(payload));
  const ctx = {
    cwd: project,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message: string, type?: string) => { notifications.push({ message, type }); } },
    ...ctxOverrides,
  };

  return {
    pi,
    ctx,
    sent,
    notifications,
    widgetWarnings,
    fire: (eventName: string, event: unknown = {}, context = ctx) => handlers[eventName]?.(event, context),
    emit: (eventName: string, event: unknown = {}) => emitter.emit(eventName, event),
  };
}

describe("tool registration", () => {
  test("registers one charter tool and returns next actions", async () => {
    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    const pi = {
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
        tools.push(tool);
      },
    } as any;
    registerCharterTools(pi);
    expect(tools.map((tool) => tool.name)).toEqual(["charter"]);

    const project = await mkdtemp(join(tmpdir(), "pi-charter-registration-"));
    const ctx = { cwd: project, sessionManager: { getSessionId: () => "s1" } };
    const created = await tools[0].execute("call", { action: "create", objective: "Ship runtime" }, undefined, undefined, ctx);
    expect(created.isError).toBe(false);
    expect(created.details.nextActions.length).toBeGreaterThan(0);

    const status = await tools[0].execute("call", { action: "status" }, undefined, undefined, ctx);
    expect(status.isError).toBe(false);
    expect(status.content[0].text).toContain("nextActions");
    expect(status.details.nextActions.map((action: { action?: string }) => action.action)).toContain("status");
  });

  test("warns the user shortly before Ralph continues", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-warning-"));
    await createCharter(project, { objective: "Warn first", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 500, warningLeadMs: 300, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(250);

    expect(h.notifications).toHaveLength(0);
    expect(h.widgetWarnings).toHaveLength(1);
    expect(h.sent).toHaveLength(0);

    await delay(350);
    expect(h.sent).toHaveLength(1);
  });

  test("a warning callback ignores a context made stale by reload", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-stale-warning-"));
    await createCharter(project, { objective: "Ignore stale warning", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const staleCtx = {
      cwd: project,
      isIdle: () => { throw new Error("This extension ctx is stale after session replacement or reload."); },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => undefined },
    };
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 30, warningLeadMs: 20, minIntervalMs: 0 });

    h.fire("session_start", {}, staleCtx);
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(20);

    expect(h.widgetWarnings).toHaveLength(0);
    h.fire("session_shutdown");
  });

  test("reload shutdown cancels pending Ralph work and bridge listeners", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-reload-"));
    await createCharter(project, { objective: "Reload safely", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 30, warningLeadMs: 10, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    h.fire("session_shutdown");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(50);

    expect(h.notifications).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test("refreshes the widget on its own timer", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-widget-timer-"));
    await createCharter(project, { objective: "Ticking widget", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const handlers: Record<string, (event: unknown, ctx: any) => Promise<void> | void> = {};
    let setCount = 0;
    const ctx = {
      cwd: project,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      ui: { setWidget: () => { setCount++; } },
    };
    const pi = {
      events: fakeEvents(),
      on: (name: string, handler: (event: unknown, context: any) => Promise<void> | void) => { handlers[name] = handler; return () => undefined; },
    } as any;

    registerCharterWidget(pi, { refreshMs: 10 });
    await handlers.session_start({}, ctx);
    await delay(25);
    handlers.session_shutdown({}, ctx);

    expect(setCount).toBeGreaterThanOrEqual(2);
  });
});

describe("Ralph loop registration", () => {
  test("session-bound status lookup resolves an active charter", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-binding-"));
    const created = await createCharter(project, { objective: "Bound charter", now: "2026-07-02T10:00:00.000Z", sessionId: "session-x" });

    const status = await getCharterStatus(project, { sessionId: "session-x" });

    expect(status.charterId).toBe(created.charterId);
    expect(status.status).toBe("active");
  });

  test("all-idle sends one steer for an active charter", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-active-"));
    const created = await createCharter(project, { objective: "Keep going", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(60);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.customType).toBe("charter-ralph-continue");
    expect(h.sent[0].message.content).toContain(`Charter ${created.charterId} is still active`);
    expect(h.sent[0].message.content).toContain("no criteria yet");
    expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  test("agent_end also schedules a steer for subagent-free sessions", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-agent-end-"));
    await createCharter(project, { objective: "Plain loop", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("agent_end");
    await delay(10);

    expect(h.sent).toHaveLength(1);
  });

  test("an interrupted turn gets a longer quiet window", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-interrupted-"));
    await createCharter(project, { objective: "Respect interruption", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, interruptDelayMs: 30, minIntervalMs: 0 });

    h.fire("tool_result", {
      isError: true,
      content: [{ type: "text", text: "Command aborted" }],
    });
    h.fire("agent_end", { messages: [] });
    await delay(10);
    expect(h.sent).toHaveLength(0);

    await delay(30);
    expect(h.sent).toHaveLength(1);
  });

  test("debounce waits past agent_end all-idle emitted before ctx reports idle", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-agent-end-idle-"));
    await createCharter(project, { objective: "Settle after agent_end", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    let idle = false;
    const h = createRalphHarness(project, "s1", { isIdle: () => idle });
    registerCharterRalphLoop(h.pi, { debounceMs: 5, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    idle = true;
    await delay(20);

    expect(h.sent).toHaveLength(1);
  });

  test("does not steer for paused, completed, or missing charters", async () => {
    const pausedProject = await mkdtemp(join(tmpdir(), "pi-charter-ralph-paused-"));
    const paused = await createCharter(pausedProject, { objective: "Paused", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    await pauseCharter(pausedProject, { charterId: paused.charterId, note: "wait" });
    const pausedHarness = createRalphHarness(pausedProject);
    registerCharterRalphLoop(pausedHarness.pi, { debounceMs: 1, minIntervalMs: 0 });
    pausedHarness.fire("session_start");
    pausedHarness.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });

    const completedProject = await mkdtemp(join(tmpdir(), "pi-charter-ralph-completed-"));
    const completed = await createCharter(completedProject, { objective: "Completed", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const state = await loadCharterState(completedProject, completed.charterId);
    state.status = "completed";
    await writeCharterState(charterDir(completedProject, completed.charterId), state);
    const completedHarness = createRalphHarness(completedProject);
    registerCharterRalphLoop(completedHarness.pi, { debounceMs: 1, minIntervalMs: 0 });
    completedHarness.fire("session_start");
    completedHarness.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });

    const emptyProject = await mkdtemp(join(tmpdir(), "pi-charter-ralph-empty-"));
    const emptyHarness = createRalphHarness(emptyProject);
    registerCharterRalphLoop(emptyHarness.pi, { debounceMs: 1, minIntervalMs: 0 });
    emptyHarness.fire("session_start");
    emptyHarness.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });

    await delay(10);

    expect(pausedHarness.sent).toHaveLength(0);
    expect(completedHarness.sent).toHaveLength(0);
    expect(emptyHarness.sent).toHaveLength(0);
  });

  test("debounce collapses rapid idle events", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-debounce-"));
    await createCharter(project, { objective: "Debounced", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 5, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(20);

    expect(h.sent).toHaveLength(1);
  });

  test("min interval self-heals by rescheduling a suppressed idle check", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-min-interval-"));
    await createCharter(project, { objective: "Rate limited", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    let now = 1_000;
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 0, minIntervalMs: 5, now: () => now });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: now });
    await delay(25);
    expect(h.sent).toHaveLength(1);

    now = 1_001;
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: now });
    await delay(1);
    expect(h.sent).toHaveLength(1);

    now = 1_006;
    await delay(40);
    expect(h.sent).toHaveLength(2);
  });

  test("running subagent tracking waits for completion before steering", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-running-subagent-"));
    await createCharter(project, { objective: "Wait for child", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ASYNC_STARTED_EVENT, { runId: "child-1" });
    h.fire("agent_end");
    await delay(10);
    expect(h.sent).toHaveLength(0);

    h.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "child-1" });
    await delay(10);
    expect(h.sent).toHaveLength(1);
  });

  test("stale context errors are caught and the next turn context recovers", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-stale-"));
    await createCharter(project, { objective: "Recover", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const staleCtx = {
      cwd: project,
      isIdle: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => undefined },
    };
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("session_start", {}, staleCtx);
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(10);
    expect(h.sent).toHaveLength(0);

    h.fire("turn_end");
    await delay(10);
    expect(h.sent).toHaveLength(1);
  });
});

describe("command registration", () => {
  test("registers /charter and /charters commands", () => {
    const commands: Array<{ name: string }> = [];
    const pi = {
      events: fakeEvents(),
      registerCommand(name: string) {
        commands.push({ name });
      },
    } as any;

    registerCharterCommands(pi);

    expect(commands.map((command) => command.name)).toEqual(["charter", "charters"]);
  });

  test("/charters opens the restored fullscreen picker without mutating selection", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-command-picker-"));
    const created = await createCharter(project, { objective: "View this charter", now: "2026-07-02T10:00:00.000Z", sessionId: "other" });
    const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
    const customCalls: unknown[] = [];
    const pi = {
      events: fakeEvents(),
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands[name] = command;
      },
    } as any;
    registerCharterCommands(pi);

    await commands.charters.handler("", {
      cwd: project,
      sessionManager: { getSessionId: () => "current" },
      ui: {
        custom: async (factory: unknown, options: unknown) => {
          customCalls.push({ factory, options });
          return null;
        },
        notify: () => undefined,
        setWidget: () => undefined,
      },
    });

    expect(customCalls).toHaveLength(1);
    expect((customCalls[0] as { options: unknown }).options).toBeUndefined();
    expect((await loadCharterState(project, created.charterId)).sessionId).toBe("other");
  });
});

describe("widget registration", () => {
  test("sets the bound charter widget on session refresh", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-widget-registration-"));
    await createCharter(project, { objective: "Widget charter", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const handlers: Record<string, (event: unknown, ctx: any) => Promise<void> | void> = {};
    let widget: any;
    let placement: string | undefined;
    const ctx = {
      cwd: project,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      ui: {
        setWidget: (key: string, factory: any, opts: { placement?: string } = {}) => {
          if (key === "charter-detail") {
            widget = factory;
            placement = opts.placement;
          }
        },
      },
    };
    const pi = {
      events: fakeEvents(),
      on: (eventName: string, handler: (event: unknown, context: any) => Promise<void> | void) => {
        handlers[eventName] = handler;
        return () => undefined;
      },
    } as any;

    registerCharterWidget(pi);
    await handlers.session_start({}, ctx);

    expect(placement).toBe("aboveEditor");
    const component = widget({}, { fg: (_color: string, text: string) => text });
    const line = component.render(48)[0];
    expect(line).toContain("widget-charter");
    expect(visibleWidth(line)).toBe(60);
  });
});
