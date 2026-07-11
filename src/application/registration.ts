import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { connect, type UtilsClient } from "pi-extension-utils";
import { Type } from "typebox";
import { abandonCharter, completeCharter, createCharter, getBoundCharterStatus, getCharterStatus, listCharterSummaries, pauseCharter, resumeCharter, type CharterServiceResult, type CharterStatusResult } from "./service";
import { CharterToolError } from "./errors";
import { tickToolResult, refreshSessionSnapshots } from "./staleness";
import { SUBAGENT_ALL_IDLE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../infrastructure/subagent-bridge";
import { logger } from "../infrastructure/logger";
import type { NextAction } from "../domain/types";
import { buildCharterWidgetView, renderCharterWidget } from "../ui/widget";
import { loadCharterWidgetStatus } from "../ui/widget-service";
import { createCharterPickerOverlay } from "../ui/charter-picker";
import { buildPickerSnapshot, listAllCharters } from "../ui/picker-snapshot";
import { charterDir } from "../infrastructure/store";

const CharterParams = Type.Object({
  action: StringEnum(["create", "list", "status", "pause", "resume", "complete", "abandon"] as const),
  id: Type.Optional(Type.String({ description: "Charter id, unique prefix, or unique slug fragment." })),
  objective: Type.Optional(Type.String({ description: "Required for action=create." })),
  note: Type.Optional(Type.String({ description: "Optional pause/complete note; required for abandon." })),
}, { additionalProperties: false });

type CharterInput = {
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon";
  id?: string;
  objective?: string;
  note?: string;
};

const RALPH_CUSTOM_TYPE = "charter-ralph-continue";
const WIDGET_KEY = "charter-detail";
export const RALPH_WIDGET_WARNING_EVENT = "pi-charter:ralph-warning";
export const RALPH_WIDGET_WARNING_CLEAR_EVENT = "pi-charter:ralph-warning-clear";
const RALPH_DEBOUNCE_MS = 20_000;
const RALPH_WARNING_LEAD_MS = 10_000;
const RALPH_INTERRUPT_DELAY_MS = 3 * 60_000;
const RALPH_MIN_INTERVAL_MS = 10_000;
const RALPH_LOG_COMPONENT = "ralph-loop";

export interface RegisterCharterRalphLoopOptions {
  debounceMs?: number;
  warningLeadMs?: number;
  interruptDelayMs?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export function registerCharterTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "charter",
    label: "Charter",
    description: "Manage pi-charter file-as-interface lifecycle actions.",
    promptSnippet: "Use charter({action,id?,objective?,note?}); edit charter.md directly for criteria and evidence.",
    promptGuidelines: [
      "There is exactly one pi-charter tool: charter.",
      "Edit .charters/<id>/charter.md directly to add criteria and Evidence lines.",
      "Follow returned nextActions instead of relying on removed legacy tools."
    ],
    parameters: CharterParams,
    async execute(_toolCallId, params: CharterInput, _signal, _onUpdate, ctx) {
      try {
        const result = await runCharterAction(ctx.cwd, params, ctx.sessionManager.getSessionId?.());
        return toolText(result.message, result.nextActions, result.data);
      } catch (error) {
        if (error instanceof CharterToolError) {
          return toolText(error.message, error.nextActions, { code: error.code }, true);
        }
        const message = error instanceof Error ? error.message : String(error);
        return toolText(message, [{ tool: "charter", action: "status", hint: "Inspect current charter state before retrying." }], undefined, true);
      }
    },
  });
}

export function registerCharterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("charter", {
    description: "pi-charter: create/list/status/pause/resume/complete/abandon",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const input = parseCommand(args);
      try {
        const result = await runCharterAction(ctx.cwd, input, ctx.sessionManager.getSessionId?.());
        ctx.ui.notify(result.message, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "warning");
      }
    },
  });

  pi.registerCommand("charters", {
    description: "Open the pi-charter picker/dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager.getSessionId?.();
      const client = connect(pi as never, { ctx: ctx as never, clientId: "pi-charter-picker" });
      try {
        const charters = await listAllCharters(ctx.cwd);
        const snapshots = new Map();
        await Promise.all(charters.map(async (row) => {
          const snapshot = await buildPickerSnapshot(ctx.cwd, row.charterId);
          if (snapshot) snapshots.set(row.charterId, snapshot);
        }));
        const bound = await getBoundCharterStatus(ctx.cwd, sessionId).catch(() => undefined);
        await client.ui.fullscreen(createCharterPickerOverlay({
          charters,
          snapshots,
          heightProvider: () => 24,
          initialCursorCharterId: bound?.charterId ?? charters[0]?.charterId,
          boundCharterId: bound?.charterId ?? null,
          host: {
            resolveCharterDir: (charterId) => charterDir(ctx.cwd, charterId),
            notify: (message, type) => ctx.ui.notify(message, type),
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "warning");
      } finally {
        client.dispose();
      }
    },
  });
}

export function registerCharterStalenessHooks(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "charter") return;
    const files = filesTouchedByToolResult(event);
    await tickToolResult(ctx.cwd, {
      sessionId: ctx.sessionManager.getSessionId?.(),
      files,
      source: event.toolName,
    });
  });
  pi.on("turn_end", async (_event, ctx) => {
    await refreshSessionSnapshots(ctx.cwd, ctx.sessionManager.getSessionId?.());
  });
}

export function registerCharterRalphLoop(pi: ExtensionAPI, options: RegisterCharterRalphLoopOptions = {}): void {
  const runningSubagents = new Set<string>();
  const debounceMs = options.debounceMs ?? RALPH_DEBOUNCE_MS;
  const warningLeadMs = options.warningLeadMs ?? RALPH_WARNING_LEAD_MS;
  const interruptDelayMs = options.interruptDelayMs ?? RALPH_INTERRUPT_DELAY_MS;
  const minIntervalMs = options.minIntervalMs ?? RALPH_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastCtx: ExtensionContext | undefined;
  let lastSentAt = 0;
  let interruptedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let disposed = false;
  const observedSignals = new WeakSet<AbortSignal>();

  const rememberCtx = (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
  };

  const clearWidgetWarning = (ctx: ExtensionContext) => {
    pi.events.emit(RALPH_WIDGET_WARNING_CLEAR_EVENT, { sessionId: ctx.sessionManager.getSessionId?.() });
  };

  const observeInterruption = (ctx: ExtensionContext) => {
    const signal = ctx.signal;
    if (!signal || observedSignals.has(signal)) return;
    observedSignals.add(signal);
    const interrupted = () => {
      interruptedUntil = now() + interruptDelayMs;
      scheduleRalph("turn-interrupted");
    };
    if (signal.aborted) interrupted();
    else signal.addEventListener("abort", interrupted, { once: true });
  };

  pi.on("session_start", rememberCtx);
  pi.on("agent_start", (event, ctx) => {
    rememberCtx(event, ctx);
    clearWidgetWarning(ctx);
    observeInterruption(ctx);
  });
  pi.on("message_update", (_event, ctx) => {
    clearWidgetWarning(ctx);
    observeInterruption(ctx);
  });
  pi.on("tool_call", (_event, ctx) => {
    clearWidgetWarning(ctx);
    observeInterruption(ctx);
  });
  pi.on("tool_result", (event, ctx) => {
    observeInterruption(ctx);
    const result = event as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
    if (result.isError && /\b(?:command )?(?:aborted|cancelled)\b/i.test(text)) {
      interruptedUntil = now() + interruptDelayMs;
      scheduleRalph("tool-interrupted");
    }
  });
  pi.on("turn_end", (event, ctx) => {
    rememberCtx(event, ctx);
    observeInterruption(ctx);
    scheduleRalph("turn_end");
  });
  pi.on("agent_end", (event, ctx) => {
    rememberCtx(event, ctx);
    const messages = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
    const interrupted = messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
    if (interrupted) interruptedUntil = now() + interruptDelayMs;
    scheduleRalph(interrupted ? "agent-end-interrupted" : "agent_end");
  });
  const stopAsyncStarted = pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as { runId?: string; id?: string } | undefined;
    const id = payload?.runId ?? payload?.id;
    if (id) runningSubagents.add(id);
    logger.debug("ralph: subagent started", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
  });
  const stopAsyncComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as { runId?: string; id?: string } | undefined;
    const id = payload?.runId ?? payload?.id;
    if (id) runningSubagents.delete(id);
    logger.debug("ralph: subagent complete", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
    scheduleRalph("subagent-complete");
  });
  const stopAllIdle = pi.events.on(SUBAGENT_ALL_IDLE_EVENT, () => {
    scheduleRalph("subagent-all-idle");
  });
  pi.on("session_shutdown", () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (warningTimer) clearTimeout(warningTimer);
    timer = undefined;
    warningTimer = undefined;
    lastCtx = undefined;
    runningSubagents.clear();
    stopAsyncStarted?.();
    stopAsyncComplete?.();
    stopAllIdle?.();
  });

  function scheduleRalph(trigger: string): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    if (warningTimer) clearTimeout(warningTimer);
    const delayMs = Math.max(debounceMs, interruptedUntil - now());
    if (delayMs <= 0) {
      logger.debug("ralph: immediate check scheduled", { component: RALPH_LOG_COMPONENT, trigger });
      void maybeSendRalph({ trigger });
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void maybeSendRalph({ trigger, fromDebounce: true });
    }, delayMs);
    const warningDelayMs = delayMs - warningLeadMs;
    if (warningLeadMs > 0 && warningDelayMs > 0) {
      warningTimer = setTimeout(() => {
        warningTimer = undefined;
        void warnBeforeRalph(warningLeadMs);
      }, warningDelayMs);
    }
    logger.debug("ralph: debounce scheduled", { component: RALPH_LOG_COMPONENT, trigger, delayMs, interrupted: interruptedUntil > now() });
  }

  async function warnBeforeRalph(remainingMs: number): Promise<void> {
    if (disposed) return;
    const ctx = lastCtx;
    if (!ctx || runningSubagents.size > 0) return;
    try {
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;
      const sessionId = ctx.sessionManager.getSessionId?.();
      const status = await getCharterStatus(ctx.cwd, { sessionId }).catch(() => undefined);
      if (!status || status.status !== "active") return;
      pi.events.emit(RALPH_WIDGET_WARNING_EVENT, {
        sessionId,
        charterId: status.charterId,
        deadlineAt: now() + remainingMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale after session replacement")) lastCtx = undefined;
      logger.debug("ralph: warning skipped", { component: RALPH_LOG_COMPONENT, error: message });
    }
  }

  async function maybeSendRalph(input: { trigger?: string; fromDebounce?: boolean } = {}): Promise<void> {
    if (disposed) return;
    if (sending) {
      logger.debug("ralph: skipped while send in progress", { component: RALPH_LOG_COMPONENT, trigger: input.trigger });
      return;
    }
    if (runningSubagents.size > 0) {
      logger.debug("ralph: skipped while subagents running", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, runningSubagents: runningSubagents.size });
      return;
    }
    const ctx = lastCtx;
    if (!ctx) {
      logger.debug("ralph: skipped without context", { component: RALPH_LOG_COMPONENT, trigger: input.trigger });
      return;
    }

    sending = true;
    try {
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        logger.debug("ralph: skipped while agent busy", { component: RALPH_LOG_COMPONENT, trigger: input.trigger });
        return;
      }
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
        logger.debug("ralph: skipped with pending messages", { component: RALPH_LOG_COMPONENT, trigger: input.trigger });
        return;
      }
      const at = now();
      if (minIntervalMs > 0 && at - lastSentAt < minIntervalMs) {
        const remainingMs = minIntervalMs - (at - lastSentAt);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void maybeSendRalph({ trigger: "min-interval" });
        }, remainingMs);
        logger.debug("ralph: min-interval suppressed; rescheduling", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, remainingMs, minIntervalMs });
        return;
      }
      const status = await getCharterStatus(ctx.cwd, { sessionId: ctx.sessionManager.getSessionId?.() }).catch((error) => {
        logger.debug("ralph: status lookup skipped", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
      if (!status || status.status !== "active") {
        logger.debug("ralph: skipped without active charter", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, status: status?.status });
        return;
      }
      const topBlocker = status.blockers[0] ?? "none";
      const stale = status.criteria.filter((criterion) => criterion.stale).map((criterion) => criterion.id);
      const repeatedFails = status.criteria.filter((criterion) => criterion.failCount >= 2 && criterion.evidence !== "pass").map((criterion) => `${criterion.id} failed ${criterion.failCount}x`);
      const nextIds = status.readyNext.length ? status.readyNext : status.criteria.filter((criterion) => criterion.evidence !== "pass").map((criterion) => criterion.id);
      const nextCriterion = status.criteria.find((criterion) => criterion.id === nextIds[0]);
      const content = [
        `Charter ${status.charterId} is still ${status.status} (running ${formatRunningTime(status.createdAt, at)}). You are its loop driver: pick the next criterion, do the work, verify it for real, then update the Evidence line in charter.md.`,
        ...(status.criteria.length === 0 ? ["The charter has no criteria yet, so it can never complete. Add observable `### C<n>.` criteria to charter.md now."] : []),
        `Evidence: pass=${status.evidenceCounts.pass} fail=${status.evidenceCounts.fail} none=${status.evidenceCounts.none}. Top blocker: ${topBlocker}.`,
        ...(stale.length ? [`Stale evidence (source changed since verification): ${stale.join(", ")}. Re-verify before completing.`] : []),
        ...(repeatedFails.length ? [`Repeated failures: ${repeatedFails.join(", ")}. Do not retry the same approach; change strategy or split the criterion.`] : []),
        ...(nextCriterion ? [`Work next on ${nextCriterion.id}: ${nextCriterion.title}. Prefer strong evidence — use it like a user (artifact in work/) > observe the real system > run tests.`] : []),
      ].join(" ");
      clearWidgetWarning(ctx);
      pi.sendMessage({
        customType: RALPH_CUSTOM_TYPE,
        content,
        display: true,
        details: {
          charterId: status.charterId,
          evidenceCounts: status.evidenceCounts,
          topBlocker,
          stale,
          readyNext: status.readyNext,
        },
      }, { deliverAs: "steer", triggerTurn: true });
      lastSentAt = at;
      logger.debug("ralph: message sent", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, charterId: status.charterId, payloadLength: content.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale after session replacement")) {
        lastCtx = undefined;
      }
      logger.debug("ralph: loop skipped", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, error: message });
    } finally {
      sending = false;
    }
  }
}

export function registerCharterRalphMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RALPH_CUSTOM_TYPE, (message, options, theme) => {
    const details = (message.details ?? {}) as { charterId?: string; evidenceCounts?: { pass: number; fail: number; none: number }; topBlocker?: string; stale?: string[]; readyNext?: string[] };
    const counts = details.evidenceCounts;
    const summary = [
      details.charterId ?? "charter",
      counts ? `${counts.pass}/${counts.pass + counts.fail + counts.none} pass` : undefined,
      details.readyNext?.length ? `next ${details.readyNext.join(",")}` : undefined,
      details.stale?.length ? `stale ${details.stale.join(",")}` : undefined,
    ].filter(Boolean).join(" · ");
    let text = theme.fg("warning", "↻ ralph ") + theme.fg("muted", summary);
    if (options.expanded) {
      const content = typeof message.content === "string" ? message.content : "";
      if (content) text += "\n" + theme.fg("dim", content);
    }
    return new Text(text, 0, 0);
  });
}

export function registerCharterFlags(_pi: ExtensionAPI): void {
  // Flags were tied to the old multi-file model; hard-cut runtime has no flags.
}

export interface RegisterCharterWidgetOptions {
  refreshMs?: number;
  warningRefreshMs?: number;
  now?: () => number;
}

export function registerCharterWidget(pi: ExtensionAPI, options: RegisterCharterWidgetOptions = {}): void {
  let client: UtilsClient | undefined;
  let lastCtx: ExtensionContext | undefined;
  let warningDeadlineAt: number | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let warningRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const refreshMs = options.refreshMs ?? 10_000;
  const warningRefreshMs = options.warningRefreshMs ?? 1_000;
  const now = options.now ?? (() => Date.now());

  const stopWarningRefresh = (): void => {
    if (warningRefreshTimer) clearInterval(warningRefreshTimer);
    warningRefreshTimer = undefined;
  };

  const getClient = (ctx: ExtensionContext): UtilsClient => {
    client ??= connect(pi as never, { ctx: ctx as never, clientId: "pi-charter" });
    return client;
  };

  const clear = (ctx: ExtensionContext): void => {
    getClient(ctx).widgets.remove("aboveEditor", WIDGET_KEY);
  };

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId?.();
    const status = await loadCharterWidgetStatus(ctx.cwd, { sessionId });
    const vm = buildCharterWidgetView(status, now());
    if (!vm) {
      clear(ctx);
      return;
    }
    const remainingMs = warningDeadlineAt === undefined ? 0 : Math.max(0, warningDeadlineAt - now());
    if (warningDeadlineAt !== undefined && remainingMs === 0) {
      warningDeadlineAt = undefined;
      stopWarningRefresh();
    }
    vm.ralphRemainingMs = remainingMs > 0 ? remainingMs : undefined;
    const factory: Parameters<UtilsClient["widgets"]["set"]>[2] = (_tui, theme) => ({
      render: (width: number) => renderCharterWidget({ width, theme, vm }),
      invalidate: () => {},
    });
    getClient(ctx).widgets.set("aboveEditor", WIDGET_KEY, factory, { order: 80 });
  };

  const safeRefresh = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await refresh(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale after session replacement")) lastCtx = undefined;
      logger.debug("widget: refresh skipped", { component: "charter-widget", error: message });
    }
  };

  const matchesLastSession = (sessionId: string | undefined): boolean => {
    if (!lastCtx) return false;
    try {
      return sessionId === lastCtx.sessionManager.getSessionId?.();
    } catch {
      lastCtx = undefined;
      return false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    await safeRefresh(ctx);
    if (!refreshTimer && refreshMs > 0) {
      refreshTimer = setInterval(() => {
        if (lastCtx) void safeRefresh(lastCtx);
      }, refreshMs);
    }
  });
  pi.on("tool_result", async (_event, ctx) => {
    lastCtx = ctx;
    await safeRefresh(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    lastCtx = ctx;
    await refresh(ctx);
  });
  const stopWarning = pi.events.on(RALPH_WIDGET_WARNING_EVENT, (raw: unknown) => {
    const payload = raw as { sessionId?: string; deadlineAt?: number };
    if (!matchesLastSession(payload.sessionId)) return;
    warningDeadlineAt = payload.deadlineAt;
    if (lastCtx) void safeRefresh(lastCtx);
    stopWarningRefresh();
    if (warningRefreshMs > 0) {
      warningRefreshTimer = setInterval(() => {
        if (lastCtx) void safeRefresh(lastCtx);
      }, warningRefreshMs);
    }
  });
  const stopWarningClear = pi.events.on(RALPH_WIDGET_WARNING_CLEAR_EVENT, (raw: unknown) => {
    const payload = raw as { sessionId?: string };
    if (!matchesLastSession(payload.sessionId)) return;
    warningDeadlineAt = undefined;
    stopWarningRefresh();
    if (lastCtx) void safeRefresh(lastCtx);
  });
  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    stopWarningRefresh();
    lastCtx = undefined;
    warningDeadlineAt = undefined;
    stopWarning?.();
    stopWarningClear?.();
    client?.dispose();
    client = undefined;
  });
}

async function runCharterAction(
  projectDir: string,
  params: CharterInput,
  sessionId?: string,
): Promise<CharterServiceResult | { message: string; nextActions: NextAction[]; data: CharterStatusResult; charterId: string; status: CharterStatusResult["status"] }> {
  switch (params.action) {
    case "create":
      return createCharter(projectDir, { objective: params.objective ?? "", sessionId });
    case "list":
      return listCharterSummaries(projectDir);
    case "status": {
      const status = await getCharterStatus(projectDir, { charterId: params.id, sessionId });
      return { charterId: status.charterId, status: status.status, message: formatCharterStatusText(status), data: status, nextActions: status.nextActions };
    }
    case "pause":
      return pauseCharter(projectDir, { charterId: params.id, note: params.note, sessionId });
    case "resume":
      return resumeCharter(projectDir, { charterId: params.id, sessionId });
    case "complete":
      return completeCharter(projectDir, { charterId: params.id, note: params.note, sessionId });
    case "abandon":
      return abandonCharter(projectDir, { charterId: params.id, note: params.note, sessionId });
  }
}

export function formatCharterStatusText(status: CharterStatusResult): string {
  const lines = [
    `charter ${status.charterId} ${status.status}`,
    `objective: ${status.objective}`,
    `running: ${formatRunningTime(status.createdAt, Date.now())}`,
    `evidence: pass=${status.evidenceCounts.pass} fail=${status.evidenceCounts.fail} none=${status.evidenceCounts.none}`,
  ];
  if (status.openEnded) lines.push("open-ended: no criteria; complete is not legal");
  if (status.criteria.length > 0) {
    lines.push("criteria:");
    for (const criterion of status.criteria) {
      const stale = criterion.stale ? " stale" : "";
      const deps = criterion.depends.length ? ` depends=${criterion.depends.join(",")}` : "";
      const fails = criterion.failCount >= 2 && criterion.evidence !== "pass" ? ` failed=${criterion.failCount}x` : "";
      lines.push(`- ${criterion.id} ${criterion.evidence}${stale}${deps}${fails}: ${criterion.title}`);
    }
  }
  if (status.blockers.length > 0) lines.push(`blockers: ${status.blockers.join("; ")}`);
  if (status.warnings.length > 0) lines.push(`warnings: ${status.warnings.join("; ")}`);
  lines.push(`ready-next: ${status.readyNext.length ? status.readyNext.join(", ") : "none"}`);
  lines.push(`nextActions: ${status.nextActions.map((action) => action.action ?? action.tool).join(", ") || "none"}`);
  return lines.join("\n");
}

function toolText(text: string, nextActions: NextAction[], data?: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: `${text}\nnextActions: ${JSON.stringify(nextActions)}` }],
    details: { nextActions, data },
  };
}

export function formatRunningTime(createdAt: string, nowMs: number): string {
  const created = Date.parse(createdAt);
  const elapsedMs = Number.isFinite(created) ? Math.max(0, nowMs - created) : 0;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function parseCommand(args: string): CharterInput {
  const text = args.trim();
  if (!text) return { action: "status" };
  const [action, ...rest] = text.split(/\s+/);
  const note = rest.join(" ").trim() || undefined;
  if (action === "create") return { action, objective: note };
  if (action === "list" || action === "status" || action === "pause" || action === "resume" || action === "complete" || action === "abandon") {
    return { action, note };
  }
  return { action: "status", id: action };
}

function filesTouchedByToolResult(event: { toolName: string; input?: unknown; details?: unknown; content?: unknown }): string[] {
  const files = new Set<string>();
  collectPathLike(event.input, files);
  collectPathLike(event.details, files);
  if (event.toolName === "bash") collectShellPathTokens(event.input, files);
  return [...files];
}

function collectPathLike(value: unknown, files: Set<string>, key = ""): void {
  if (!value) return;
  if (typeof value === "string") {
    if (isPathKey(key) && looksLikePath(value)) files.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLike(item, files, key);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectPathLike(child, files, childKey);
  }
}

function collectShellPathTokens(value: unknown, files: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string") return;
  for (const match of command.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|rs|go|java|c|cpp|h|hpp|yaml|yml))(?:\s|$)/g)) {
    if (match[1]) files.add(match[1]);
  }
}

function isPathKey(key: string): boolean {
  return /^(path|paths|file|files|filename|filenames|artifact|artifacts)$/i.test(key);
}

function looksLikePath(value: string): boolean {
  return value.length > 0 && !value.includes("\n") && (value.includes("/") || /\.[a-z0-9]+$/i.test(value));
}
