import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { lockPlan, viewPlan } from "./plan-service";
import { recordEvidence, verifyCriterion } from "./record-service";
import { createCharter, getCharterStatus, pauseCharter, resumeCharter } from "./service";

type CharterManageInput = {
  action: "create" | "pause" | "resume" | "complete" | "force_complete" | "amend_charter";
  charterId?: string;
  objective?: string;
  reason?: string;
  completionNote?: string;
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
};

const CharterManageParams = Type.Object({
  action: StringEnum(["create", "pause", "resume", "complete", "force_complete", "amend_charter"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional when exactly one active charter exists." })),
  objective: Type.Optional(Type.String({ description: "Required for action=create. The desired outcome, not a spec path." })),
  reason: Type.Optional(Type.String({ description: "Pause or force-complete reason." })),
  completionNote: Type.Optional(Type.String({ description: "Completion note for action=complete." })),
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
          const result = await createCharter(ctx.cwd, {
            objective: params.objective,
            budget: params.budget,
            idempotencyKey: params.idempotencyKey,
            sessionId: ctx.sessionManager.getSessionId?.(),
          });
          return toolResult(result.message, result);
        }
        case "pause": {
          const result = await pauseCharter(ctx.cwd, { charterId: params.charterId, reason: params.reason });
          return toolResult(result.message, result);
        }
        case "resume": {
          const result = await resumeCharter(ctx.cwd, { charterId: params.charterId });
          return toolResult(result.message, result);
        }
        case "complete":
        case "force_complete":
        case "amend_charter":
          throw new Error(`charter_manage action=${params.action} is reserved but not implemented in the M1 scaffold`);
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
    description: "Record evidence or run verifiers against charter criteria. handoff_apply is reserved.",
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
      throw new Error(`charter_record action=${params.action} is reserved but not implemented yet`);
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
      return toolResult(`Charter ${result.charterId} [${result.status}]: ${result.objective}`, result);
    },
  });
}

export function registerCharterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("charter", {
    description: "Open or manage pi-charter. Bare shows status; text creates a charter objective.",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text || text === "status") {
        const status = await getCharterStatus(ctx.cwd).catch((error: unknown) => undefined);
        if (!status) {
          ctx.ui.notify("No active charter found.", "info");
          return;
        }
        ctx.ui.notify(`Charter ${status.charterId} [${status.status}]: ${status.objective}`, "info");
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
      const result = await createCharter(ctx.cwd, {
        objective: text,
        sessionId: ctx.sessionManager.getSessionId?.(),
      });
      ctx.ui.notify(result.message, "info");
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
    const objective = String(pi.getFlag("charter-objective") ?? "").trim();
    if (!objective) return;
    const result = await createCharter(ctx.cwd, {
      objective,
      sessionId: ctx.sessionManager.getSessionId?.(),
      idempotencyKey: `flag:${objective}`,
    });
    ctx.ui.notify(result.message, "info");
  });
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
