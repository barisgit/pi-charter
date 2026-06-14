import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { connect, type UtilsClient } from "pi-extension-utils";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { recordEvidenceBatch, recordEvidenceFromFile, type EvidenceEntry } from "./record-service";
import { abandonCharter, completeCharter, createCharter, getCharterStatus, pauseCharter, resumeCharter } from "./service";
import { CharterToolError } from "./errors";
import { bindCharterToSession, clearSessionBinding, rebindCharter, reconcileSessionBinding, readSessionBinding, resolveCharterId, writeChildBinding, type SessionBindingRecord } from "./binding-service";
import { buildRalphPromptForCharter } from "./ralph-service";
import { formatCommandsInline } from "./subagent-bootstrap";
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
  type SubagentAsyncCompletePayload,
  type SubagentAsyncStartedPayload,
  type SubagentExposedAPI,
  type SubagentLineagePayload,
} from "../infrastructure/subagent-bridge";
import { handleAsyncComplete, handleAsyncStarted } from "./async-bridge-service";
import { __resetSubagentApiForTests, getSubagentApi, setSubagentApiForBridge } from "./subagent-api";
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

type CharterInput = {
  action: "create" | "pause" | "resume" | "complete" | "abandon";
  charterId?: string;
  name?: string;
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

type EvidenceBatchEntryInput = {
  criterionId: string;
  featureId?: string;
  outcome: "pass" | "fail" | "partial";
  summary: string;
  because?: string;
  artifacts?: string[];
  details?: object;
  source?: "manual" | "verifier" | "subagent";
};

type CharterRecordInput =
  | { action: "evidence"; charterId?: string; entries: EvidenceBatchEntryInput[]; evidenceFile?: never }
  | { action: "evidence"; charterId?: string; evidenceFile: string; entries?: never };

const CharterParams = Type.Object({
  action: StringEnum(["create", "pause", "resume", "complete", "abandon"] as const),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional for every action except create; when omitted, resolves to the charter bound to the current session." })),
  name: Type.Optional(Type.String({ description: "Optional short slug shown in widget headers and status (e.g. 'headless-click-pid'). Lowercased; non-slug chars stripped; clamped to 32 chars. Falls back to the first 8 chars of the charterId when omitted." })),
  objective: Type.Optional(Type.String({ description: "Required for action=create. The desired outcome, not a spec path." })),
  reason: Type.Optional(Type.String({ description: "Pause or abandon reason. Required for action=abandon." })),
  completionNote: Type.Optional(Type.String({ description: "Completion note for action=complete." })),
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

const EvidenceEntryParams = Type.Object({
  criterionId: Type.String(),
  featureId: Type.Optional(Type.String()),
  outcome: StringEnum(["pass", "fail", "partial"] as const),
  summary: Type.String(),
  because: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(Type.String())),
  details: Type.Optional(Type.Object({}, { additionalProperties: true })),
  source: Type.Optional(StringEnum(["manual", "verifier", "subagent"] as const)),
}, { additionalProperties: false });

// Flat single-object schema for OpenAI strict-mode + Anthropic anyOf-confusion
// compatibility. All action-specific fields are Optional here; per-action
// required-field validation is enforced at runtime in the execute handler.
const CharterRecordParams = Type.Object({
  action: StringEnum(["evidence"] as const, {
    description: "What to record: 'evidence' (manual/typed file).",
  }),
  charterId: Type.Optional(Type.String({ description: "Charter UUID. Optional; when omitted, resolves to the charter bound to the current session." })),
  evidenceFile: Type.Optional(Type.String({ description: "Path to typed evidence JSON (kind=command|review|qa|readiness) to import for action=evidence. Mutually exclusive with `entries`." })),
  entries: Type.Optional(Type.Array(EvidenceEntryParams, { description: "Batch evidence entries for action=evidence; the batch is atomic within the call (one criterion-state.json write covering all entries). Mutually exclusive with `evidenceFile`." })),
}, { additionalProperties: false });

interface RegisterCharterToolsOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
}

const RALPH_CUSTOM_TYPE = "charter-ralph-continue";

export function registerCharterTools(pi: ExtensionAPI, options: RegisterCharterToolsOptions = {}): void {
  pi.registerTool({
    name: "charter",
    label: "Charter",
    description: "Manage pi-charter lifecycle actions: create, pause, resume, complete, abandon.",
    promptSnippet: "Manage a durable charter lifecycle with minimal create input and evidence-gated completion.",
    promptGuidelines: [
      "Use charter action=create when the user asks for durable charter-bound work; provide only objective, optional budget, and optional idempotencyKey.",
      "Do not pass spec paths to charter. Read spec files with normal file tools and author charter.md plus criteria.md directly.",
    ],
    parameters: CharterParams,
    async execute(_toolCallId, params: CharterInput, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "create": {
          if (!params.objective?.trim()) throw new Error("objective is required for charter action=create");
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
          return toolResult(result.message, result);
        }
        case "pause": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await pauseCharter(ctx.cwd, { charterId: resolved.charterId, reason: params.reason });
          return toolResult(result.message, result);
        }
        case "resume": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await resumeCharter(ctx.cwd, { charterId: resolved.charterId });
          const sessionId = ctx.sessionManager.getSessionId?.();
          if (sessionId) {
            await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId, homeDir: options.homeDir });
          }
          return toolResult(result.message, result);
        }
        case "complete": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await completeCharter(ctx.cwd, { charterId: resolved.charterId, completionNote: params.completionNote });
          return toolResult(result.message, result);
        }
        case "abandon": {
          const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
          const result = await abandonCharter(ctx.cwd, {
            charterId: resolved.charterId,
            reason: params.reason ?? "",
          });
          return toolResult(result.message, result);
        }
      }
    },
  });

  pi.registerTool({
    name: "charter_record",
    label: "Charter Record",
    description: "Record evidence against charter criteria.",
    promptSnippet: "Record evidence and link results back to charter criteria.",
    promptGuidelines: [
      "Evidence is required for criteria with requireFreshEvidence before complete is allowed.",
    ],
    parameters: CharterRecordParams,
    async execute(_toolCallId, params: CharterRecordInput, _signal, _onUpdate, ctx) {
      const resolved = await resolveCharterId(params, { sessionId: ctx.sessionManager.getSessionId?.(), homeDir: options.homeDir });
      const status = await getCharterStatus(ctx.cwd, { charterId: resolved.charterId });
      if (params.action === "evidence") {
        const hasEvidenceFile = Boolean(params.evidenceFile?.trim());
        if (hasEvidenceFile && params.entries !== undefined) {
          throw new CharterToolError("charter_record action=evidence: provide either evidenceFile or entries, not both.", {
            code: "evidence.mixed_inputs",
            nextActions: [
              { tool: "charter_record", action: "evidence", hint: "Use `evidenceFile: '<path>'` by itself, or omit evidenceFile and pass entries:[...]." },
            ],
          });
        }
        if (hasEvidenceFile) {
          const imported = await recordEvidenceFromFile(ctx.cwd, {
            charterId: status.charterId,
            evidenceFile: params.evidenceFile!,
          });
          return toolResult(`Imported evidence for ${imported.criterionId} (${imported.entries.length} criteria).`, imported);
        }
        if (!params.entries || params.entries.length === 0) throw new Error("entries array must be non-empty for charter_record action=evidence");
        const batch = await recordEvidenceBatch(ctx.cwd, {
          charterId: status.charterId,
          entries: params.entries as EvidenceEntry[],
        });
        return toolResult(`Recorded ${batch.entries.length} evidence entries for charter ${batch.charterId}.`, batch);
      }
      throw new Error("charter_record action is not implemented yet");
    },
  });

  pi.registerTool({
    name: "charter_status",
    label: "Charter Status",
    description: "Read the current charter status, drift views, and legal nextActions.",
    promptSnippet: "Inspect charter state, drift views, and legal nextActions before choosing the next move.",
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
  migrationHint?: string;
  drift: {
    uncovered: unknown[];
    stale: unknown[];
    readyNext: { criterionId: string; milestoneId: string }[];
    sidecarDrift?: { path: string; lastToolWriteAt: string; fileMtimeMs: number }[];
    milestoneArtifacts?: { milestoneId: string; reason: string }[];
  };
  milestones?: { milestoneId: string; title: string; criterionIds: string[]; valCount: number; valPassCount: number }[];
  qaBriefs?: string[];
  commands?: Record<string, string>;
  nextActions: { tool: string; action?: string; hint: string }[];
  guidelines: string[];
  details?: { blockingForComplete?: { criterionId?: string; reason: string; featureId?: string; probeResult?: string; handoffPath?: string; itemId?: string; description?: string }[] };
  parseWarnings?: { criterionId?: string; reason: string; section?: string; key?: string; detail?: string }[];
  valTotal?: number;
  valPass?: number;
  registerEmpty?: boolean;
}): string {
  const lines: string[] = [];
  const firstObjectiveLine = result.objective.split("\n", 1)[0] ?? "";
  const trimmedObjective = firstObjectiveLine.length > 120
    ? `${firstObjectiveLine.slice(0, 117)}...`
    : firstObjectiveLine;
  const idLabel = result.name ? `${result.name} (${result.charterId})` : result.charterId;
  lines.push(`Charter ${idLabel} [${result.status} · phase=${result.phase}]`);
  lines.push(`  objective: ${trimmedObjective}`);
  if (result.migrationHint) {
    lines.push(`  migration: ${result.migrationHint}`);
  }
  if (result.registerEmpty) {
    lines.push(
      "  REGISTER EMPTY: 0 VAL criteria parsed from criteria.md. This is not a finished charter — either criteria were never authored or criteria.md failed to parse. Check parse-warnings below and author/repair criteria.md.",
    );
  } else if (typeof result.valTotal === "number") {
    lines.push(`  VAL totals: ${result.valPass ?? 0}/${result.valTotal} pass`);
  }
  const drift = result.drift ?? { uncovered: [], stale: [], readyNext: [], sidecarDrift: [], milestoneArtifacts: [] };
  lines.push(
    `  drift: uncovered=${drift.uncovered.length} stale=${drift.stale.length} readyNext=${drift.readyNext.length} sidecarDrift=${drift.sidecarDrift?.length ?? 0} milestoneArtifacts=${drift.milestoneArtifacts?.length ?? 0}`,
  );
  if ((drift.sidecarDrift?.length ?? 0) > 0) {
    const preview = drift.sidecarDrift!.map((entry) => `${entry.path}(edited out-of-band)`).join(", ");
    lines.push(`  sidecar-drift: ${preview}`);
  }
  if ((drift.milestoneArtifacts?.length ?? 0) > 0) {
    const preview = drift.milestoneArtifacts!.map((entry) => `${entry.milestoneId}(${entry.reason})`).join(", ");
    lines.push(`  milestone-artifacts: ${preview}`);
  }
  if ((result.milestones?.length ?? 0) > 0) {
    lines.push("  milestones:");
    for (const milestone of result.milestones!) {
      const valPreview = milestone.criterionIds.slice(0, 3).join(", ");
      const more = milestone.criterionIds.length > 3 ? ", ..." : "";
      const label = milestone.milestoneId || "(flat)";
      lines.push(`    - ${label}: VALs=${milestone.valCount} pass=${milestone.valPassCount} :: ${valPreview}${more}`);
    }
  }
  const parseWarnings = result.parseWarnings ?? [];
  if (parseWarnings.length > 0) {
    const preview = parseWarnings
      .slice(0, 5)
      .map((w) => {
        const who = w.criterionId ?? w.section ?? w.key ?? "criteria.md";
        return w.detail ? `${who}: ${w.reason} (${w.detail})` : `${who}: ${w.reason}`;
      })
      .join("; ");
    const more = parseWarnings.length > 5 ? ", ..." : "";
    lines.push(`  parse-warnings: ${parseWarnings.length} — ${preview}${more}`);
  }
  const blocking = result.details?.blockingForComplete ?? [];
  if (blocking.length > 0) {
    const preview = blocking.map((row) => {
      if (row.reason.startsWith("report-")) {
        const section = row.description ?? "REPORT.md";
        return `REPORT.md/${section}(${row.reason})`;
      }
      return `${row.featureId ?? row.criterionId ?? row.handoffPath ?? row.itemId ?? "item"}(${row.reason})`;
    }).join(", ");
    const unit = blocking.some((row) => row.featureId) ? "item(s)" : "VAL(s)";
    lines.push(`  blocking-for-complete: ${blocking.length} ${unit}: ${preview}`);
  }
  if ((result.qaBriefs?.length ?? 0) > 0) {
    lines.push(`  qa briefs: ${result.qaBriefs!.join(", ")}`);
  }
  const commands = formatCommandsInline(result.commands);
  if (commands) {
    lines.push(`  commands: ${commands}`);
  }
  if (result.drift.readyNext.length > 0) {
    const preview = result.drift.readyNext
      .slice(0, 3)
      .map((entry) => `${entry.criterionId}${entry.milestoneId ? ` @ ${entry.milestoneId}` : ""}`)
      .join("; ");
    lines.push(`  ready-next VAL: ${preview}${result.drift.readyNext.length > 3 ? ", ..." : ""}`);
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
      // tool surface where the agent can read and shape the contract.
      pi.sendUserMessage(
        [
          "The user has handed you a new pi-charter objective:",
          "",
          text,
          "",
          "Before calling any charter tool, do this:",
          "0. Read every file, path, or URL the user referenced above. If the user pointed at a handoff doc, spec, screenshot, or temp file, open it first with normal file tools. Recon is mandatory — pi-charter SKILL.md §2a 'Recon before authoring' explains why brittle charters come from skipping this.",
          "0b. If the request is ambiguous (short phrase, 'continue from handoff', 'make it better', no measurable outcome, contradictory requirements), ask the user EXACTLY ONE clarifying question before proceeding. Do not invent an objective.",
          "1. Extract the real objective from the material you read. Derive a short kebab-case 'name' (≤32 chars, no slugified instruction text — e.g. 'oauth-google-signin' not 'continue-handoff'). Then call charter action=create with the extracted objective and derived name.",
          "2. Run charter_status to confirm the active state and legal nextActions.",
          "3. Author the contract by editing .pi/charters/<id>/criteria.md for VAL-* criteria and .pi/charters/<id>/charter.md for scope/constraints. Do NOT create a charter.md at the repo root.",
          "4. Execute work toward each VAL. Record results with charter_record action=evidence.",
          "5. Call charter action=complete only after every criterion has pass evidence (charter_status will surface remaining gaps).",
          "",
          "Follow charter_status nextActions instead of guessing transitions. Read the pi-charter skill for the full workflow if you are unsure.",
          "Delegate read-only recon, verification, and critique to user-owned subagents rather than doing that work inline. Main agent context is precious; long charters die when it fills with grep results and tool output. Prefer `subagent({async:true, ...})` when the next step does not need the child's output — async returns immediately and main keeps working in parallel. Sync subagent calls block main entirely until the child finishes; use them only when the next move depends on the result.",
          "Drive every VAL to evidence end-to-end without pausing to ask 'should I keep going?'. Surface routine decisions (commit identity, build flags, branch names) in the work itself, not as blocking questions.",
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
  pi: ExtensionAPI,
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
    // Blank coordinated widgets (e.g. the aboveEditor charter panel) while the
    // fullscreen overlay is open so they don't bleed through. We can't reuse
    // ctx.ui.fullscreen()/client.ui.fullscreen(): that wrapper calls ui.custom
    // with no options and would drop the overlay anchoring the picker needs. So
    // we replicate its lease handling around the existing ui.custom call. A
    // dedicated client with a distinct clientId is used (not the widget
    // client's "pi-charter") because connect() is not idempotent and a shared
    // clientId would let dispose() unregister the real charter widget; the
    // host's fullscreen stack is global, so any client's lease blanks it.
    const pickerClient = connect(pi as unknown as Parameters<typeof connect>[0], {
      ctx: ctx as unknown as Parameters<typeof connect>[1]["ctx"],
      clientId: "pi-charter-picker",
    });
    const lease = pickerClient.fullscreen.acquire();
    let result: string | null;
    try {
      result = await ui.custom<string | null>((tui, theme, _kb, done) => new CharterPickerComponent({
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
    } finally {
      lease.release();
      pickerClient.dispose();
    }
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
        // Drop the stale session binding if it points at a terminal charter.
        const reconciledState = await loadCharterState(charterDir(binding.projectDir, binding.charterId)).catch(() => undefined);
        const terminal = reconciledState
          && (reconciledState.status === "completed"
            || reconciledState.status === "abandoned");
        if (terminal) {
          await clearSessionBinding(sessionId, options.homeDir).catch(() => undefined);
        } else {
          if (reconciled) ctx.ui.notify(`pi-charter: resumed binding to ${reconciled.charterId}.`, "info");
        }
      }
    }

    const resumeId = String(pi.getFlag("charter-resume") ?? "").trim();
    if (resumeId) {
      const result = await resumeCharter(ctx.cwd, { charterId: resumeId });
      if (sessionId) {
        await rebindCharter(ctx.cwd, { charterId: result.charterId, sessionId, homeDir: options.homeDir });
      }
      ctx.ui.notify(result.message, "info");
      return;
    }

    const objective = String(pi.getFlag("charter-objective") ?? "").trim();
    if (!objective) return;
    // Same authorship rule as the /charter slash command: hand the objective
    // to the agent rather than creating the charter directly. The agent will
    // call charter action=create with a concise id during turn 1.
    pi.sendUserMessage(
      [
        "The user launched pi with --charter-objective. Start a new charter end-to-end:",
        "",
        objective,
        "",
        "1. Call charter action=create with this objective. Pass a short kebab-case `name` (e.g. 'headless-click-pid') so the widget header is readable; do not embed objective text in id or name.",
        "2. Run charter_status; then edit .pi/charters/<id>/criteria.md to add VAL-* criteria (do NOT create a repo-root charter.md).",
        "3. Execute work toward each VAL. Record results with charter_record action=evidence.",
        "4. Follow charter_status nextActions; never guess transitions. Read the pi-charter skill for the full workflow if you are unsure.",
        "5. Drive every VAL to evidence end-to-end. Delegate verification and recon to subagents — main agent context is precious.",
        "6. Do not stop mid-charter to ask routine questions; surface decisions in the work itself.",
        "7. Call charter action=complete only after every criterion has pass evidence.",
      ].join("\n"),
    );
  });
}


// ---------------------------------------------------------------------------
// pi-subagents bridge: surface 2 — capture exposed API bag
// ---------------------------------------------------------------------------

export { __resetSubagentApiForTests, getSubagentApi } from "./subagent-api";

export function registerCharterSubagentBridge(pi: ExtensionAPI): void {
  // Reset on each registration so repeated extension loads in tests/dev
  // don't keep a stale handle from a prior pi-subagents lifecycle.
  setSubagentApiForBridge(undefined);
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
    setSubagentApiForBridge(api);
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
// Widget: VAL progress strip rendered above the editor while a charter is
// bound. Snapshot recomputed on session_start, turn_end (covers every
// charter_* tool call within the turn), and async-bridge events. The widget
// hides itself when no charter is bound.
// ---------------------------------------------------------------------------

/** VM key for the coordinated detail widget while a charter is bound to this session. */
const DETAIL_WIDGET_KEY = "charter-detail";

interface RegisterCharterWidgetOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
}

interface RegisterCharterRalphLoopOptions {
  /** Test seam: keep production bound to the normal home directory. */
  homeDir?: string;
  /** Test seam: collapse or widen the all-idle debounce. */
  debounceMs?: number;
  /** Test seam: collapse or widen duplicate prompt suppression. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Wait this long after subagent:all-idle fires before re-prompting. Gives the
 * user a window to interrupt with a quick message after the agent stops
 * streaming without immediately being trampled by a Ralph reprompt.
 */
const RALPH_DEBOUNCE_MS = 10_000;

/**
 * Floor between Ralph reprompts regardless of how often all-idle fires.
 * Suppresses duplicates when the host emits all-idle multiple times for a
 * single quiet stretch (turn-end + subagent completion can both land).
 *
 * Critically: when this floor blocks a fire we MUST reschedule ourselves for
 * the remaining window. Ralph is event-driven on subagent:all-idle, so if a
 * blocked fire just `return`ed we could end up in a "dedupe blackhole" where
 * the next reprompt depends on an external event that may never come (idle
 * agent + idle subagents = no more all-idle). The reschedule below makes the
 * loop self-healing: the floor only delays, never silently drops a reprompt.
 */
const RALPH_MIN_INTERVAL_MS = 30_000;
const RALPH_LOG_COMPONENT = "ralph-loop";

export function registerCharterRalphLoop(pi: ExtensionAPI, options: RegisterCharterRalphLoopOptions = {}): void {
  const runningSubagents = new Set<string>();
  const debounceMs = options.debounceMs ?? RALPH_DEBOUNCE_MS;
  const minIntervalMs = options.minIntervalMs ?? RALPH_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastCtx: ExtensionContext | undefined;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;

  const rememberCtx = (_event: unknown, ctx: ExtensionContext): void => {
    lastCtx = ctx;
  };

  pi.on("session_start", rememberCtx);
  pi.on("turn_end", rememberCtx);
  pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncStartedPayload | undefined;
    if (payload?.runId) runningSubagents.add(payload.runId);
  });
  pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    const payload = raw as SubagentAsyncCompletePayload | undefined;
    if (payload?.runId) runningSubagents.delete(payload.runId);
  });
  pi.events.on(SUBAGENT_ALL_IDLE_EVENT, () => {
    logger.debug("ralph: all-idle event received", { component: RALPH_LOG_COMPONENT });
    scheduleRalph();
  });

  function scheduleRalph(): void {
    if (timer) clearTimeout(timer);
    if (debounceMs <= 0) {
      void maybeSendRalph();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void maybeSendRalph({ fromDebounce: true });
    }, debounceMs);
    logger.debug("ralph: debounce scheduled", { component: RALPH_LOG_COMPONENT, debounceMs });
  }

  async function maybeSendRalph(input: { fromDebounce?: boolean } = {}): Promise<void> {
    if (input.fromDebounce) logger.debug("ralph: debounce fired", { component: RALPH_LOG_COMPONENT });
    if (sending || runningSubagents.size > 0) return;
    const ctx = lastCtx;
    if (!ctx) return;

    sending = true;
    try {
      // Captured ctx can become stale across session replacement
      // (newSession/fork/switchSession/reload). Any ExtensionContext method
      // may throw 'stale after session replacement'; if it does, drop the
      // captured ctx and wait for the next session_start/turn_end to refresh.
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;
      const at = now();
      if (minIntervalMs > 0 && at - lastSentAt < minIntervalMs) {
        // Self-heal: schedule a retry for the remaining window so we never
        // depend on another all-idle event arriving to escape the floor.
        // Ralph must never silently stop — it's a fail-loop, not a debounce.
        const remainingMs = minIntervalMs - (at - lastSentAt);
        if (timer) clearTimeout(timer);
        logger.debug("ralph: min-interval suppressed; rescheduling", { component: RALPH_LOG_COMPONENT, remainingMs, minIntervalMs });
        timer = setTimeout(() => {
          timer = undefined;
          logger.debug("ralph: reschedule timer fired", { component: RALPH_LOG_COMPONENT });
          void maybeSendRalph();
        }, remainingMs);
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId?.();
      if (!sessionId) return;

      const binding = await readSessionBinding({ sessionId, homeDir: options.homeDir });
      if (!binding) return;
      const prompt = await buildRalphPromptForCharter({
        projectDir: binding.projectDir,
        charterId: binding.charterId,
        cwd: ctx.cwd,
      });
      if (!prompt) return;
      lastSentAt = at;
      const payloadKind = RALPH_CUSTOM_TYPE;
      const payloadLength = prompt.content.length;
      pi.sendMessage(
        {
          customType: payloadKind,
          content: prompt.content,
          display: true,
          details: {
            charterId: binding.charterId,
            promptCase: prompt.promptCase,
          },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      logger.debug("ralph: message sent", { component: RALPH_LOG_COMPONENT, payloadKind, payloadLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale after session replacement")) {
        // Drop the captured ctx; the next session_start/turn_end refreshes it.
        lastCtx = undefined;
      }
      logger.debug("ralph loop skipped", { component: RALPH_LOG_COMPONENT, error: message });
    } finally {
      sending = false;
    }
  }
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
  let client: UtilsClient | undefined;

  const getClient = (ctx: SelectionRefreshCtx): UtilsClient => {
    client ??= connect(pi as unknown as Parameters<typeof connect>[0], { ctx: ctx as unknown as Parameters<typeof connect>[1]["ctx"], clientId: "pi-charter" });
    return client;
  };

  const removeWidget = (ctx: SelectionRefreshCtx): void => {
    getClient(ctx).widgets.remove("aboveEditor", DETAIL_WIDGET_KEY);
  };

  const refresh = async (ctx: SelectionRefreshCtx): Promise<void> => {
    if (!ctx.hasUI) return;

    const sessionId = ctx.sessionManager.getSessionId?.();
    if (!sessionId) { removeWidget(ctx); return; }
    const binding = await reconcileSessionBinding({ sessionId, homeDir: options.homeDir });
    if (!binding) { removeWidget(ctx); return; }
    const charterId = binding.charterId;
    const snapshot = await loadCharterSnapshot({ projectDir: ctx.cwd, charterId, runningSubagents: runningSubagents.forCharter(charterId) });
    if (!snapshot) { removeWidget(ctx); return; }

    const factory: Parameters<UtilsClient["widgets"]["set"]>[2] = (tui, theme) => {
      const typedTui = tui as { terminal?: { columns?: number } };
      return {
        render: () => renderCharterWidget({ width: typedTui.terminal?.columns ?? 100, theme: theme as Parameters<typeof renderCharterWidget>[0]["theme"], vm: snapshot }),
        invalidate: () => {},
      };
    };
    // order: 80 keeps the charter panel nearest the editor (highest order renders
    // closest to the prompt). Convention across the widget set, bottom->top:
    // charter(80), subagents(60), processes(40), tasks(20). Lower numbers render
    // further from the editor, leaving room for other extensions to slot between.
    getClient(ctx).widgets.set("aboveEditor", DETAIL_WIDGET_KEY, factory, { order: 80 });
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
      client?.dispose();
      client = undefined;
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

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
