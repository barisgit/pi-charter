import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { addFeature, addFeatureBatch, lockPlan, updateFeature, viewPlan, type FeatureEntry } from "./plan-service";
import { applyHandoff, recordEvidence, recordEvidenceBatch, verifyCriterion, type EvidenceEntry, type HandoffCompletedCriterion } from "./record-service";
import { amendCharter, askCharter, completeCharter, createCharter, forceCompleteCharter, getCharterStatus, pauseCharter, resumeCharter } from "./service";
import { CharterToolError } from "./errors";
import { bindCharterToSession, clearSessionBinding, rebindCharter, reconcileSessionBinding, readSessionBinding, resolveCharterId, writeChildBinding, type SessionBindingRecord } from "./binding-service";
import { runEvaluator, reminderFromEntry, readEvaluatorLog, type EvaluatorAssessment, type EvaluatorModelFn, type EvaluatorVerdict } from "./evaluator-service";
import { buildRalphPromptForCharter } from "./ralph-service";
import { removeCharterReminder, upsertCharterReminder } from "./reminders-bridge";
import { charterDir, loadCharterState } from "../infrastructure/store";
import { logger } from "../infrastructure/logger";
import { TERMINAL_STATUSES } from "../domain/types";
import {
  PI_CHARTER_EXTENSION_ID,
  PI_CHARTER_METADATA_KEYS,
  SUBAGENT_ALL_IDLE_EVENT,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_EXPOSE_API_EVENT,
  SUBAGENT_LINEAGE_EVENT,
  SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
  SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
  SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
  type PersonaDirErrorPayload,
  type RegisterPersonaDirPayload,
  type SubagentAsyncCompletePayload,
  type SubagentAsyncStartedPayload,
  type SubagentExposedAPI,
  type SubagentLineagePayload,
  type UnregisterPersonaDirPayload,
} from "../infrastructure/subagent-bridge";
import { handleAsyncComplete, handleAsyncStarted } from "./async-bridge-service";
import { renderCharterWidget } from "../ui/widget";
import { loadCharterSnapshot, RunningSubagentRegistry } from "../ui/widget-service";
import { CharterPickerComponent } from "../ui/charter-picker";
import { buildPickerSnapshot, listAllCharters } from "../ui/picker-snapshot";
import { listActiveCharters, type CharterListEntry } from "./service";
import {
  clearSelectionRefresher,
  type SelectionRefreshCtx,
  getCharterSelection,
  registerSelectionRefresher,
  requestSelectionRefresh,
  resetCharterSelection,
  setCharterSelection,
} from "../ui/charter-selection";

type CharterManageInput = {
  action: "create" | "pause" | "resume" | "complete" | "force_complete" | "amend_charter" | "ask";
  charterId?: string;
  name?: string;
  objective?: string;
  note?: string;
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
  id?: string;
  milestone?: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  body?: string;
  features?: FeatureEntry[];
};

type CharterRecordInput = {
  action: "evidence" | "verify" | "handoff_apply";
  charterId?: string;
  criterionId?: string;
  featureId?: string;
  outcome?: "pass" | "fail" | "partial";
  summary?: string;
  because?: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
  entries?: EvidenceEntry[];
  timeoutMs?: number;
  subagentSessionId?: string;
  handoffNote?: string;
  completedCriteria?: HandoffCompletedCriterion[];
};

const CharterManageParams = Type.Object({
  action: StringEnum(["create", "pause", "resume", "complete", "force_complete", "amend_charter", "ask"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional for every action except create; when omitted, resolves to the charter bound to the current session." })),
  name: Type.Optional(Type.String({ description: "Optional short slug shown in widget headers and status (e.g. 'headless-click-pid'). Lowercased; non-slug chars stripped; clamped to 32 chars. Falls back to the first 8 chars of the charterId when omitted." })),
  objective: Type.Optional(Type.String({ description: "Required for action=create. The desired outcome, not a spec path." })),
  note: Type.Optional(Type.String({ description: "One-line clarification note stored in state.json for action=ask." })),
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
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional; when omitted, resolves to the charter bound to the current session." })),
  verbose: Type.Optional(Type.Boolean({ default: false })),
});

const CharterPlanParams = Type.Object({
  action: StringEnum(["view", "add_feature", "update_feature", "lock_plan"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional; when omitted, resolves to the charter bound to the current session." })),
  id: Type.Optional(Type.String({ description: "Feature id slug, e.g. m1-bootstrap. Required for add_feature/update_feature." })),
  milestone: Type.Optional(Type.String({ description: "Milestone id this feature belongs to, e.g. m1-bootstrap. Required for add_feature." })),
  order: Type.Optional(Type.Number({ description: "Sort order within the milestone (lower runs first). Required for add_feature." })),
  fulfills: Type.Optional(Type.Array(Type.String(), { description: "VAL-* criterion ids this feature claims to fulfill. Must be non-empty for add_feature." })),
  preconditions: Type.Optional(Type.Array(Type.String(), { description: "Other feature ids that should land before this one. Advisory only." })),
  body: Type.Optional(Type.String({ description: "Feature markdown body (prose under the YAML frontmatter). Required for add_feature." })),
  features: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    milestone: Type.String(),
    order: Type.Number(),
    fulfills: Type.Array(Type.String()),
    preconditions: Type.Optional(Type.Array(Type.String())),
    body: Type.String(),
  }), { description: "Batch shape for action=add_feature. Atomic: all entries land or none. Response preserves request order. Mutually exclusive with the single-entry scalar fields." })),
});

const CharterRecordParams = Type.Object({
  action: StringEnum(["evidence", "verify", "handoff_apply"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional; when omitted, resolves to the charter bound to the current session." })),
  criterionId: Type.Optional(Type.String({ description: "VAL-* criterion id. Required for evidence and verify." })),
  featureId: Type.Optional(Type.String({ description: "Feature id this evidence/verification belongs to." })),
  outcome: Type.Optional(StringEnum(["pass", "fail", "partial"] as const)),
  summary: Type.Optional(Type.String({ description: "Short manual summary for action=evidence." })),
  because: Type.Optional(Type.String({ description: "Rationale for the evidence record. Required when action=evidence and source is manual; explains why this outcome is correct so the completion gate can distinguish drive-by approvals from real review." })),
  artifacts: Type.Optional(Type.Array(Type.String())),
  details: Type.Optional(Type.Object({}, { additionalProperties: true })),
  entries: Type.Optional(Type.Array(Type.Object({
    criterionId: Type.String(),
    featureId: Type.Optional(Type.String()),
    outcome: StringEnum(["pass", "fail", "partial"] as const),
    summary: Type.String(),
    because: Type.Optional(Type.String()),
    artifacts: Type.Optional(Type.Array(Type.String())),
    details: Type.Optional(Type.Object({}, { additionalProperties: true })),
    source: Type.Optional(StringEnum(["manual", "verifier", "subagent"] as const)),
  }), { description: "Batch evidence entries. When provided, single-entry fields (criterionId/outcome/summary/...) must be omitted; the batch is atomic within the call (one criterion-state.json write covering all entries)." })),
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

interface RegisterCharterToolsOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
}

export function registerCharterTools(pi: ExtensionAPI, options: RegisterCharterToolsOptions = {}): void {
  pi.registerTool({
    name: "charter_manage",
    label: "Charter Manage",
    description: "Manage pi-charter lifecycle actions: create, pause, resume, ask, complete, force_complete, amend_charter.",
    promptSnippet: "Manage a durable charter lifecycle with minimal create input and evidence-gated completion.",
    promptGuidelines: [
      "Use charter_manage action=create when the user asks for durable charter-bound work; provide only objective, optional budget, and optional idempotencyKey.",
      "Do not pass spec paths to charter_manage. Read spec files with normal file tools and author charter.md during planning.",
    ],
    parameters: CharterManageParams,
    async execute(_toolCallId, params: CharterManageInput, _signal, _onUpdate, ctx) {
      // `create` is the only charter_manage action that does not require a
      // pre-existing charter (it MINTS one). Every other action resolves
      // charterId from the explicit argument or the session reverse binding,
      // throwing NoCharterBoundError when neither is available.
      switch (params.action) {
        case "create": {
          if (!params.objective?.trim()) throw new Error("objective is required for charter_manage action=create");
          const sessionId = ctx.sessionManager.getSessionId?.();
          const result = await createCharter(ctx.cwd, {
            objective: params.objective,
            name: params.name,
            budget: params.budget,
            idempotencyKey: params.idempotencyKey,
            sessionId,
          });
          if (sessionId) {
            await bindCharterToSession(ctx.cwd, { charterId: result.charterId, sessionId, homeDir: options.homeDir });
          }
          await tryUpsertCharterReminder(pi, ctx.cwd, result.charterId);
          return toolResult(result.message, result);
        }
        case "pause": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await pauseCharter(ctx.cwd, { charterId: resolved.charterId, reason: params.reason });
          await trySyncCharterReminder(pi, ctx.cwd, result.charterId);
          return toolResult(result.message, result);
        }
        case "ask": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await askCharter(ctx.cwd, { charterId: resolved.charterId, note: params.note });
          await trySyncCharterReminder(pi, ctx.cwd, result.charterId);
          return toolResult(result.message, result);
        }
        case "resume": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await resumeCharter(ctx.cwd, { charterId: resolved.charterId });
          const sessionId = ctx.sessionManager.getSessionId?.();
          if (sessionId) {
            await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId, homeDir: options.homeDir });
          }
          await trySyncCharterReminder(pi, ctx.cwd, result.charterId);
          return toolResult(result.message, result);
        }
        case "complete": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await completeCharter(ctx.cwd, { charterId: resolved.charterId, completionNote: params.completionNote });
          tryRemoveCharterReminder(pi, result.charterId);
          return toolResult(result.message, result);
        }
        case "force_complete": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const target = params.target === "completed" || params.target === "abandoned" || params.target === "budget_limited" ? params.target : undefined;
          const result = await forceCompleteCharter(ctx.cwd, {
            charterId: resolved.charterId,
            reason: params.reason ?? "",
            target,
          });
          tryRemoveCharterReminder(pi, result.charterId);
          return toolResult(result.message, result);
        }
        case "amend_charter": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const target = params.target === "planning" || params.target === "review" ? params.target : undefined;
          const result = await amendCharter(ctx.cwd, {
            charterId: resolved.charterId,
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
    description: "View and edit the charter macro-DAG (features under .pi/charters/<id>/plan/). Read the pi-charter skill for end-to-end workflow.",
    promptSnippet: "Inspect charter feature coverage and planning drift before locking or executing a charter.",
    promptGuidelines: [
      "Use charter_plan action=view to inspect coverage; action=add_feature/update_feature to write managed plan/<featureId>.md files; action=lock_plan to transition to active.",
      "Never write plan/<featureId>.md or charter.md at the repo root — charter files live under .pi/charters/<id>/ and the tools manage them.",
    ],
    parameters: CharterPlanParams,
    async execute(_toolCallId, params: CharterPlanInput, _signal, _onUpdate, ctx) {
      const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
      const status = await getCharterStatus(ctx.cwd, { charterId: resolved.charterId });
      if (params.action === "view") {
        const result = await viewPlan(ctx.cwd, { charterId: status.charterId });
        return toolResult(`Plan for charter ${result.charterId}: ${result.features.length} feature(s), ${result.drift.uncovered.length} uncovered criterion/criteria.`, result);
      }
      if (params.action === "lock_plan") {
        const result = await lockPlan(ctx.cwd, { charterId: status.charterId });
        await tryUpsertCharterReminder(pi, ctx.cwd, result.charterId);
        return toolResult(result.message, result);
      }
      if (params.action === "add_feature") {
        const singleProvided = params.id !== undefined
          || params.milestone !== undefined
          || params.order !== undefined
          || params.fulfills !== undefined
          || params.body !== undefined
          || params.preconditions !== undefined;
        if (params.features !== undefined && singleProvided) {
          throw new Error("provide either single-entry fields or a batch `features` array, not both");
        }
        if (params.features !== undefined) {
          if (params.features.length === 0) throw new Error("features array must be non-empty for charter_plan action=add_feature");
          const result = await addFeatureBatch(ctx.cwd, {
            charterId: status.charterId,
            features: params.features,
          });
          return toolResult(result.message, result);
        }
        if (!params.id?.trim()) throw new Error("id is required for charter_plan action=add_feature");
        if (!params.milestone?.trim()) throw new Error("milestone is required for charter_plan action=add_feature");
        if (params.order === undefined) throw new Error("order is required for charter_plan action=add_feature");
        if (!params.fulfills || params.fulfills.length === 0) throw new Error("fulfills must list at least one VAL-* criterion id for charter_plan action=add_feature");
        if (!params.body?.trim()) throw new Error("body is required for charter_plan action=add_feature");
        // VAL-8: legacy single-entry shape stays supported but emits a deprecation
        // notice so callers can migrate to the batch shape. Literal "deprecated"
        // string is part of the contract — do not reword without updating VAL-8.
        logger.warn("charter_plan action=add_feature: single-entry shape is deprecated; pass a `features: [...]` array instead.");
        const result = await addFeature(ctx.cwd, {
          charterId: status.charterId,
          id: params.id,
          milestone: params.milestone,
          order: params.order,
          fulfills: params.fulfills,
          preconditions: params.preconditions,
          body: params.body,
        });
        return toolResult(result.message, result);
      }
      if (params.action === "update_feature") {
        if (!params.id?.trim()) throw new Error("id is required for charter_plan action=update_feature");
        const result = await updateFeature(ctx.cwd, {
          charterId: status.charterId,
          id: params.id,
          milestone: params.milestone,
          order: params.order,
          fulfills: params.fulfills,
          preconditions: params.preconditions,
          body: params.body,
        });
        return toolResult(result.message, result);
      }
      throw new Error(`charter_plan action=${params.action} is not implemented`);
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
      const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
      const status = await getCharterStatus(ctx.cwd, { charterId: resolved.charterId });
      if (params.action === "evidence") {
        const hasBatch = Array.isArray(params.entries) && params.entries.length > 0;
        const hasSingle = Boolean(
          (params.criterionId && params.criterionId.trim())
          || params.outcome
          || (params.summary && params.summary.trim()),
        );
        if (hasBatch && hasSingle) {
          throw new Error("charter_record action=evidence: provide either single-entry fields or a batch `entries` array, not both");
        }
        if (hasBatch) {
          const batch = await recordEvidenceBatch(ctx.cwd, {
            charterId: status.charterId,
            entries: params.entries!,
          });
          await trySyncCharterReminder(pi, ctx.cwd, status.charterId);
          return toolResult(`Recorded ${batch.entries.length} evidence entries for charter ${batch.charterId}.`, batch);
        }
        if (!params.criterionId?.trim()) throw new Error("criterionId is required for charter_record action=evidence");
        if (!params.outcome) throw new Error("outcome is required for charter_record action=evidence");
        if (!params.summary?.trim()) throw new Error("summary is required for charter_record action=evidence");
        // VAL-8: see add_feature deprecation note above. Literal "deprecated"
        // string is part of the contract.
        logger.warn("charter_record action=evidence: single-entry shape is deprecated; pass an `entries: [...]` array instead.");
        const result = await recordEvidence(ctx.cwd, {
          charterId: status.charterId,
          criterionId: params.criterionId,
          featureId: params.featureId,
          outcome: params.outcome,
          summary: params.summary,
          because: params.because,
          artifacts: params.artifacts,
          details: params.details,
        });
        await trySyncCharterReminder(pi, ctx.cwd, status.charterId);
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
        await trySyncCharterReminder(pi, ctx.cwd, status.charterId);
        return toolResult(`Verifier for ${result.criterionId} -> ${result.outcome} (exit=${result.exitCode}).`, result);
      }
      if (params.action === "handoff_apply") {
        // VAL-HANDOFF-SCHEMA: the four de-facto-required handoff_apply fields
        // are validated here as the single source of truth (the duplicate guard
        // inside record-service.applyHandoff has been removed). Each rejection
        // is a CharterToolError carrying a structured `code` plus nextActions[]
        // that name the canonical subagent-spawn metadata key so the agent can
        // self-correct without parsing the message.
        if (!params.featureId?.trim()) {
          throw new CharterToolError(
            "charter_record action=handoff_apply requires 'featureId' (the feature this handoff completes; same value passed in metadata.pi-charter.featureId on the subagent spawn).",
            {
              code: "handoff_apply.missing_featureId",
              nextActions: [
                {
                  tool: "charter_record",
                  action: "handoff_apply",
                  hint: "Pass `featureId: '<id>'` (same value as metadata['pi-charter.featureId'] on the subagent spawn).",
                },
                { tool: "charter_status", hint: "Use charter_status to list active features and pick the right featureId." },
              ],
            },
          );
        }
        if (!params.subagentSessionId?.trim()) {
          throw new CharterToolError(
            "charter_record action=handoff_apply requires 'subagentSessionId' (the worker/reviewer session id that produced this handoff; same value passed in metadata.pi-charter.subagentSessionId on the subagent spawn).",
            {
              code: "handoff_apply.missing_subagentSessionId",
              nextActions: [
                {
                  tool: "charter_record",
                  action: "handoff_apply",
                  hint: "Pass `subagentSessionId: '<sessionId>'` (same value as metadata['pi-charter.subagentSessionId'] on the subagent spawn).",
                },
              ],
            },
          );
        }
        if (!params.handoffNote?.trim()) {
          throw new CharterToolError(
            "charter_record action=handoff_apply requires 'handoffNote' (a short free-text summary from the subagent describing what was completed and any caveats).",
            {
              code: "handoff_apply.missing_handoffNote",
              nextActions: [
                {
                  tool: "charter_record",
                  action: "handoff_apply",
                  hint: "Pass `handoffNote: '<summary>'` describing what the subagent completed and any caveats.",
                },
              ],
            },
          );
        }
        if (!params.completedCriteria || params.completedCriteria.length === 0) {
          throw new CharterToolError(
            "charter_record action=handoff_apply requires 'completedCriteria' with at least one entry (each entry: {criterionId, outcome, summary[, artifacts, details]}); empty handoffs are not allowed.",
            {
              code: "handoff_apply.empty_completedCriteria",
              nextActions: [
                {
                  tool: "charter_record",
                  action: "handoff_apply",
                  hint: "Pass `completedCriteria: [{criterionId, outcome, summary}, ...]` with at least one entry (criterionIds match the VAL-* ids fulfilled by this feature).",
                },
                { tool: "charter_status", hint: "Use charter_status to list VAL-* criterion ids fulfilled by this feature." },
              ],
            },
          );
        }
        const result = await applyHandoff(ctx.cwd, {
          charterId: status.charterId,
          featureId: params.featureId,
          subagentSessionId: params.subagentSessionId,
          handoffNote: params.handoffNote,
          completedCriteria: params.completedCriteria,
        });
        await trySyncCharterReminder(pi, ctx.cwd, status.charterId);
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
      const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
      const result = await getCharterStatus(ctx.cwd, { charterId: resolved.charterId });
      return toolResult(formatCharterStatusText(result), result);
    },
  });
}

/**
 * Render a charter_status result as a compact text block for the LLM tool
 * channel. The full structured `result` still rides along in `toolResult`'s
 * details arg — this string is what the agent actually reads when reasoning.
 */
export function formatCharterStatusText(result: {
  charterId: string;
  name?: string;
  status: string;
  phase: string;
  objective: string;
  clarificationNote?: string;
  migrationHint?: string;
  drift: { uncovered: unknown[]; stuck: unknown[]; stale: unknown[]; readyNext: { featureId: string; fulfills: string[] }[] };
  qaBriefs?: string[];
  nextActions: { tool: string; action?: string; hint: string }[];
  guidelines: string[];
  details?: { blockingForComplete?: { criterionId: string; reason: string }[] };
}): string {
  const lines: string[] = [];
  const firstObjectiveLine = result.objective.split("\n", 1)[0] ?? "";
  const trimmedObjective = firstObjectiveLine.length > 120
    ? `${firstObjectiveLine.slice(0, 117)}...`
    : firstObjectiveLine;
  const idLabel = result.name ? `${result.name} (${result.charterId})` : result.charterId;
  lines.push(`Charter ${idLabel} [${result.status} · phase=${result.phase}]`);
  lines.push(`  objective: ${trimmedObjective}`);
  if (result.clarificationNote) {
    lines.push(`  clarification: ${result.clarificationNote}`);
  }
  if (result.migrationHint) {
    lines.push(`  migration: ${result.migrationHint}`);
  }
  lines.push(
    `  drift: uncovered=${result.drift.uncovered.length} stuck=${result.drift.stuck.length} stale=${result.drift.stale.length} readyNext=${result.drift.readyNext.length}`,
  );
  const blocking = result.details?.blockingForComplete ?? [];
  if (blocking.length > 0) {
    const preview = blocking.map((row) => `${row.criterionId}(${row.reason})`).join(", ");
    lines.push(`  blocking-for-complete: ${blocking.length} VAL(s): ${preview}`);
  }
  if ((result.qaBriefs?.length ?? 0) > 0) {
    lines.push(`  qa briefs: ${result.qaBriefs!.join(", ")}`);
  }
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

const CHARTERS_VERBS = ["status", "pause", "resume", "select", "list"] as const;
const CHARTER_USAGE_HINT = "Usage: /charter <objective>. pi-charter will read any files, paths, or URLs you reference before creating the charter. Use /charters to inspect or manage active charters.";

export function registerCharterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("charter", {
    description: "Hand a pi-charter objective to the agent. Bare prints a usage hint; use /charters to inspect or manage active charters.",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify(CHARTER_USAGE_HINT, "info");
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
          "Before calling any charter tool, do this:",
          "0. Read every file, path, or URL the user referenced above. If the user pointed at a handoff doc, spec, screenshot, or temp file, open it first with normal file tools. Recon is mandatory — pi-charter SKILL.md §2a 'Recon before authoring' explains why brittle charters come from skipping this.",
          "0b. If the request is ambiguous (short phrase, 'continue from handoff', 'make it better', no measurable outcome, contradictory requirements), ask the user EXACTLY ONE clarifying question before proceeding. Do not invent an objective.",
          "1. Extract the real objective from the material you read. Derive a short kebab-case 'name' (≤32 chars, no slugified instruction text — e.g. 'oauth-google-signin' not 'continue-handoff'). Then call charter_manage action=create with the extracted objective and derived name.",
          "2. Run charter_status to confirm the planning state and legal nextActions.",
          "3. Author the contract by editing .pi/charters/<id>/charter.md to add VAL-* criteria, scope, and constraints. Do NOT create a charter.md at the repo root.",
          "4. Seed the macro plan by calling charter_plan action=add_feature for each feature (id, milestone, order, fulfills[], body). Do NOT write plan/<featureId>.md files yourself — the tool writes them under .pi/charters/<id>/plan/.",
          "5. Before locking, delegate to subagent({agent:'charter-planner-critic'}) to stress-test coverage; resolve every BLOCK finding.",
          "6. Call charter_plan action=lock_plan to transition to active.",
          "7. Execute feature by feature. Prefer delegating to subagent({agent:'charter-reviewer', metadata:{'pi-charter.charterId':<id>,'pi-charter.featureId':<id>,'pi-charter.projectDir':<cwd>}}) for evidence rather than running verifier commands inline. Record results with charter_record action=evidence (manual) or charter_record action=verify (command verifier).",
          "8. Call charter_manage action=complete only after every criterion has pass evidence (charter_status will surface remaining gaps).",
          "",
          "Follow charter_status nextActions instead of guessing transitions. Read the pi-charter skill for the full workflow if you are unsure.",
          "You MUST use subagents (charter-planner-critic, charter-reviewer, explorer) rather than doing planning critique, verification, or read-only recon inline. Main agent context is precious; long charters die when it fills with grep results and tool output. Delegate aggressively.",
          "After lock_plan, implement every feature end-to-end without pausing to ask 'should I keep going?'. The locked plan is your authorization. Surface routine decisions (commit identity, build flags, branch names) in the work itself, not as blocking questions.",
        ].join("\n"),
      );
    },
  });

  // Closure-scoped reentry guard: the picker overlay is exclusive; a second
  // bare `/charters` while one is already open would stack overlays.
  let isPickerOpen = false;

  pi.registerCommand("charters", {
    description: "Inspect/manage active pi-charters. Bare opens the picker; verbs: status, pause, resume, select <id>|none, list.",
    getArgumentCompletions: async (prefix) => {
      const text = prefix ?? "";
      const spaceIndex = text.indexOf(" ");
      if (spaceIndex === -1) {
        // First token: complete the verb set.
        const lower = text.toLowerCase();
        return CHARTERS_VERBS
          .filter((verb) => verb.startsWith(lower))
          .map((verb) => ({ value: verb, label: verb }));
      }
      const head = text.slice(0, spaceIndex);
      const rest = text.slice(spaceIndex + 1);
      if (head !== "select") return null;
      const active = await listActiveCharters(process.cwd()).catch(() => [] as CharterListEntry[]);
      const lowerRest = rest.toLowerCase();
      const candidates = [...active.map((c) => c.charterId), "none"];
      return candidates
        .filter((v) => v.toLowerCase().startsWith(lowerRest))
        .map((v) => ({ value: `select ${v}`, label: `select ${v}` }));
    },
    handler: async (args, ctx) => {
      const text = args.trim();
      const active = await listActiveCharters(ctx.cwd).catch(() => [] as CharterListEntry[]);

      // Bare invocation: open the picker overlay (or fall back to a list
      // notification when there is no UI).
      if (!text) {
        await openPicker(pi, ctx, active, () => isPickerOpen, (v) => { isPickerOpen = v; });
        return;
      }

      // `list` is a quick text dump of every active charter.
      if (text === "list") {
        if (active.length === 0) {
          ctx.ui.notify("No active charters.", "info");
          return;
        }
        const lines = active.map((c) => `${c.charterId.slice(0, 8)}  ${c.name}  ${c.status}  ${c.passCount}/${c.totalCount}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // `select <id|none>` updates selection state and rebuilds widgets.
      if (text.startsWith("select")) {
        const arg = text.slice("select".length).trim();
        if (!arg) {
          ctx.ui.notify("Usage: /charters select <charterId|none>", "warning");
          return;
        }
        if (arg === "none") {
          setCharterSelection({ kind: "explicit-clear" });
          await requestSelectionRefreshSafe(ctx);
          ctx.ui.notify("pi-charter: detail selection cleared.", "info");
          return;
        }
        const match = active.find((c) => c.charterId === arg || c.charterId.startsWith(arg));
        if (!match) {
          ctx.ui.notify(`No active charter matches '${arg}'.`, "warning");
          return;
        }
        setCharterSelection({ kind: "explicit", charterId: match.charterId });
        await requestSelectionRefreshSafe(ctx);
        ctx.ui.notify(`pi-charter: selected ${match.name} (${match.charterId.slice(0, 8)}).`, "info");
        return;
      }

      // status | pause | resume operate on the resolved selection.
      if (text === "status" || text === "pause" || text === "resume") {
        const resolved = await resolveCharterForVerb(pi, ctx, active, () => isPickerOpen, (v) => { isPickerOpen = v; });
        if (!resolved) return;
        if (text === "status") {
          const status = await getCharterStatus(ctx.cwd, { charterId: resolved }).catch(() => undefined);
          if (!status) {
            ctx.ui.notify(`No status available for ${resolved}.`, "warning");
            return;
          }
          ctx.ui.notify(formatCharterStatusText(status), "info");
          return;
        }
        if (text === "pause") {
          const result = await pauseCharter(ctx.cwd, { charterId: resolved });
          ctx.ui.notify(result.message, "info");
          return;
        }
        const result = await resumeCharter(ctx.cwd, { charterId: resolved });
        ctx.ui.notify(result.message, "info");
        return;
      }

      ctx.ui.notify(`Unknown /charters verb '${text}'. Try one of: ${CHARTERS_VERBS.join(", ")}.`, "warning");
    },
  });
}

/**
 * Pull selection state and resolve a charter id for the verbs that operate on
 * "the selected charter". Fallbacks per spec: when selection is `unset` or
 * `explicit-clear`, use the sole active charter if exactly one exists;
 * otherwise re-open the picker in TUI mode, or notify a hint listing ids.
 * Returns `undefined` when the caller should NOT proceed (no charter available,
 * or the picker was opened instead).
 */
type CommandCtxLike = Pick<ExtensionCommandContext, "hasUI" | "cwd" | "ui" | "sessionManager">;

async function resolveCharterForVerb(
  pi: ExtensionAPI,
  ctx: CommandCtxLike,
  active: CharterListEntry[],
  isPickerOpen: () => boolean,
  setPickerOpen: (v: boolean) => void,
): Promise<string | undefined> {
  if (active.length === 0) {
    ctx.ui.notify("No active charters.", "info");
    return undefined;
  }
  const sel = getCharterSelection();
  if (sel.kind === "explicit") {
    if (active.some((c) => c.charterId === sel.charterId)) return sel.charterId;
    // The pinned charter terminated; downgrade and fall through to fallback.
    setCharterSelection({ kind: "unset" });
  }
  if (active.length === 1) return active[0]!.charterId;
  // Ambiguous: prefer the picker overlay in TUI mode, else just list ids.
  if (ctx.hasUI) {
    await openPicker(pi, ctx, active, isPickerOpen, setPickerOpen);
    return undefined;
  }
  const ids = active.map((c) => `${c.charterId.slice(0, 8)} (${c.name})`).join(", ");
  ctx.ui.notify(`Multiple active charters. Use /charters select <id> first. Active: ${ids}.`, "warning");
  return undefined;
}

async function openPicker(
  _pi: ExtensionAPI,
  ctx: CommandCtxLike,
  active: CharterListEntry[],
  isPickerOpen: () => boolean,
  setPickerOpen: (v: boolean) => void,
): Promise<void> {
  if (!ctx.hasUI) {
    if (active.length === 0) {
      ctx.ui.notify("No active charters.", "info");
      return;
    }
    const ids = active.map((c) => `${c.charterId.slice(0, 8)} (${c.name})`).join(", ");
    ctx.ui.notify(`Active charters: ${ids}.`, "info");
    return;
  }
  if (isPickerOpen()) {
    ctx.ui.notify("Charter picker already open.", "info");
    return;
  }
  setPickerOpen(true);
  try {
    const charters = await listAllCharters(ctx.cwd);
    const snapshotEntries = await Promise.all(
      charters.map(async (c) => {
        try {
          const snapshot = await buildPickerSnapshot(ctx.cwd, c.charterId);
          return snapshot ? ([c.charterId, snapshot] as const) : null;
        } catch {
          return null;
        }
      }),
    );
    const snapshots = new Map(snapshotEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const binding = sessionId ? await readSessionBinding({ sessionId }) : null;
    const boundCharterId = binding?.charterId ?? null;
    const initialId = boundCharterId ?? charters[0]?.charterId;

    const ui = ctx.ui as unknown as {
      custom<T>(factory: (tui: { terminal?: { rows?: number } }, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: unknown, done: (result: T) => void) => unknown, options?: { overlay?: boolean; overlayOptions?: unknown }): Promise<T>;
    };
    const notifyHost: ((message: string, type?: "info" | "warning" | "error") => void) | undefined =
      ctx.hasUI && typeof (ctx.ui as { notify?: unknown }).notify === "function"
        ? (msg, kind) => (ctx.ui as { notify: (m: string, t?: "info" | "warning" | "error") => void }).notify(msg, kind)
        : undefined;
    const result = await ui.custom<string | null>((tui, theme, _kb, done) => new CharterPickerComponent({
      charters,
      snapshots,
      theme,
      heightProvider: () => tui.terminal?.rows ?? 24,
      ...(initialId !== undefined ? { initialCursorCharterId: initialId } : {}),
      boundCharterId,
      onDone: done,
      host: {
        resolveCharterDir: (id) => charterDir(ctx.cwd, id),
        ...(notifyHost ? { notify: notifyHost } : {}),
      },
    }), {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
    if (result !== null) {
      setCharterSelection({ kind: "explicit", charterId: result });
      await requestSelectionRefreshSafe(ctx);
    }
  } finally {
    setPickerOpen(false);
  }
}

async function requestSelectionRefreshSafe(ctx: CommandCtxLike): Promise<void> {
  try {
    await requestSelectionRefresh(ctx);
  } catch {
    // Selection refresh is best-effort — the next turn_end will catch up.
  }
}

interface RegisterCharterFlagsOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
}

/**
 * Bind a child session to its root's charter using lineage payload from
 * pi-subagents. Replaces the legacy env-var path: when pi-subagents was a
 * separate process the child inherited `PI_SUBAGENT_ROOT_SESSION_ID`, but
 * with the in-process spawner that env channel no longer exists. The
 * `subagent:lineage` event carries the same information and fires on every
 * child session_start.
 *
 * No-ops when:
 *   - the session is already bound (idempotent on re-emit / reload),
 *   - the lineage payload has no rootSessionId (root session itself),
 *   - the root session has no charter binding,
 *   - the root's charter is in a terminal status (don't poison new children
 *     with a dead charter while the root's reverse pointer hasn't cleared).
 */
export async function autoBindChildFromLineage(input: {
  childSid: string;
  rootSid: string;
  homeDir?: string;
}): Promise<SessionBindingRecord | null> {
  if (!input.childSid || !input.rootSid || input.childSid === input.rootSid) return null;
  const existing = await readSessionBinding({ sessionId: input.childSid, homeDir: input.homeDir });
  if (existing) return null;

  const rootBinding = await readSessionBinding({ sessionId: input.rootSid, homeDir: input.homeDir });
  if (!rootBinding) return null;

  const rootState = await loadCharterState(charterDir(rootBinding.projectDir, rootBinding.charterId)).catch(() => undefined);
  if (rootState && TERMINAL_STATUSES.has(rootState.status)) return null;

  return writeChildBinding({
    sessionId: input.childSid,
    charterId: rootBinding.charterId,
    projectDir: rootBinding.projectDir,
    role: "participant",
    homeDir: input.homeDir,
  });
}

export function registerCharterFlags(pi: ExtensionAPI, options: RegisterCharterFlagsOptions = {}): void {
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
      // Auto-binding of child sessions now happens in the subagent-bridge
      // lineage handler (event-driven), not here. session_start can't read
      // the lineage cache because the lineage event may arrive after this
      // handler returns.
      const reconciled = await reconcileSessionBinding({ sessionId, homeDir: options.homeDir });
      const binding = reconciled;
      if (binding) {
        // Drop the session binding if it points at a terminal charter so the
        // reminder bus doesn't keep refreshing a dead charter on reload.
        const reconciledState = await loadCharterState(charterDir(binding.projectDir, binding.charterId)).catch(() => undefined);
        const terminal = reconciledState
          && (reconciledState.status === "completed"
            || reconciledState.status === "abandoned"
            || reconciledState.status === "budget_limited");
        if (terminal) {
          removeCharterReminder(pi, binding.charterId);
          await clearSessionBinding(sessionId, options.homeDir).catch(() => undefined);
        } else {
          if (reconciled) ctx.ui.notify(`pi-charter: resumed binding to ${reconciled.charterId}.`, "info");
          await trySyncCharterReminder(pi, binding.projectDir, binding.charterId);
        }
      }
    }

    const resumeId = String(pi.getFlag("charter-resume") ?? "").trim();
    if (resumeId) {
      const result = await resumeCharter(ctx.cwd, { charterId: resumeId });
      if (sessionId) {
        await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId, homeDir: options.homeDir });
      }
      await trySyncCharterReminder(pi, ctx.cwd, result.charterId);
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
        "1. Call charter_manage action=create with this objective. Pass a short kebab-case `name` (e.g. 'headless-click-pid') so the widget header is readable; do not embed objective text in id or name.",
        "2. Run charter_status; then edit .pi/charters/<id>/charter.md to add VAL-* criteria (do NOT create a repo-root charter.md).",
        "3. Seed features via charter_plan action=add_feature (id, milestone, order, fulfills[], body); do NOT write plan/*.md files yourself.",
        "4. Delegate plan critique to subagent({agent:'charter-planner-critic'}) before charter_plan action=lock_plan.",
        "5. Execute feature by feature. Prefer subagent({agent:'charter-reviewer'}) for evidence over inline verifier runs; record results with charter_record action=evidence or action=verify.",
        "6. Follow charter_status nextActions; never guess transitions. Read the pi-charter skill for the full workflow if you are unsure.",
        "7. After lock_plan, drive every feature to evidence end-to-end. Delegate verification and recon to subagents (charter-reviewer, charter-planner-critic, explorer) — main agent context is precious.",
        "8. Do not stop mid-charter to ask routine questions; surface decisions in the work itself.",
      ].join("\n"),
    );
  });
}

const EVALUATOR_CUSTOM_TYPE = "charter-evaluator-steer";
// Default evaluator model: cheap-fast tier, same shape Claude Code's /goal uses.
// Override per-environment via PI_CHARTER_EVAL_PROVIDER / PI_CHARTER_EVAL_MODEL.
// Per-turn evaluator runs every turn end. Sonnet, not Haiku: the evaluator
// judges drift against the full charter + drift views + recent tool history;
// that's a reasoning job, not a cheap-fast one. Latency at turn boundaries is
// not the bottleneck.
//
// The model id MUST match `getModel('anthropic', <id>)` from pi-ai’s registry
// (dash form, not dotted). Verified resolvable via
// `getModel('anthropic', 'claude-sonnet-4-6')`.
const DEFAULT_EVAL_PROVIDER = "anthropic";
const DEFAULT_EVAL_MODEL = "claude-sonnet-4-6";
const EVAL_TIMEOUT_MS = 60_000;
// Bumped from 600 — with thinking enabled the model needs headroom to think
// before emitting the JSON verdict. Anthropic counts thinking tokens against
// maxTokens, so 600 was being eaten by the reasoning phase alone.
const EVAL_MAX_TOKENS = 4096;

// Surface evaluator misconfiguration exactly once per process so users notice
// when no model is wired — previously this was a silent `return` and a wrong
// model id (e.g. dotted "claude-sonnet-4.6" instead of "claude-sonnet-4-5")
// meant the evaluator never ran and nobody saw why.
let evaluatorMisconfigNotified = false;

// Statuses where the evaluator has nothing useful to say: completed/abandoned
// charters are terminal; paused / budget_limited explicitly want the agent to
// stop chasing the charter. Skip the model call entirely (cost) and skip the
// steer (which was firing 'ready_to_complete' on already-completed charters
// and hammering the agent every turn).
const EVALUATOR_SKIP_STATUSES = new Set([
  "completed",
  "abandoned",
  "paused",
  "awaiting-clarification",
  "budget_limited",
]);

// Per-charter cooldown: if the last evaluator entry has the same verdict and
// was emitted within this window, skip. Prevents the same nudge firing every
// turn while the agent is mid-task.
const EVALUATOR_DEDUP_MS = 120_000;
const EVALUATOR_TRIGGER_VERDICTS = new Set<EvaluatorVerdict>([
  "blocked",
  "drifting",
  "ready_to_complete",
]);

interface RegisterCharterEvaluatorOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
  /** Test seam: avoid real model calls while exercising registration wiring. */
  modelFn?: EvaluatorModelFn;
}

/**
 * Ralph reprompt: dumb deterministic continuation loop.
 *
 * Replaces `registerCharterEvaluator`. Fires when pi-subagents reports the
 * whole session (main + every async child) is idle, looks up the bound
 * charter, and — if the charter is in a non-terminal status — sends a
 * status-driven prompt as a steer that triggers the next turn.
 *
 * Invariants:
 *   - The charter never stops on its own. Only paused/completed/abandoned/
 *     budget_limited states skip the reprompt.
 *   - No dedupe, no model call, no LLM judgment about whether to continue.
 *   - Trigger source is `subagent:all-idle`, never `turn_end`, so we don't
 *     reprompt while async subagents are still running.
 */
const RALPH_CUSTOM_TYPE = "charter-ralph-continue";

/**
 * Debounce window between `subagent:all-idle` and the actual reprompt. Gives
 * the user a chance to type something instead of getting an instant auto-turn
 * the moment the agent stops streaming.
 */
const RALPH_DEBOUNCE_MS = 10_000;

/**
 * Minimum wall-clock gap between two ralph sends in the same session. Backstop
 * against duplicate handlers, runaway debounce timers, and "all-idle fires
 * twice in a row" edge cases. The send-time idle gate is the real fix; this is
 * belt-and-suspenders.
 */
const RALPH_MIN_INTERVAL_MS = 30_000;

// Module-level counter so we can see at a glance how many loop instances
// got registered (every /reload re-runs the extension factory; if disposeSubs
// isn't fully clearing prior subscriptions, the counter will tell us).
let ralphLoopInstanceCounter = 0;

export function registerCharterRalphLoop(
  pi: ExtensionAPI,
  options: { homeDir?: string; debounceMs?: number; minIntervalMs?: number } = {},
): void {
  const instanceId = ++ralphLoopInstanceCounter;
  const log = logger.child({ component: "ralph-loop", instanceId });
  log.info("registerCharterRalphLoop: init", { totalInstancesEverRegistered: ralphLoopInstanceCounter });
  const debounceMs = options.debounceMs ?? RALPH_DEBOUNCE_MS;
  const minIntervalMs = options.minIntervalMs ?? RALPH_MIN_INTERVAL_MS;
  // pi.events has no ctx, so cache the latest session ctx from lifecycle
  // events. SUBAGENT_ALL_IDLE_EVENT fires AFTER turn_end / async children
  // complete, so this ctx is always populated by the time we need it.
  let lastCtx: ExtensionContext | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  // Track async subagents directly so we have a live busy-or-not snapshot at
  // send time. `ctx.isIdle()` only covers the root agent; async children are
  // tracked here in the same way the idle-probe widget does.
  const liveAsync = new Set<string>();
  let lastSentAt = 0;
  const cancelPending = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };
  const subs: Array<() => void> = [];
  let disposed = false;
  const disposeSubs = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of subs) unsubscribe();
    subs.length = 0;
  };
  const captureCtx = (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
  };
  pi.on("session_start", async (event, ctx) => captureCtx(event, ctx));
  pi.on("agent_start", async (event, ctx) => captureCtx(event, ctx));
  // Any new busy period invalidates a pending Ralph fire — we don't want to
  // reprompt while the agent or a subagent is back to work.
  pi.on("turn_start", async (event, ctx) => {
    captureCtx(event, ctx);
    cancelPending();
  });
  pi.on("turn_end", async (event, ctx) => captureCtx(event, ctx));
  pi.on("session_shutdown", async (event) => {
    log.info("session_shutdown: disposing subs", { reason: event.reason, subCount: subs.length, disposed });
    cancelPending();
    liveAsync.clear();
    disposeSubs();
  });
  subs.push(pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    try {
      const payload = raw as { runId?: string } | undefined;
      log.debug("event: async-started", { runId: payload?.runId, liveAsyncBefore: liveAsync.size, disposed });
      if (payload?.runId) liveAsync.add(payload.runId);
      cancelPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("async-started handler threw", { error: message });
    }
  }));
  subs.push(pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    try {
      const payload = raw as { runId?: string } | undefined;
      log.debug("event: async-complete", { runId: payload?.runId, liveAsyncBefore: liveAsync.size, disposed });
      if (payload?.runId) liveAsync.delete(payload.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("async-complete handler threw", { error: message });
    }
  }));

  subs.push(pi.events.on(SUBAGENT_ALL_IDLE_EVENT, (_payload: unknown) => {
    try {
      log.info("event: all-idle", { disposed, hasCtx: !!lastCtx, liveAsync: liveAsync.size });
      const ctx = lastCtx;
      if (!ctx) {
        log.warn("all-idle: no lastCtx, dropping");
        return;
      }
      if (disposed) {
        log.warn("all-idle fired on disposed instance (LEAK)");
        return;
      }
      cancelPending();
    log.debug("all-idle: scheduling reprompt", { debounceMs });
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      // The captured ctx may be stale by now (reload, session swap,
      // subagent ctx replacement). Wrap every ctx.* call so a stale-ctx
      // throw is logged as a skipped reprompt instead of crashing the
      // process via uncaughtException.
      try {
        if (disposed) {
          log.warn("timer fired on disposed instance (LEAK)");
          return;
        }
        let rootIdle: boolean;
        let pendingMessages: boolean;
        try {
          rootIdle = ctx.isIdle();
          pendingMessages = ctx.hasPendingMessages();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn("reprompt skipped: stale ctx at gate check", { error: message });
          return;
        }
        log.info("debounce timer fired", {
          disposed,
          rootIdle,
          pendingMessages,
          liveAsync: liveAsync.size,
          msSinceLastSend: Date.now() - lastSentAt,
        });
        if (!rootIdle) {
          log.info("reprompt skipped: root not idle");
          return;
        }
        if (pendingMessages) {
          log.info("reprompt skipped: pending user message");
          return;
        }
        if (liveAsync.size > 0) {
          log.info("reprompt skipped: async subagents running", { count: liveAsync.size });
          return;
        }
        const now = Date.now();
        if (now - lastSentAt < minIntervalMs) {
          log.info("reprompt skipped: min interval not elapsed", {
            elapsedMs: now - lastSentAt,
            minIntervalMs,
          });
          return;
        }
        lastSentAt = now;
        log.info("SENDING reprompt");
        void runRalphReprompt(pi, ctx, options, log).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn("runRalphReprompt threw", { error: message });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("ralph debounce timer threw", { error: message });
      }
    }, debounceMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("all-idle handler threw", { error: message });
    }
  }));
}

async function runRalphReprompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { homeDir?: string },
  log: ReturnType<typeof logger.child> = logger.child({ component: "ralph-loop" }),
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId?.();
  log.debug("runRalphReprompt enter", { sessionId });
  if (!sessionId) {
    log.warn("runRalphReprompt: no sessionId");
    return;
  }
  const binding = await readSessionBinding({ sessionId, homeDir: options.homeDir });
  if (!binding) {
    log.debug("runRalphReprompt: no session binding");
    return;
  }
  log.debug("runRalphReprompt: binding", { charterId: binding.charterId, role: binding.role });

  // Participant child sessions never auto-continue — the host owns the
  // ralph loop. Keep the ambient reminder fresh and bail.
  if (binding.role === "participant") {
    log.debug("runRalphReprompt: participant role, syncing reminder and bailing");
    await trySyncCharterReminder(pi, binding.projectDir, binding.charterId);
    return;
  }

  const built = await buildRalphPromptForCharter({
    projectDir: binding.projectDir,
    charterId: binding.charterId,
  });
  if (!built) {
    log.info("runRalphReprompt: status terminal/dormant, skip", { charterId: binding.charterId });
    return;
  }

  log.info("pi.sendMessage: ralph steer", { charterId: binding.charterId, promptCase: built.promptCase });
  pi.sendMessage(
    {
      customType: RALPH_CUSTOM_TYPE,
      content: built.content,
      // Visible in scrollback so the user can see the Ralph loop firing.
      // Codex hides the equivalent message, but here the loop is the whole
      // point of the charter UX — hiding it makes the auto-continuation feel
      // like a black box.
      display: true,
      details: { charterId: binding.charterId, promptCase: built.promptCase },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

export function registerCharterEvaluator(pi: ExtensionAPI, options: RegisterCharterEvaluatorOptions = {}): void {
  pi.on("turn_end", async (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId?.();
      if (!sessionId) return;
      const binding = await readSessionBinding({ sessionId, homeDir: options.homeDir });
      if (!binding) return;
      const projectDir = binding.projectDir;
      const charterId = binding.charterId;

      // Bail before the model call when the charter is in a terminal /
      // dormant state. No point reasoning about drift on a closed charter.
      const state = await loadCharterState(charterDir(projectDir, charterId)).catch(() => undefined);
      if (!state || EVALUATOR_SKIP_STATUSES.has(state.status)) return;

      if (binding.role === "participant") {
        await trySyncCharterReminder(pi, projectDir, charterId);
        return;
      }

      const recentUserMessages = extractRecentUserMessages(ctx, 2);
      const recentToolNames = extractRecentToolNames(ctx, 8);

      const modelFn = options.modelFn ?? buildEvaluatorModelFn(ctx);
      if (!modelFn) {
        if (!evaluatorMisconfigNotified && ctx.hasUI) {
          const provider = process.env.PI_CHARTER_EVAL_PROVIDER ?? DEFAULT_EVAL_PROVIDER;
          const modelId = process.env.PI_CHARTER_EVAL_MODEL ?? DEFAULT_EVAL_MODEL;
          ctx.ui.notify(
            `charter-evaluator disabled: model ${provider}/${modelId} not found in registry. Set PI_CHARTER_EVAL_PROVIDER/PI_CHARTER_EVAL_MODEL.`,
            "warning",
          );
          evaluatorMisconfigNotified = true;
        }
        return;
      }

      const entry = await runEvaluator(projectDir, {
        charterId,
        trigger: "turn_end",
        modelFn,
        recentUserMessages,
        recentToolNames,
      });
      const reminder = reminderFromEntry(entry);
      if (!reminder) return;

      // Dedup: if the previous entry had the same verdict within the cooldown
      // window, the model has nothing new to say. The just-written `entry` is
      // the last line of the log; read history and compare to the prior one.
      const history = await readEvaluatorLog(projectDir, charterId).catch(() => []);
      const prior = history.length >= 2 ? history[history.length - 2] : undefined;
      if (prior && prior.verdict === entry.verdict) {
        const priorTs = Date.parse(prior.ts);
        const currentTs = Date.parse(entry.ts);
        if (Number.isFinite(priorTs) && Number.isFinite(currentTs) && currentTs - priorTs < EVALUATOR_DEDUP_MS) {
          return;
        }
      }
      pi.sendMessage(
        {
          customType: EVALUATOR_CUSTOM_TYPE,
          content: reminder,
          display: true,
          details: entry,
        },
        { deliverAs: "steer", triggerTurn: EVALUATOR_TRIGGER_VERDICTS.has(entry.verdict) },
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
    // Drift reasoning is non-trivial; keep thinking enabled at 'medium'.
    // Explicit thinkingBudgets are well above Anthropic's 1024 floor so the
    // budget-based fallback path can't trigger `budget_tokens < 1024` errors.
    const options = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      timeoutMs: EVAL_TIMEOUT_MS,
      maxTokens: EVAL_MAX_TOKENS,
      reasoning: "medium",
      thinkingBudgets: { minimal: 4096, low: 4096, medium: 8192, high: 16384 },
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
  const subs: Array<() => void> = [];
  let disposed = false;
  pi.on("session_shutdown", () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of subs) unsubscribe();
    subs.length = 0;
  });
  subs.push(pi.events.on(SUBAGENT_EXPOSE_API_EVENT, (raw: unknown) => {
    const api = raw as SubagentExposedAPI | undefined;
    if (!api || typeof api.spawnRaw !== "function") return;
    subagentApi = api;
  }));
  // Auto-bind participant children via subagent:lineage. The in-process
  // spawner cannot propagate env vars, so this event is the only way the
  // charter extension learns the root→child session id mapping.
  subs.push(pi.events.on(SUBAGENT_LINEAGE_EVENT, (raw: unknown) => {
    try {
      const payload = raw as SubagentLineagePayload | undefined;
      if (!payload?.lineage || payload.lineage.role !== "child") return;
      const childSid = payload.sessionId ?? undefined;
      const rootSid = payload.lineage.rootSessionId ?? undefined;
      if (!childSid || !rootSid) return;
      void autoBindChildFromLineage({ childSid, rootSid }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("auto-bind child from lineage skipped", { error: message });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("lineage handler threw", { error: message });
    }
  }));
}

// ---------------------------------------------------------------------------
// pi-subagents bridge: surface 3 — async-event → MissionEvent attribution
// ---------------------------------------------------------------------------

export function registerCharterAsyncBridge(pi: ExtensionAPI): void {
  const subs: Array<() => void> = [];
  let disposed = false;
  pi.on("session_shutdown", () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of subs) unsubscribe();
    subs.length = 0;
  });
  subs.push(pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncStartedPayload | undefined;
    if (!payload) return;
    void handleAsyncStarted({ payload }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("async-bridge feature_started skipped", { error: message });
    });
  }));
  subs.push(pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncCompletePayload | undefined;
    if (!payload) return;
    void handleAsyncComplete({ payload }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("async-bridge feature_completed skipped", { error: message });
    });
  }));
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
  const subs: Array<() => void> = [];
  let disposed = false;

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
  subs.push(pi.events.on(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT, (raw: unknown) => {
    const payload = raw as PersonaDirErrorPayload | undefined;
    if (!payload || payload.extensionId !== PI_CHARTER_EXTENSION_ID) return;
    // No ctx here; events.on has no UI handle. Best-effort file log so the
    // conflict is visible without writing to stdout/stderr.
    logger.warn("persona dir registration failed", { error: payload.message });
  }));

  // Emit at startup …
  pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, registerPayload);

  // … and re-emit on session_start (matches pi-prune-swe-pruner-provider
  // re-announce pattern; survives pi-subagents restarts).
  pi.on("session_start", () => {
    pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, registerPayload);
  });

  pi.on("session_shutdown", () => {
    if (!disposed) {
      disposed = true;
      for (const unsubscribe of subs) unsubscribe();
      subs.length = 0;
    }
    pi.events.emit(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, unregisterPayload);
  });
}

// ---------------------------------------------------------------------------
// Widget: VAL progress strip rendered above the editor while a charter is
// bound. Snapshot recomputed on session_start, turn_end (covers every
// charter_* tool call within the turn), and async-bridge events. The widget
// hides itself when no charter is bound.
// ---------------------------------------------------------------------------

/** VM key for `ctx.ui.setWidget` while a charter is bound to this session. */
const DETAIL_WIDGET_KEY = "charter-detail";

interface RegisterCharterWidgetOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
}

/**
 * Custom renderer for the `charter-ralph-continue` steer.
 *
 * The Ralph loop is intentionally visible in scrollback (the auto-continuation
 * is the whole point of the UX), but the full prompt body is large and the
 * user usually only needs to know "the loop fired" plus the prompt case.
 *
 * Collapsed: single-line note with the prompt case and charter id.
 * Expanded: collapsed header + full prompt body in a bordered block.
 *
 * Border color is `info` to differentiate from `pi-reminders` which uses
 * `accent` — if both extensions are installed the two systems should be
 * visually distinct.
 */
export function registerCharterRalphMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<RalphMessageDetails>(
    RALPH_CUSTOM_TYPE,
    (message, options, theme) => {
      const details = (message.details ?? {}) as RalphMessageDetails;
      const promptCase = details.promptCase ?? "unknown";
      const charterId = details.charterId ?? "";
      const shortId = charterId ? charterId.slice(0, 8) : "—";
      const header = `● ralph loop fired · ${promptCase} · ${shortId}`;
      const content = typeof message.content === "string" ? message.content : "";
      // Different palette from pi-reminders (`accent`): use
      // `customMessageLabel` for the header text and `mdCodeBlockBorder` for
      // the expanded body box so both extensions are visually distinct.
      const headerColor = "customMessageLabel" as const;
      const borderColor = "mdCodeBlockBorder" as const;
      return {
        invalidate: () => {},
        render: (width: number): string[] => {
          if (!options.expanded) {
            return [theme.fg(headerColor, header)];
          }
          const lines: string[] = [theme.fg(headerColor, header)];
          if (!content) return lines;
          const bodyWidth = Math.max(20, width - 2);
          const border = (value: string) => theme.fg(borderColor, value);
          lines.push(border(`╭${"─".repeat(bodyWidth)}╮`));
          for (const rawLine of content.split("\n")) {
            for (const wrapped of wrapHardLine(rawLine, bodyWidth)) {
              const padded = wrapped + " ".repeat(Math.max(0, bodyWidth - wrapped.length));
              lines.push(border("│") + padded + border("│"));
            }
          }
          lines.push(border(`╰${"─".repeat(bodyWidth)}╯`));
          return lines;
        },
      };
    },
  );
}

interface RalphMessageDetails {
  charterId?: string;
  promptCase?: string;
}

function wrapHardLine(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    out.push(line.slice(i, i + width));
  }
  return out;
}

export function registerCharterWidget(pi: ExtensionAPI, options: RegisterCharterWidgetOptions = {}): void {
  const runningSubagents = new RunningSubagentRegistry();
  const subs: Array<() => void> = [];
  let disposed = false;

  const refresh = async (ctx: SelectionRefreshCtx): Promise<void> => {
    if (!ctx.hasUI) return;

    const sessionId = ctx.sessionManager.getSessionId?.();
    if (!sessionId) { ctx.ui.setWidget(DETAIL_WIDGET_KEY, undefined); return; }
    const binding = await reconcileSessionBinding({ sessionId, homeDir: options.homeDir });
    if (!binding) { ctx.ui.setWidget(DETAIL_WIDGET_KEY, undefined); return; }
    const charterId = binding.charterId;
    const snapshot = await loadCharterSnapshot({ projectDir: ctx.cwd, charterId, runningSubagents: runningSubagents.forCharter(charterId) });
    if (!snapshot) { ctx.ui.setWidget(DETAIL_WIDGET_KEY, undefined); return; }

    ctx.ui.setWidget(
      DETAIL_WIDGET_KEY,
      (tui, theme) => ({
        render: () => renderCharterWidget({ width: tui.terminal?.columns ?? 100, theme, vm: snapshot }),
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    );
  };

  registerSelectionRefresher(async (ctx) => {
    await refresh(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    resetCharterSelection();
    clearSelectionRefresher();
    if (!disposed) {
      disposed = true;
      for (const unsubscribe of subs) unsubscribe();
      subs.length = 0;
    }
  });

  // Subagent lifecycle: update the in-memory registry first so the next
  // snapshot reflects in-flight work. We don't have a session/UI handle
  // here, so we can't refresh immediately; the next turn_end (which usually
  // fires right after the async dispatch) will pick it up. Async-complete
  // also triggers a feature_state write in the async bridge, so turn_end is
  // the right beat anyway.
  subs.push(pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncStartedPayload | undefined;
    if (!payload) return;
    // Older spawns that pre-date the charterId stamp (or non-charter spawns
    // that happen to share this bus) are skipped rather than crashing the
    // registry; the per-charter filter is meaningless without an id.
    const charterId = payload.metadata?.[PI_CHARTER_METADATA_KEYS.charterId];
    if (typeof charterId !== "string" || charterId.length === 0) return;
    runningSubagents.start({
      runId: payload.runId,
      charterId,
      agent: payload.agent,
      metadata: payload.metadata,
      startedAt: payload.startedAt !== undefined ? new Date(payload.startedAt).toISOString() : undefined,
    });
  }));
  subs.push(pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncCompletePayload | undefined;
    if (!payload) return;
    runningSubagents.complete(payload.runId);
  }));
}

async function tryUpsertCharterReminder(pi: ExtensionAPI, projectDir: string, charterId: string): Promise<void> {
  try {
    await upsertCharterReminder(pi, projectDir, charterId);
  } catch {
    // Reminder bridge is ambient; lifecycle tools must still succeed if a
    // subscriber or sidecar read fails after the primary state transition.
  }
}

function tryRemoveCharterReminder(pi: ExtensionAPI, charterId: string): void {
  try {
    removeCharterReminder(pi, charterId);
  } catch {
    // Reminder bridge is ambient; terminal transitions must not depend on it.
  }
}

async function trySyncCharterReminder(pi: ExtensionAPI, projectDir: string, charterId: string): Promise<void> {
  try {
    const state = await loadCharterState(charterDir(projectDir, charterId));
    // Terminal charters are removed; planning/active/review/paused keep a
    // status-aware reminder so the agent always sees the correct next step.
    if (state.status === "completed" || state.status === "abandoned" || state.status === "budget_limited") {
      removeCharterReminder(pi, charterId);
      return;
    }
    await upsertCharterReminder(pi, projectDir, charterId);
  } catch {
    // Reminder bridge is ambient; status refresh must not break the primary flow.
  }
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
