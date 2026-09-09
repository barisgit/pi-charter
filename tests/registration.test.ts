import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCharter, getCharterStatus, pauseCharter } from "../src/application/service";
import { RALPH_WIDGET_WARNING_EVENT, formatCharterStatusText, registerCharterCommands, registerCharterFileHooks, registerCharterRalphLoop, registerCharterRalphMessageRenderer, registerCharterTools, registerCharterWidget } from "../src/application/registration";
import type { CharterStatusResult } from "../src/application/service";
import { charterDir, loadCharterState, writeCharterState } from "../src/infrastructure/store";
import { SUBAGENT_ALL_IDLE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../src/infrastructure/subagent-bridge";

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
    const tools: any[] = [];
    const pi = {
      events: fakeEvents(),
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any;
    registerCharterTools(pi);
    expect(tools.map((tool) => tool.name)).toEqual(["charter"]);
    expect(tools[0].renderShell).toBe("self");
    const renderTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const callText = tools[0].renderCall(
      { action: "create", objective: "Ship runtime" },
      renderTheme,
      { lastComponent: undefined },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(callText).toBe(' charter create "Ship runtime"');

    const project = await mkdtemp(join(tmpdir(), "pi-charter-registration-"));
    const ctx = { cwd: project, sessionManager: { getSessionId: () => "s1" } };
    const created = await tools[0].execute("call", { action: "create", objective: "Ship runtime" }, undefined, undefined, ctx);
    expect(created.isError).toBe(false);
    expect(created.details.nextActions.length).toBeGreaterThan(0);
    expect(created.content[0].text).toContain("\nnext: status,pause,complete,abandon");
    expect(created.content[0].text).not.toContain("hint");
    const collapsed = tools[0].renderResult(
      created,
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { action: "create", objective: "Ship runtime" }, isError: false },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(collapsed).toBe(" created ship-runtime");
    expect(collapsed).not.toContain("next");
    const expanded = tools[0].renderResult(
      created,
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: "create", objective: "Ship runtime" }, isError: false },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(expanded).toContain(" next status · pause · complete · abandon");
    expect(expanded).toContain("Refine the Objective");
    expect(expanded.split("\n").every((line: string) => line === "" || line.startsWith(" "))).toBe(true);

    const status = await tools[0].execute("call", { action: "status" }, undefined, undefined, ctx);
    expect(status.isError).toBe(false);
    expect(status.content[0].text).toContain("next: status,pause,complete,abandon");
    expect(status.details.nextActions.map((action: { action?: string }) => action.action)).toContain("status");
    const statusSummary = tools[0].renderResult(
      status,
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { action: "status" }, isError: false },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(statusSummary).toBe(" active ship-runtime · phase 1/1 · Explore phases");
    const statusExpanded = tools[0].renderResult(
      status,
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: "status" }, isError: false },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(statusExpanded).toContain(" Objective\n Ship runtime");
    expect(statusExpanded).toContain(" Phases\n 1. Explore phases — current");
    expect(statusExpanded).toContain(" next status · pause · complete · abandon");

    const duplicate = await tools[0].execute("call", { action: "create", objective: "Another" }, undefined, undefined, ctx);
    const errorText = tools[0].renderResult(
      duplicate,
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { action: "create", objective: "Another" }, isError: true },
    ).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(errorText).toMatch(/^ Session already has active charter/);
    expect(errorText).not.toContain("error:");

    const renderers: Record<string, any> = {};
    registerCharterRalphMessageRenderer({ registerMessageRenderer(type: string, renderer: any) { renderers[type] = renderer; } } as any);
    const message = { customType: "charter-ralph-continue", content: "Charter x: continue.\n\nObjective:\nShip runtime", details: { charterId: created.details.data.charterId, kind: "recovery", currentPhase: "Explore phases" } };
    const collapsedRalph = renderers["charter-ralph-continue"](message, { expanded: false, outputPad: 1 }, renderTheme).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(collapsedRalph).toBe(" ralph ship-runtime · Explore phases · recovery: pause follows another activation within 5 min");
    const expandedRalph = renderers["charter-ralph-continue"](message, { expanded: true, outputPad: 1 }, renderTheme).render(120).map((line: string) => line.trimEnd()).join("\n");
    expect(expandedRalph).toContain("Ship runtime");
    expect(expandedRalph.split("\n").every((line: string) => line === "" || line.startsWith(" "))).toBe(true);
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

  test("a prompted turn re-arms Ralph after the session is reopened", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-reopen-"));
    await createCharter(project, { objective: "Resume the loop", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("session_start", { reason: "startup" });
    h.fire("session_shutdown", { reason: "quit" });
    h.fire("session_start", { reason: "resume" });
    h.fire("agent_end");
    await delay(10);

    expect(h.sent).toHaveLength(1);

    h.emit(SUBAGENT_ASYNC_STARTED_EVENT, { runId: "child-after-reopen" });
    h.fire("agent_end");
    await delay(10);
    expect(h.sent).toHaveLength(1);

    h.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "child-after-reopen" });
    await delay(10);
    expect(h.sent).toHaveLength(2);
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

test("status text shows the current phase without a verification checklist", () => {
  const status: CharterStatusResult = {
    charterId: "20260714-170000-compact", status: "active", objective: "Ship the compact contract.",
    references: "", scope: "", createdAt: "2026-07-14T17:00:00.000Z", legacy: false, charterMarkdown: "",
    phases: [
      { number: 1, title: "Explore", status: "done", body: "" },
      { number: 2, title: "Deliver", status: "current", body: "![Real UI](work/ui.png)" },
      { number: 3, title: "Verify integration", status: "upcoming", body: "" },
    ],
    phaseCounts: { done: 1, current: 1, upcoming: 1 }, warnings: [], reportExists: false, nextActions: [],
  };
  const text = formatCharterStatusText(status);
  expect(text).toContain("active · 1/3 phases done");
  expect(text).toContain("phase 2/3: Deliver");
  expect(text).not.toContain("stale");
  expect(text).not.toContain("report: missing");
  expect(text).not.toContain("33%");
});

describe("Ralph loop registration", () => {
  test("recovery is the fifth message; the sixth pauses and only the user command can resume", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-guard-"));
    const created = await createCharter(project, { objective: "Finish the entire objective", sessionId: "s1" });
    const state = await loadCharterState(project, created.charterId);
    state.ralph = { activations: [1, 2, 3, 4] };
    await writeCharterState(charterDir(project, created.charterId), state);
    let clock = 1000;
    const h = createRalphHarness(project);
    const tools: any[] = [];
    const commands = new Map<string, any>();
    h.pi.registerTool = (tool: any) => tools.push(tool);
    h.pi.registerCommand = (name: string, command: any) => commands.set(name, command);
    registerCharterTools(h.pi);
    registerCharterCommands(h.pi);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0, now: () => clock });
    h.fire("session_start");
    h.fire("agent_end");
    await delay(60);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.details.kind).toBe("recovery");
    expect(h.sent[0].message.content).toContain("RECOVERY:");
    // Bookkeeping and reloading the extension must not clear the persisted warning.
    await writeFile(join(charterDir(project, created.charterId), "charter.md"), "# Objective\nFinish the entire objective\n\n## Phases\n1. Keep working — current\n");
    h.fire("session_shutdown");
    h.fire("session_start");
    clock += 1;
    h.fire("agent_end");
    await delay(60);
    expect(h.sent).toHaveLength(1);
    expect((await loadCharterState(project, created.charterId)).status).toBe("paused");
    const denied = await tools[0].execute("resume", { action: "resume" }, undefined, undefined, h.ctx);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("/charter resume");
    await commands.get("charter").handler("resume", h.ctx);
    await delay(60);
    expect((await loadCharterState(project, created.charterId)).status).toBe("active");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].message.details.kind).toBe("normal");
    h.fire("session_shutdown");
  });

  test("an explicit pause cancels a queued automatic continuation", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-cancel-"));
    await createCharter(project, { objective: "Respect user control", sessionId: "s1" });
    const h = createRalphHarness(project, "s1", { abort: () => { throw new Error("must not abort unrelated work"); } });
    const tools: any[] = [];
    h.pi.registerTool = (tool: any) => tools.push(tool);
    registerCharterTools(h.pi);
    registerCharterRalphLoop(h.pi, { debounceMs: 100, warningLeadMs: 0, minIntervalMs: 0 });
    h.fire("session_start");
    h.fire("agent_end");
    const paused = await tools[0].execute("pause", { action: "pause", note: "User requested a pause" }, undefined, undefined, h.ctx);
    expect(paused.isError).toBe(false);
    await delay(130);
    expect(h.sent).toHaveLength(0);
    h.fire("session_shutdown");
  });
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
    expect(h.sent[0].message.content).toContain(`.charters/${created.charterId}/charter.md`);
    expect(h.sent[0].message.content).toContain("Preserve the full Objective");
    expect(h.sent[0].message.content).toContain("screenshots or recordings");
    expect(h.sent[0].message.content).not.toContain("no criteria yet");
    expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  test("does not warn or steer for a sole active charter bound to another session", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-unbound-"));
    await createCharter(project, { objective: "Other session", now: "2026-07-02T10:00:00.000Z", sessionId: "other" });
    const h = createRalphHarness(project, "current");
    registerCharterRalphLoop(h.pi, { debounceMs: 30, warningLeadMs: 20, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
    await delay(50);

    expect(h.widgetWarnings).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test("done phases still require an Objective audit, not automatic completion", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-complete-"));
    const created = await createCharter(project, { objective: "Finish cleanly", sessionId: "s1" });
    await writeFile(join(charterDir(project, created.charterId), "charter.md"), "# Objective\nFinish cleanly\n\n## Phases\n1. Explore phases — done\n");
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });
    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT);
    await delay(40);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.content).toContain("All phases marked done is not proof");
    expect(h.sent[0].message.content).not.toContain("curate it, then retry");
    expect((await loadCharterState(project, created.charterId)).status).toBe("active");
    h.fire("session_shutdown");
  });

  test("Ralph preserves the Objective and phase orientation without prescribing stale verification", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-work-"));
    const created = await createCharter(project, { objective: "Work deliberately", sessionId: "s1" });
    await writeFile(join(charterDir(project, created.charterId), "charter.md"), "# Objective\nWork deliberately\n\n## Phases\n1. Exercise the runtime — current\n");
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });
    h.fire("session_start");
    h.emit(SUBAGENT_ALL_IDLE_EVENT);
    await delay(40);
    const content = h.sent[0].message.content as string;
    expect(content).toContain("Current phase 1: Exercise the runtime");
    expect(content).toContain("Capture evidence while verifying");
    expect(content).toContain(`Charter .charters/${created.charterId}/charter.md:`);
    expect(content).not.toContain("update Status");
    expect(content).not.toContain("Reverify stale");
    h.fire("session_shutdown");
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

  test("child run completion releases Ralph after all subagents become idle", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-child-run-complete-"));
    await createCharter(project, { objective: "Resume after parallel child", now: "2026-07-02T10:00:00.000Z", sessionId: "s1" });
    const h = createRalphHarness(project);
    registerCharterRalphLoop(h.pi, { debounceMs: 1, minIntervalMs: 0 });

    h.fire("session_start");
    h.emit(SUBAGENT_ASYNC_STARTED_EVENT, { runId: "child-1" });
    h.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, { runId: "child-1" });
    h.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
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

  test("/charters replaces and restores the fullscreen viewport layout root", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-command-picker-"));
    const created = await createCharter(project, { objective: "View this charter", now: "2026-07-02T10:00:00.000Z", sessionId: "other" });
    const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
    const priorRoot = { invalidateCount: 0, invalidate() { this.invalidateCount++; } };
    const layoutRoots: unknown[] = [];
    const forcedRenders: unknown[] = [];
    const tui = {
      mode: "fullscreen",
      terminal: { rows: 30 },
      layoutRoot: priorRoot as unknown,
      setLayoutRoot(root: unknown) {
        this.layoutRoot = root;
        layoutRoots.push(root);
      },
      requestRender(force?: boolean) {
        forcedRenders.push(force);
      },
    };
    const renderTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
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
        custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: null) => void) => any, options: unknown) => {
          expect(options).toEqual({
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
          });
          return await new Promise<null>((resolve) => {
            const inputProxy = factory(tui, renderTheme, {}, resolve);
            const pickerRoot = tui.layoutRoot as { render(width: number): string[] };
            expect(pickerRoot).not.toBe(priorRoot);
            expect(pickerRoot.render(100).join("\n")).toContain(created.charterId);
            expect(inputProxy).not.toBe(pickerRoot);
            expect(inputProxy.render(100)).toEqual([]);
            inputProxy.handleInput("q");
          });
        },
        notify: () => undefined,
        setWidget: () => undefined,
      },
    });

    expect(layoutRoots).toHaveLength(2);
    expect(layoutRoots[1]).toBe(priorRoot);
    expect(tui.layoutRoot).toBe(priorRoot);
    expect(priorRoot.invalidateCount).toBe(1);
    expect(forcedRenders).toEqual([true, true]);
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
          if (key === 'pi-extension-utils-fallback:["pi-charter","aboveEditor","charter-detail"]') {
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
    expect(visibleWidth(line)).toBe(48);
  });
});


test("read, search, artifact and source tool results cannot invalidate phase evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-observation-"));
  const created = await createCharter(project, { objective: "Keep verified work while implementing", sessionId: "s1" });
  const dir = charterDir(project, created.charterId);
  const beforeState = await readFile(join(dir, "state.json"), "utf8");
  const beforeEvents = await readFile(join(dir, "events.jsonl"), "utf8");
  const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
  registerCharterFileHooks({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
  const ctx = { cwd: project, sessionManager: { getSessionId: () => "s1" } };
  for (const toolName of ["read", "ls", "ast_grep", "run", "bash", "write"]) {
    await handlers.tool_result({ toolName, input: { path: "src/application.ts", command: "cat docs/plan.md" }, details: { artifacts: ["work/screen.png"] } }, ctx);
  }
  expect(await readFile(join(dir, "state.json"), "utf8")).toBe(beforeState);
  expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(beforeEvents);
  const status = await getCharterStatus(project, { charterId: created.charterId });
  expect(status).not.toHaveProperty("criteria");
  expect(status).not.toHaveProperty("blockers");
});
