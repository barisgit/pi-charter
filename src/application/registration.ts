import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { lockPlan, viewPlan } from "./plan-service";
import { applyHandoff, recordEvidence, verifyCriterion, type HandoffCompletedCriterion } from "./record-service";
import { amendCharter, completeCharter, createCharter, forceCompleteCharter, getCharterStatus, pauseCharter, resumeCharter } from "./service";
import { bindCharterToSession, rebindCharter, reconcileSessionBinding, readSessionBinding } from "./binding-service";
import { runEvaluator, reminderFromEntry, type EvaluatorAssessment, type EvaluatorVerdict } from "./evaluator-service";
import {
  PI_CHARTER_EXTENSION_ID,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_EXPOSE_API_EVENT,
  SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
  SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
  SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
  type PersonaDirErrorPayload,
  type RegisterPersonaDirPayload,
  type SubagentAsyncCompletePayload,
  type SubagentAsyncStartedPayload,
  type SubagentExposedAPI,
  type UnregisterPersonaDirPayload,
} from "../infrastructure/subagent-bridge";
import { handleAsyncComplete, handleAsyncStarted } from "./async-bridge-service";

type CharterManageInput = {
  action: "create" | "pause" | "resume" | "complete" | "force_complete" | "amend_charter";
  charterId?: string;
  objective?: string;
  reason?: string;
  completionNote?: string;
  target?: "completed" | "abandoned" | "budget_limited" | "planning" | "review";
  idempotencyKey?: string;
  budget?: { tokens?: number; wallclockMs?: number; turns?: number };
};

type CharterStatusInput = {
  charterId?: string;
  verbose?: boolean;
};

type CharterPlanInput = {
  action: "view" | "add_feature" | "update_feature" | "lock_plan";
  charterId?: string;
};

type CharterRecordInput = {
  action: "evidence" | "verify" | "handoff_apply";
  charterId?: string;
  criterionId?: string;
  featureId?: string;
  outcome?: "pass" | "fail" | "partial";
  summary?: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
  timeoutMs?: number;
  subagentSessionId?: string;
  handoffNote?: string;
  completedCriteria?: HandoffCompletedCriterion[];
};

const CharterManageParams = Type.Object({
  action: StringEnum(["create", "pause", "resume", "complete", "force_complete", "amend_charter"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional when exactly one active charter exists." })),
  objective: Type.Optional(Type.String({ description: "Required for action=create. The desired outcome, not a spec path." })),
  reason: Type.Optional(Type.String({ description: "Pause or force-complete reason." })),
  completionNote: Type.Optional(Type.String({ description: "Completion note for action=complete." })),
  target: Type.Optional(StringEnum(["completed", "abandoned", "budget_limited", "planning", "review"] as const)),
  idempotencyKey: Type.Optional(Type.String({ description: "Stable retry key for orchestrator-driven creates." })),
  budget: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Number()),
    wallclockMs: Type.Optional(Type.Number()),
    turns: Type.Optional(Type.Number()),
  })),
});

const CharterStatusParams = Type.Object({
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional when exactly one active charter exists." })),
  verbose: Type.Optional(Type.Boolean({ default: false })),
});

const CharterPlanParams = Type.Object({
  action: StringEnum(["view", "add_feature", "update_feature", "lock_plan"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional when exactly one active charter exists." })),
});

const CharterRecordParams = Type.Object({
  action: StringEnum(["evidence", "verify", "handoff_apply"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional when exactly one active charter exists." })),
  criterionId: Type.Optional(Type.String({ description: "VAL-* criterion id. Required for evidence and verify." })),
  featureId: Type.Optional(Type.String({ description: "Feature id this evidence/verification belongs to." })),
  outcome: Type.Optional(StringEnum(["pass", "fail", "partial"] as const)),
  summary: Type.Optional(Type.String({ description: "Short manual summary for action=evidence." })),
  artifacts: Type.Optional(Type.Array(Type.String())),
  details: Type.Optional(Type.Object({}, { additionalProperties: true })),
  timeoutMs: Type.Optional(Type.Number({ description: "Per-command timeout in ms for verify (default 120000)." })),
  subagentSessionId: Type.Optional(Type.String({ description: "Subagent session id for action=handoff_apply." })),
  handoffNote: Type.Optional(Type.String({ description: "Free-text handoff note for action=handoff_apply." })),
  completedCriteria: Type.Optional(Type.Array(Type.Object({
    criterionId: Type.String(),
    outcome: StringEnum(["pass", "fail", "partial"] as const),
    summary: Type.String(),
    artifacts: Type.Optional(Type.Array(Type.String())),
    details: Type.Optional(Type.Object({}, { additionalProperties: true })),
  }))),
});

export function registerCharterTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "charter_manage",
    label: "Charter Manage",
    description: "Manage pi-charter lifecycle actions: create, pause, resume, complete, force_complete, amend_charter.",
    promptSnippet: "Manage a durable charter lifecycle with minimal create input and evidence-gated completion.",
    promptGuidelines: [
      "Use charter_manage action=create when the user asks for durable charter-bound work; provide only objective, optional budget, and optional idempotencyKey.",
      "Do not pass spec paths to charter_manage. Read spec files with normal file tools and author charter.md during planning.",
    ],
    parameters: CharterManageParams,
    async execute(_toolCallId, params: CharterManageInput, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "create": {
          if (!params.objective?.trim()) throw new Error("objective is required for charter_manage action=create");
          const sessionId = ctx.sessionManager.getSessionId?.();
          const result = await createCharter(ctx.cwd, {
            objective: params.objective,
            budget: params.budget,
            idempotencyKey: params.idempotencyKey,
            sessionId,
          });
          if (sessionId) {
            await bindCharterToSession(ctx.cwd, { charterId: result.charterId, sessionId });
          }
          return toolResult(result.message, result);
        }
        case "pause": {
          const result = await pauseCharter(ctx.cwd, { charterId: params.charterId, reason: params.reason });
          return toolResult(result.message, result);
        }
        case "resume": {
          const result = await resumeCharter(ctx.cwd, { charterId: params.charterId });
          const sessionId = ctx.sessionManager.getSessionId?.();
          if (sessionId) {
            await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId });
          }
          return toolResult(result.message, result);
        }
        case "complete": {
          const result = await completeCharter(ctx.cwd, { charterId: params.charterId, completionNote: params.completionNote });
          return toolResult(result.message, result);
        }
        case "force_complete": {
          const target = params.target === "completed" || params.target === "abandoned" || params.target === "budget_limited" ? params.target : undefined;
          const result = await forceCompleteCharter(ctx.cwd, {
            charterId: params.charterId,
            reason: params.reason ?? "",
            target,
          });
          return toolResult(result.message, result);
        }
        case "amend_charter": {
          const target = params.target === "planning" || params.target === "review" ? params.target : undefined;
          const result = await amendCharter(ctx.cwd, {
            charterId: params.charterId,
            reason: params.reason ?? "",
            target,
          });
          return toolResult(result.message, result);
        }
      }
    },
  });

  pi.registerTool({
    name: "charter_plan",
    label: "Charter Plan",
    description: "View and manage the charter macro-DAG. M2 scaffold implements view; edit/lock actions are reserved.",
    promptSnippet: "Inspect charter feature coverage and planning drift before locking or executing a charter.",
    promptGuidelines: [
      "Use charter_plan action=view during planning to inspect uncovered criteria and orphan features.",
      "Do not use pi-dag-tasks for durable charter features; use plan/<featureId>.md and charter_plan views.",
    ],
    parameters: CharterPlanParams,
    async execute(_toolCallId, params: CharterPlanInput, _signal, _onUpdate, ctx) {
      const status = await getCharterStatus(ctx.cwd, { charterId: params.charterId });
      if (params.action === "view") {
        const result = await viewPlan(ctx.cwd, { charterId: status.charterId });
        return toolResult(`Plan for charter ${result.charterId}: ${result.features.length} feature(s), ${result.drift.uncovered.length} uncovered criterion/criteria.`, result);
      }
      if (params.action === "lock_plan") {
        const result = await lockPlan(ctx.cwd, { charterId: status.charterId });
        return toolResult(result.message, result);
      }
      throw new Error(`charter_plan action=${params.action} is reserved but not implemented in the M2 scaffold`);
    },
  });

  pi.registerTool({
    name: "charter_record",
    label: "Charter Record",
    description: "Record evidence, run verifiers, or apply subagent handoffs against charter criteria.",
    promptSnippet: "Record evidence, run command verifiers, and link results back to charter criteria.",
    promptGuidelines: [
      "Use charter_record action=evidence after a manual check; charter_record action=verify to execute a command verifier defined in charter.md.",
      "Evidence is required for criteria with requireFreshEvidence before complete is allowed.",
    ],
    parameters: CharterRecordParams,
    async execute(_toolCallId, params: CharterRecordInput, _signal, _onUpdate, ctx) {
      const status = await getCharterStatus(ctx.cwd, { charterId: params.charterId });
      if (params.action === "evidence") {
        if (!params.criterionId?.trim()) throw new Error("criterionId is required for charter_record action=evidence");
        if (!params.outcome) throw new Error("outcome is required for charter_record action=evidence");
        if (!params.summary?.trim()) throw new Error("summary is required for charter_record action=evidence");
        const result = await recordEvidence(ctx.cwd, {
          charterId: status.charterId,
          criterionId: params.criterionId,
          featureId: params.featureId,
          outcome: params.outcome,
          summary: params.summary,
          artifacts: params.artifacts,
          details: params.details,
        });
        return toolResult(`Recorded ${result.outcome} evidence for ${result.criterionId}.`, result);
      }
      if (params.action === "verify") {
        if (!params.criterionId?.trim()) throw new Error("criterionId is required for charter_record action=verify");
        const result = await verifyCriterion(ctx.cwd, {
          charterId: status.charterId,
          criterionId: params.criterionId,
          featureId: params.featureId,
          timeoutMs: params.timeoutMs,
          cwd: ctx.cwd,
        });
        return toolResult(`Verifier for ${result.criterionId} -> ${result.outcome} (exit=${result.exitCode}).`, result);
      }
      if (params.action === "handoff_apply") {
        if (!params.subagentSessionId?.trim()) throw new Error("subagentSessionId is required for charter_record action=handoff_apply");
        if (!params.featureId?.trim()) throw new Error("featureId is required for charter_record action=handoff_apply");
        if (!params.handoffNote?.trim()) throw new Error("handoffNote is required for charter_record action=handoff_apply");
        if (!params.completedCriteria || params.completedCriteria.length === 0) throw new Error("completedCriteria must have at least one entry for charter_record action=handoff_apply");
        const result = await applyHandoff(ctx.cwd, {
          charterId: status.charterId,
          featureId: params.featureId,
          subagentSessionId: params.subagentSessionId,
          handoffNote: params.handoffNote,
          completedCriteria: params.completedCriteria,
        });
        return toolResult(`Applied handoff from ${result.subagentSessionId} for feature ${result.featureId} (${result.appliedCount} criteria).`, result);
      }
      throw new Error(`charter_record action=${params.action} is not implemented yet`);
    },
  });

  pi.registerTool({
    name: "charter_status",
    label: "Charter Status",
    description: "Read the current charter status, drift views, evaluator reason, and legal nextActions.",
    promptSnippet: "Inspect charter state, drift views, evaluator steer, and legal nextActions before choosing the next move.",
    promptGuidelines: [
      "Use charter_status before deciding what to do next in an active charter.",
      "Follow charter_status nextActions instead of guessing lifecycle transitions.",
    ],
    parameters: CharterStatusParams,
    async execute(_toolCallId, params: CharterStatusInput, _signal, _onUpdate, ctx) {
      const result = await getCharterStatus(ctx.cwd, { charterId: params.charterId });
      return toolResult(formatCharterStatusText(result), result);
    },
  });
}

/**
 * Render a charter_status result as a compact text block for the LLM tool
 * channel. The full structured `result` still rides along in `toolResult`'s
 * details arg — this string is what the agent actually reads when reasoning.
 */
function formatCharterStatusText(result: {
  charterId: string;
  status: string;
  phase: string;
  objective: string;
  drift: { uncovered: unknown[]; stuck: unknown[]; stale: unknown[]; readyNext: { featureId: string; fulfills: string[] }[] };
  nextActions: { tool: string; action?: string; hint: string }[];
  guidelines: string[];
}): string {
  const lines: string[] = [];
  const firstObjectiveLine = result.objective.split("\n", 1)[0] ?? "";
  const trimmedObjective = firstObjectiveLine.length > 120
    ? `${firstObjectiveLine.slice(0, 117)}...`
    : firstObjectiveLine;
  lines.push(`Charter ${result.charterId} [${result.status} · phase=${result.phase}]`);
  lines.push(`  objective: ${trimmedObjective}`);
  lines.push(
    `  drift: uncovered=${result.drift.uncovered.length} stuck=${result.drift.stuck.length} stale=${result.drift.stale.length} readyNext=${result.drift.readyNext.length}`,
  );
  if (result.drift.readyNext.length > 0) {
    const preview = result.drift.readyNext
      .slice(0, 3)
      .map((entry) => `${entry.featureId} (→ ${entry.fulfills.join(", ") || "-"})`)
      .join("; ");
    lines.push(`  ready features: ${preview}${result.drift.readyNext.length > 3 ? ", ..." : ""}`);
  }
  lines.push("  nextActions:");
  for (const action of result.nextActions) {
    const head = action.action ? `${action.tool} action=${action.action}` : action.tool;
    lines.push(`    - ${head} — ${action.hint}`);
  }
  if (result.guidelines.length > 0) {
    lines.push("  guidelines:");
    for (const guideline of result.guidelines) {
      lines.push(`    - ${guideline}`);
    }
  }
  return lines.join("\n");
}

export function registerCharterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("charter", {
    description: "Open or manage pi-charter. Bare shows status; text hands an objective to the agent (the agent creates the charter).",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text || text === "status") {
        const status = await getCharterStatus(ctx.cwd).catch((error: unknown) => undefined);
        if (!status) {
          ctx.ui.notify("No active charter found.", "info");
          return;
        }
        ctx.ui.notify(formatCharterStatusText(status), "info");
        return;
      }
      if (text === "pause") {
        const result = await pauseCharter(ctx.cwd, {});
        ctx.ui.notify(result.message, "info");
        return;
      }
      if (text === "resume") {
        const result = await resumeCharter(ctx.cwd, {});
        ctx.ui.notify(result.message, "info");
        return;
      }
      // pi-charter rule: users describe intent, agents own charter creation.
      // The slash command never calls createCharter directly — it hands the
      // objective to the agent, which picks the charterId and shapes the
      // criteria/plan during the planning phase. This prevents long objective
      // text from leaking into ids and keeps charter authorship inside the
      // tool surface where the verifier/critic personas can see it.
      pi.sendUserMessage(
        [
          "The user has handed you a new pi-charter objective:",
          "",
          text,
          "",
          "Create and execute the charter end-to-end:",
          "1. Call charter_manage action=create with this objective. Use a concise generated id; do not embed the objective text in the id.",
          "2. Run charter_status to confirm the planning state and legal nextActions.",
          "3. Author the contract (criteria, verifier kinds, scope/constraints) by editing charter.md, then seed the macro plan via charter_plan action=add_feature for each feature.",
          "4. Call charter_plan action=lock_plan when planning is complete to transition to active.",
          "5. Execute the work feature by feature. Record evidence via charter_record action=evidence (manual) or action=verify (command verifier).",
          "6. Call charter_manage action=complete only after every criterion has pass evidence (charter_status will surface remaining gaps).",
          "",
          "Follow charter_status nextActions instead of guessing transitions.",
        ].join("\n"),
      );
    },
  });
}

export function registerCharterFlags(pi: ExtensionAPI): void {
  pi.registerFlag("charter-objective", {
    description: "Create and bind a pi-charter before the first turn with this objective.",
    type: "string",
    default: "",
  });
  pi.registerFlag("charter-resume", {
    description: "Resume and bind an existing pi-charter id before the first turn.",
    type: "string",
    default: "",
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();

    // Reconcile reverse pointer first — if this session previously bound a
    // charter (e.g. after compaction or process restart), restore the forward
    // pointer in state.json before any other action.
    if (sessionId) {
      const reconciled = await reconcileSessionBinding({ sessionId });
      if (reconciled) {
        ctx.ui.notify(`pi-charter: resumed binding to ${reconciled.charterId}.`, "info");
      }
    }

    const resumeId = String(pi.getFlag("charter-resume") ?? "").trim();
    if (resumeId) {
      const result = await resumeCharter(ctx.cwd, { charterId: resumeId });
      if (sessionId) {
        await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId });
      }
      ctx.ui.notify(result.message, "info");
      return;
    }

    const objective = String(pi.getFlag("charter-objective") ?? "").trim();
    if (!objective) return;
    // Same authorship rule as the /charter slash command: hand the objective
    // to the agent rather than creating the charter directly. The agent will
    // call charter_manage action=create with a concise id during turn 1.
    pi.sendUserMessage(
      [
        "The user launched pi with --charter-objective. Start a new charter end-to-end:",
        "",
        objective,
        "",
        "1. Call charter_manage action=create with this objective. Pick a concise id; do not embed objective text.",
        "2. Run charter_status, author charter.md criteria, seed features via charter_plan add_feature.",
        "3. Lock the plan with charter_plan lock_plan, then execute feature by feature, recording evidence as you go.",
        "4. Follow charter_status nextActions; never guess transitions.",
      ].join("\n"),
    );
  });
}

const EVALUATOR_CUSTOM_TYPE = "charter-evaluator-steer";
// Default evaluator model: cheap-fast tier, same shape Claude Code's /goal uses.
// Override per-environment via PI_CHARTER_EVAL_PROVIDER / PI_CHARTER_EVAL_MODEL.
const DEFAULT_EVAL_PROVIDER = "anthropic";
const DEFAULT_EVAL_MODEL = "claude-sonnet-4.6";
const EVAL_TIMEOUT_MS = 30_000;
const EVAL_MAX_TOKENS = 600;

export function registerCharterEvaluator(pi: ExtensionAPI): void {
  pi.on("turn_end", async (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId?.();
      if (!sessionId) return;
      const binding = await readSessionBinding({ sessionId });
      if (!binding) return;
      const projectDir = binding.projectDir;
      const charterId = binding.charterId;

      const recentUserMessages = extractRecentUserMessages(ctx, 2);
      const recentToolNames = extractRecentToolNames(ctx, 8);

      const modelFn = buildEvaluatorModelFn(ctx);
      if (!modelFn) return; // no model available; skip silently

      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn,
        recentUserMessages,
        recentToolNames,
      });
      const reminder = reminderFromEntry(entry);
      if (!reminder) return;
      pi.sendMessage(
        {
          customType: EVALUATOR_CUSTOM_TYPE,
          content: reminder,
          display: true,
          details: entry,
        },
        { deliverAs: "steer", triggerTurn: false },
      );
    } catch (error) {
      // Never block the agent loop on evaluator failures.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`charter-evaluator skipped: ${message}`, "warning");
    }
  });
}

function extractRecentUserMessages(ctx: { sessionManager: { getBranch?: () => unknown[] } }, limit: number): string[] {
  const entries = (ctx.sessionManager.getBranch?.() ?? []) as Array<{ type?: string; content?: unknown }>;
  const userTexts: string[] = [];
  for (const entry of entries) {
    if (entry?.type !== "user_message") continue;
    const text = extractEntryText(entry.content);
    if (text) userTexts.push(text);
  }
  return userTexts.slice(-limit);
}

function extractRecentToolNames(ctx: { sessionManager: { getBranch?: () => unknown[] } }, limit: number): string[] {
  const entries = (ctx.sessionManager.getBranch?.() ?? []) as Array<{ type?: string; name?: string; toolName?: string }>;
  const names: string[] = [];
  for (const entry of entries) {
    if (entry?.type !== "tool_call") continue;
    const name = entry.name ?? entry.toolName;
    if (typeof name === "string" && name) names.push(name);
  }
  return names.slice(-limit);
}

function extractEntryText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

type ModelRegistryLike = {
  find: (provider: string, modelId: string) => unknown;
  getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false; error: string }>;
};

function buildEvaluatorModelFn(ctx: { modelRegistry?: unknown }) {
  const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
  if (!registry) return undefined;
  const provider = process.env.PI_CHARTER_EVAL_PROVIDER ?? DEFAULT_EVAL_PROVIDER;
  const modelId = process.env.PI_CHARTER_EVAL_MODEL ?? DEFAULT_EVAL_MODEL;
  const model = registry.find(provider, modelId);
  if (!model) return undefined;
  type CompleteArgs = Parameters<typeof complete>;
  type CompleteContext = CompleteArgs[1];
  type CompleteOptions = CompleteArgs[2];
  return async (input: { prompt: string }): Promise<EvaluatorAssessment> => {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const context: CompleteContext = {
      systemPrompt: "You are charter-evaluator. Reply with ONLY a single JSON object matching the requested schema. No prose.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          timestamp: Date.now(),
        },
      ],
    } as CompleteContext;
    const options = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      timeoutMs: EVAL_TIMEOUT_MS,
      maxTokens: EVAL_MAX_TOKENS,
      temperature: 0,
      reasoning: "minimal",
    } as unknown as CompleteOptions;
    const response = await complete(model as CompleteArgs[0], context, options);
    if (response.stopReason === "error") {
      const errMessage = (response as unknown as { errorMessage?: string }).errorMessage ?? "unknown";
      throw new Error(`evaluator model error: ${errMessage}`);
    }
    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    return parseEvaluatorJson(text);
  };
}

function parseEvaluatorJson(text: string): EvaluatorAssessment {
  const stripped = stripJsonFences(text).trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("evaluator response did not contain a JSON object");
  const json = stripped.slice(start, end + 1);
  const obj = JSON.parse(json) as Record<string, unknown>;
  const verdict = String(obj.verdict ?? "") as EvaluatorVerdict;
  const allowed: EvaluatorVerdict[] = ["on_track", "drifting", "blocked", "ready_to_complete", "unclear"];
  if (!allowed.includes(verdict)) throw new Error(`evaluator returned unknown verdict: ${obj.verdict}`);
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0.5;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const steerReminder = typeof obj.steerReminder === "string" ? obj.steerReminder : undefined;
  const citesRaw = Array.isArray(obj.cites) ? obj.cites : [];
  const cites = citesRaw
    .map((c) => (typeof c === "object" && c ? (c as Record<string, unknown>) : null))
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => ({
      criterionId: typeof c.criterionId === "string" ? c.criterionId : undefined,
      featureId: typeof c.featureId === "string" ? c.featureId : undefined,
    }))
    .filter((c) => c.criterionId || c.featureId);
  return { verdict, confidence, reason, steerReminder, cites };
}

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

// ---------------------------------------------------------------------------
// pi-subagents bridge: surface 2 — capture exposed API bag
// ---------------------------------------------------------------------------

/**
 * Captured pi-subagents `SubagentExposedAPI` (cached after the
 * `subagent:expose-api` event fires). `undefined` until pi-subagents emits;
 * stays `undefined` if pi-subagents is not loaded.
 *
 * Extension code that wants to programmatically spawn an internal persona can
 * read this through `getSubagentApi()`; callers must handle the `undefined`
 * case gracefully (typically by falling back to an inline path).
 */
let subagentApi: SubagentExposedAPI | undefined;

export function getSubagentApi(): SubagentExposedAPI | undefined {
  return subagentApi;
}

/** Test-only: reset the cached API handle. */
export function __resetSubagentApiForTests(): void {
  subagentApi = undefined;
}

export function registerCharterSubagentBridge(pi: ExtensionAPI): void {
  // Reset on each registration so repeated extension loads in tests/dev
  // don't keep a stale handle from a prior pi-subagents lifecycle.
  subagentApi = undefined;
  pi.events.on(SUBAGENT_EXPOSE_API_EVENT, (raw: unknown) => {
    const api = raw as SubagentExposedAPI | undefined;
    if (!api || typeof api.spawnRaw !== "function") return;
    subagentApi = api;
  });
}

// ---------------------------------------------------------------------------
// pi-subagents bridge: surface 3 — async-event → MissionEvent attribution
// ---------------------------------------------------------------------------

export function registerCharterAsyncBridge(pi: ExtensionAPI): void {
  pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncStartedPayload | undefined;
    if (!payload) return;
    void handleAsyncStarted({ payload }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`[pi-charter] async-bridge feature_started skipped: ${message}`);
    });
  });
  pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncCompletePayload | undefined;
    if (!payload) return;
    void handleAsyncComplete({ payload }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`[pi-charter] async-bridge feature_completed skipped: ${message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// pi-subagents bridge: surface 1 — register bundled personas directory
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the `pi-charter/agents/` directory.
 *
 * Both Bun (dev/test) and bundled production builds put this file under
 * `<extension-root>/src/application/registration.{ts,js}`, so the personas
 * directory is always two `..` away.
 */
function resolveAgentsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..", "..", "agents");
}

export function registerCharterPersonas(pi: ExtensionAPI): void {
  const agentsDir = resolveAgentsDir();

  const registerPayload: RegisterPersonaDirPayload = {
    extensionId: PI_CHARTER_EXTENSION_ID,
    path: agentsDir,
    scope: "internal",
  };
  const unregisterPayload: UnregisterPersonaDirPayload = {
    extensionId: PI_CHARTER_EXTENSION_ID,
  };

  // Surface collisions to the UI; pi-subagents emits this on persona-name
  // conflict and never throws (originating extension is responsible for
  // failing its own startup).
  pi.events.on(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT, (raw: unknown) => {
    const payload = raw as PersonaDirErrorPayload | undefined;
    if (!payload || payload.extensionId !== PI_CHARTER_EXTENSION_ID) return;
    // No ctx here; events.on has no UI handle. Best-effort: console.warn so
    // the conflict is at least visible in the dev tail.
    // eslint-disable-next-line no-console
    console.warn(`[pi-charter] persona dir registration failed: ${payload.message}`);
  });

  // Emit at startup …
  pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, registerPayload);

  // … and re-emit on session_start (matches pi-prune-swe-pruner-provider
  // re-announce pattern; survives pi-subagents restarts).
  pi.on("session_start", () => {
    pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, registerPayload);
  });

  pi.on("session_shutdown", () => {
    pi.events.emit(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, unregisterPayload);
  });
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
