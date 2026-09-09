import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { connect, type UtilsClient } from "pi-extension-utils";
import { Type } from "typebox";
import { abandonCharter, completeCharter, createCharter, getBoundCharterStatus, getCharterStatus, listCharterSummaries, pauseCharter, resumeCharter, type CharterServiceResult, type CharterStatusResult } from "./service";
import { CharterToolError } from "./errors";
import { refreshSessionSnapshots } from "./snapshots";
import { attemptRalphActivation, renderRalphPrompt, RALPH_GUARD_PAUSE_NOTE } from "./ralph";
import { SUBAGENT_ALL_IDLE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../infrastructure/subagent-bridge";
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
const LIFECYCLE_EVENT = "pi-charter:lifecycle-changed";
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
    renderShell: "self",
    promptSnippet: "Lifecycle: charter({action,id?,objective?,note?}). File interface: .charters/<id>/charter.md.",
    promptGuidelines: [
      "Keep the full Objective in charter.md; evolve a simple numbered phase map rather than a parallel task/criteria ledger.",
      "Capture screenshots or recordings while verifying user-visible workflows, link them in phase notes, and curate REPORT.md from real artifacts before completing.",
      "Before complete, audit the full Objective and authoritative references against current evidence; phase completion alone is not proof.",
      "Use each result's next actions; they are the legal lifecycle transitions.",
    ],
    parameters: CharterParams,
    renderCall(args, theme) {
      const action = args.action ?? "...";
      let text = theme.fg("toolTitle", theme.bold("charter"));
      text += ` ${theme.fg("accent", action)}`;
      if (action === "create" && args.objective) {
        text += ` ${theme.fg("muted", JSON.stringify(compactInline(args.objective, 64)))}`;
      } else if (args.id) {
        text += ` ${theme.fg("muted", compactInline(displayName(args.id), 48))}`;
      }
      if (action !== "create" && args.note) {
        text += ` ${theme.fg("dim", JSON.stringify(compactInline(args.note, 64)))}`;
      }
      return new Text(text, TOOL_PAD, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "working"), TOOL_PAD, 0);
      const details = (result.details ?? {}) as { nextActions?: NextAction[]; data?: unknown };
      const raw = result.content
        .filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const message = raw.split(/\nnext:/, 1)[0] ?? raw;
      const isError = context.isError || (result as { isError?: boolean }).isError === true;
      const lines = isError
        ? [theme.fg("error", compactInline(message, 200))]
        : charterResultSummary(context.args as CharterInput, details.data, message, theme);
      if (expanded) lines.push(...charterResultDetails(context.args as CharterInput, details, message, isError, theme));
      return new Text(lines.join("\n"), TOOL_PAD, 0);
    },
    async execute(_toolCallId, params: CharterInput, _signal, _onUpdate, ctx) {
      try {
        const result = await runCharterAction(ctx.cwd, params, ctx.sessionManager.getSessionId?.());
        if (params.action !== "status" && params.action !== "list") pi.events.emit(LIFECYCLE_EVENT, { action: params.action });
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

function compactInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  return inline.length <= maxLength ? inline : `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** One column of left padding: self-shell tool rows get no Box padding. */
const TOOL_PAD = 1;

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function displayName(charterId: string): string {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(charterId);
  return match?.[1] ?? charterId;
}

function lifecycleColor(status: string): string {
  if (status === "completed") return "success";
  if (status === "abandoned") return "error";
  if (status === "paused") return "warning";
  return "accent";
}

function phaseColor(status: string): string {
  return status === "done" ? "success" : status === "current" ? "accent" : "dim";
}

/** Collapsed result: lifecycle verb or state, then the charter name and phase orientation. */
function charterResultSummary(args: CharterInput, data: unknown, fallback: string, theme: RenderTheme): string[] {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
  const charterId = typeof record?.charterId === "string" ? record.charterId : undefined;
  const name = charterId ? theme.fg("text", displayName(charterId)) : "";
  if (args.action === "list" && Array.isArray(data)) {
    return [theme.fg("muted", `${data.length} charter${data.length === 1 ? "" : "s"}`)];
  }
  if (args.action === "status" && record) {
    const phases = (record.phases ?? []) as CharterStatusResult["phases"];
    const status = typeof record.status === "string" ? record.status : "status";
    const parts = [`${theme.fg(lifecycleColor(status), status)} ${name}`];
    const current = phases.find((phase) => phase.status === "current");
    if (record.legacy) parts.push(theme.fg("warning", "legacy, read-only"));
    else if (current) parts.push(theme.fg("muted", `phase ${current.number}/${phases.length} · ${current.title}`));
    else parts.push(theme.fg("muted", `${phases.filter((phase) => phase.status === "done").length}/${phases.length} phases done`));
    return [parts.join(theme.fg("dim", " · "))];
  }
  const verbs: Partial<Record<CharterInput["action"], string>> = {
    create: "created",
    pause: "paused",
    resume: "resumed",
    complete: "completed",
    abandon: "abandoned",
  };
  const verb = verbs[args.action];
  if (verb) return [`${theme.fg(lifecycleColor(typeof record?.status === "string" ? record.status : "active"), verb)} ${name}`.trimEnd()];
  return [theme.fg("muted", compactInline(fallback, 160))];
}

/** Expanded result: Objective and phase map for status, otherwise the full message, then legal next actions. */
function charterResultDetails(
  args: CharterInput,
  details: { nextActions?: NextAction[]; data?: unknown },
  message: string,
  isError: boolean,
  theme: RenderTheme,
): string[] {
  const lines: string[] = [];
  const record = details.data && typeof details.data === "object" && !Array.isArray(details.data) ? details.data as Record<string, unknown> : undefined;
  if (args.action === "status" && record && typeof record.objective === "string") {
    lines.push("", theme.bold(theme.fg("warning", "Objective")), theme.fg("text", record.objective.trim()));
    const phases = (record.phases ?? []) as CharterStatusResult["phases"];
    if (phases.length > 0) {
      lines.push("", theme.bold(theme.fg("accent", "Phases")));
      for (const phase of phases) lines.push(theme.fg(phaseColor(phase.status), `${phase.number}. ${phase.title} — ${phase.status}`));
    }
    const ralph = record.ralph as { pausedByGuard?: boolean } | undefined;
    if (ralph?.pausedByGuard) lines.push("", theme.fg("warning", "Paused by the Ralph guard; only /charter resume continues."));
    const warnings = Array.isArray(record.warnings) ? record.warnings as string[] : [];
    if (warnings.length > 0) lines.push("", ...warnings.map((warning) => theme.fg("warning", warning)));
  } else if (!isError && args.action !== "list") {
    lines.push("", theme.fg("muted", message.trim()));
  }
  const next = (details.nextActions ?? [])
    .map((action) => action.tool === "charter" && action.action ? action.action : [action.tool, action.action].filter(Boolean).join("."))
    .join(theme.fg("dim", " · "));
  lines.push("", theme.fg("dim", "next ") + (next ? theme.fg("muted", next) : theme.fg("dim", "none")));
  return lines;
}

export function registerCharterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("charter", {
    description: "pi-charter: create/list/status/pause/resume/complete/abandon",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const input = parseCommand(args);
      try {
        const result = await runCharterAction(ctx.cwd, input, ctx.sessionManager.getSessionId?.(), true);
        if (input.action !== "status" && input.action !== "list") pi.events.emit(LIFECYCLE_EVENT, { action: input.action });
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

export function registerCharterFileHooks(pi: ExtensionAPI): void {
  pi.on("tool_result", async (_event, ctx) => {
    await refreshSessionSnapshots(ctx.cwd, ctx.sessionManager.getSessionId?.());
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

  let stopAsyncStarted: (() => void) | undefined;
  let stopAsyncRunComplete: (() => void) | undefined;
  let stopAsyncComplete: (() => void) | undefined;
  let stopAllIdle: (() => void) | undefined;
  let stopLifecycle: (() => void) | undefined;

  const subscribeToSubagentEvents = () => {
    if (stopAsyncStarted || stopAsyncRunComplete || stopAsyncComplete || stopAllIdle || stopLifecycle) return;
    stopLifecycle = pi.events.on(LIFECYCLE_EVENT, (raw: unknown) => {
      const action = (raw as { action?: string }).action;
      if (action === "pause" || action === "complete" || action === "abandon") {
        if (timer) clearTimeout(timer);
        if (warningTimer) clearTimeout(warningTimer);
        timer = undefined;
        warningTimer = undefined;
        if (lastCtx) clearWidgetWarning(lastCtx);
      } else if (action === "resume" || action === "create") {
        scheduleRalph(`charter-${action}`);
      }
    });
    stopAsyncStarted = pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
      const payload = raw as { runId?: string; id?: string } | undefined;
      const id = payload?.runId ?? payload?.id;
      if (id) runningSubagents.add(id);
      logger.debug("ralph: subagent started", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
    });
    stopAsyncRunComplete = pi.events.on(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, (raw: unknown) => {
      const payload = raw as { runId?: string; id?: string } | undefined;
      const id = payload?.runId ?? payload?.id;
      if (id) runningSubagents.delete(id);
      logger.debug("ralph: subagent run complete", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
    });
    stopAsyncComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
      const payload = raw as { runId?: string; id?: string } | undefined;
      const id = payload?.runId ?? payload?.id;
      if (id) runningSubagents.delete(id);
      logger.debug("ralph: subagent complete", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
      scheduleRalph("subagent-complete");
    });
    stopAllIdle = pi.events.on(SUBAGENT_ALL_IDLE_EVENT, () => {
      scheduleRalph("subagent-all-idle");
    });
  };

  subscribeToSubagentEvents();
  pi.on("session_start", (event, ctx) => {
    disposed = false;
    lastSentAt = 0;
    interruptedUntil = 0;
    sending = false;
    rememberCtx(event, ctx);
    subscribeToSubagentEvents();
  });
  pi.on("agent_start", (event, ctx) => {
    if (timer) clearTimeout(timer);
    if (warningTimer) clearTimeout(warningTimer);
    timer = undefined;
    warningTimer = undefined;
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
  pi.on("session_shutdown", () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (warningTimer) clearTimeout(warningTimer);
    timer = undefined;
    warningTimer = undefined;
    lastCtx = undefined;
    runningSubagents.clear();
    stopAsyncStarted?.();
    stopAsyncRunComplete?.();
    stopAsyncComplete?.();
    stopAllIdle?.();
    stopLifecycle?.();
    stopLifecycle = undefined;
    stopAsyncStarted = undefined;
    stopAsyncRunComplete = undefined;
    stopAsyncComplete = undefined;
    stopAllIdle = undefined;
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
      const status = await getBoundCharterStatus(ctx.cwd, sessionId).catch(() => undefined);
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
      const status = await getBoundCharterStatus(ctx.cwd, ctx.sessionManager.getSessionId?.()).catch((error) => {
        logger.debug("ralph: status lookup skipped", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
      if (!status || status.status !== "active") {
        logger.debug("ralph: skipped without active charter", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, status: status?.status });
        return;
      }
      const result = await attemptRalphActivation({
        projectDir: ctx.cwd,
        charterId: status.charterId,
        sessionId: ctx.sessionManager.getSessionId?.(),
        at,
        isEligible: () => !disposed && lastCtx === ctx && runningSubagents.size === 0
          && ctx.isIdle() && !ctx.hasPendingMessages(),
        send: (kind) => {
          clearWidgetWarning(ctx);
          pi.sendMessage({
            customType: RALPH_CUSTOM_TYPE,
            content: renderRalphPrompt(status, kind === "recovery"),
            display: true,
            details: {
              charterId: status.charterId,
              kind,
              currentPhase: status.phases.find((phase) => phase.status === "current")?.title,
              phaseCount: status.phases.length,
            },
          }, { deliverAs: "steer", triggerTurn: true });
        },
      });
      if (result === "pause") {
        if (timer) clearTimeout(timer);
        if (warningTimer) clearTimeout(warningTimer);
        timer = undefined;
        warningTimer = undefined;
        clearWidgetWarning(ctx);
        ctx.ui.notify(RALPH_GUARD_PAUSE_NOTE, "warning");
        pi.events.emit(LIFECYCLE_EVENT, { action: "pause" });
      } else if (result !== "skipped") {
        lastSentAt = at;
      }
      logger.debug("ralph: activation handled", { component: RALPH_LOG_COMPONENT, trigger: input.trigger, charterId: status.charterId, result });
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
    const pad = options.outputPad;
    const details = (message.details ?? {}) as { charterId?: string; kind?: string; currentPhase?: string };
    const recovery = details.kind === "recovery";
    const sep = theme.fg("dim", " · ");
    let header = theme.fg(recovery ? "error" : "warning", theme.bold("ralph"));
    header += ` ${theme.fg("text", details.charterId ? displayName(details.charterId) : "charter")}`;
    if (details.currentPhase) header += sep + theme.fg("muted", details.currentPhase);
    if (recovery) header += sep + theme.fg("error", "recovery: pause follows another activation within 5 min");
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!options.expanded || !content) return new Text(header, pad, 0);
    const container = new Container();
    container.addChild(new Text(header, pad, 0));
    container.addChild(new Text("", 0, 0));
    try {
      container.addChild(new Markdown(content, pad, 0, getMarkdownTheme()));
    } catch {
      container.addChild(new Text(theme.fg("muted", content), pad, 0));
    }
    return container;
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
  userInitiated = false,
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
      return resumeCharter(projectDir, { charterId: params.id, sessionId, userInitiated });
    case "complete":
      return completeCharter(projectDir, { charterId: params.id, note: params.note, sessionId });
    case "abandon":
      return abandonCharter(projectDir, { charterId: params.id, note: params.note, sessionId });
  }
}

export function formatCharterStatusText(status: CharterStatusResult): string {
  const lines = [
    `${status.charterId} ${status.status} · ${status.legacy ? "legacy, read-only" : `${status.phaseCounts.done}/${status.phases.length} phases done`}`,
    `objective: ${status.objective.replace(/\s+/g, " ").trim()}`,
  ];
  const current = status.phases.find((phase) => phase.status === "current");
  if (current) lines.push(`phase ${current.number}/${status.phases.length}: ${current.title}`);
  if (status.ralph?.pausedByGuard) lines.push("ralph: guard paused; user must run /charter resume");
  if (status.warnings.length > 0) lines.push(`warnings: ${status.warnings.join("; ")}`);
  return lines.join("\n");
}

function toolText(text: string, nextActions: NextAction[], data?: unknown, isError = false) {
  const next = nextActions.map((action) =>
    action.tool === "charter" && action.action ? action.action : [action.tool, action.action].filter(Boolean).join("."),
  ).join(",") || "none";
  return {
    isError,
    content: [{ type: "text" as const, text: `${text}\nnext: ${next}` }],
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
