import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
const RALPH_DEBOUNCE_MS = 10_000;
const RALPH_INTERRUPT_DELAY_MS = 60_000;
const RALPH_MIN_INTERVAL_MS = 10_000;
const RALPH_LOG_COMPONENT = "ralph-loop";

export interface RegisterCharterRalphLoopOptions {
  debounceMs?: number;
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
  const interruptDelayMs = options.interruptDelayMs ?? RALPH_INTERRUPT_DELAY_MS;
  const minIntervalMs = options.minIntervalMs ?? RALPH_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastCtx: ExtensionContext | undefined;
  let lastSentAt = 0;
  let interruptedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;

  const rememberCtx = (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
  };

  pi.on("session_start", rememberCtx);
  pi.on("turn_end", (event, ctx) => {
    rememberCtx(event, ctx);
    scheduleRalph("turn_end");
  });
  pi.on("agent_end", (event, ctx) => {
    rememberCtx(event, ctx);
    const messages = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
    const interrupted = messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
    if (interrupted) interruptedUntil = now() + interruptDelayMs;
    scheduleRalph(interrupted ? "agent-end-interrupted" : "agent_end");
  });
  pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as { runId?: string; id?: string } | undefined;
    const id = payload?.runId ?? payload?.id;
    if (id) runningSubagents.add(id);
    logger.debug("ralph: subagent started", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
  });
  pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as { runId?: string; id?: string } | undefined;
    const id = payload?.runId ?? payload?.id;
    if (id) runningSubagents.delete(id);
    logger.debug("ralph: subagent complete", { component: RALPH_LOG_COMPONENT, runId: id, runningSubagents: runningSubagents.size });
    scheduleRalph("subagent-complete");
  });
  pi.events.on(SUBAGENT_ALL_IDLE_EVENT, () => {
    scheduleRalph("subagent-all-idle");
  });

  function scheduleRalph(trigger: string): void {
    if (timer) clearTimeout(timer);
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
    logger.debug("ralph: debounce scheduled", { component: RALPH_LOG_COMPONENT, trigger, delayMs, interrupted: interruptedUntil > now() });
  }

  async function maybeSendRalph(input: { trigger?: string; fromDebounce?: boolean } = {}): Promise<void> {
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
      const content = [
        `charter ${status.charterId} ${status.status}`,
        `evidence pass=${status.evidenceCounts.pass} fail=${status.evidenceCounts.fail} none=${status.evidenceCounts.none}`,
        `top-blocker=${topBlocker}`,
        `stale=${stale.length ? stale.join(",") : "none"}`,
        `ready-next=${status.readyNext.length ? status.readyNext.join(",") : "none"}`,
      ].join("; ");
      pi.sendMessage({
        customType: RALPH_CUSTOM_TYPE,
        content,
        display: true,
        details: { charterId: status.charterId },
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

export function registerCharterRalphMessageRenderer(_pi: ExtensionAPI): void {
  // The default renderer is enough for the condensed one-line Ralph steer.
}

export function registerCharterFlags(_pi: ExtensionAPI): void {
  // Flags were tied to the old multi-file model; hard-cut runtime has no flags.
}

export function registerCharterWidget(pi: ExtensionAPI): void {
  let client: UtilsClient | undefined;

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
    const vm = buildCharterWidgetView(status);
    if (!vm) {
      clear(ctx);
      return;
    }
    const factory: Parameters<UtilsClient["widgets"]["set"]>[2] = (_tui, theme) => ({
      render: (width: number) => renderCharterWidget({ width, theme, vm }),
      invalidate: () => {},
    });
    getClient(ctx).widgets.set("aboveEditor", WIDGET_KEY, factory, { order: 80 });
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("tool_result", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("session_shutdown", () => {
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
    `evidence: pass=${status.evidenceCounts.pass} fail=${status.evidenceCounts.fail} none=${status.evidenceCounts.none}`,
  ];
  if (status.openEnded) lines.push("open-ended: no criteria; complete is not legal");
  if (status.criteria.length > 0) {
    lines.push("criteria:");
    for (const criterion of status.criteria) {
      const stale = criterion.stale ? " stale" : "";
      const deps = criterion.depends.length ? ` depends=${criterion.depends.join(",")}` : "";
      lines.push(`- ${criterion.id} ${criterion.evidence}${stale}${deps}: ${criterion.title}`);
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
