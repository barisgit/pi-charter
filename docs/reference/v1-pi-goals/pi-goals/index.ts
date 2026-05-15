import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type GoalStatus = "active" | "paused" | "completed";

interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	criteria: string[];
	constraints: string[];
	nextAction?: string;
	evidence: string[];
	risks: string[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	completionNote?: string;
	turnsActive: number;
}

type GoalManageParamsType = {
	action: "create" | "update" | "pause" | "resume" | "complete" | "clear";
	objective?: string;
	criteria?: string[];
	constraints?: string[];
	nextAction?: string | null;
	evidence?: string[];
	risks?: string[];
	completionNote?: string;
};

const SOURCE = "pi-goals";
const REMINDER_ID = "active-goal";
const CUSTOM_TYPE = "pi-goal";
const REMINDER_UPSERT_EVENT = "reminder:upsert";
const REMINDER_REMOVE_EVENT = "reminder:remove";
const MAX_LIST_ITEMS = 6;
const MAX_REMINDER_CHARS = 900;
const DEFAULT_REPEAT_TURNS = 8;

interface ReminderIntent {
	id: string;
	source: string;
	text: string;
	label?: string;
	priority?: number;
	display?: boolean;
	ttl?: "once" | "session" | "persistent";
	repeatEveryTurns?: number;
	metadata?: Record<string, unknown>;
}

interface ReminderRemoveRequest {
	source: string;
	id: string;
}

const GoalManageParams = Type.Object({
	action: StringEnum(["create", "update", "pause", "resume", "complete", "clear"] as const),
	objective: Type.Optional(Type.String({ description: "Goal objective. Required for create; optional for update." })),
	criteria: Type.Optional(Type.Array(Type.String({ description: "Observable completion criterion." }))),
	constraints: Type.Optional(Type.Array(Type.String({ description: "Constraint, non-goal, or implementation boundary." }))),
	nextAction: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	evidence: Type.Optional(Type.Array(Type.String({ description: "Concrete evidence checked before completion." }))),
	risks: Type.Optional(Type.Array(Type.String({ description: "Known gap, blocker, or residual risk." }))),
	completionNote: Type.Optional(Type.String({ description: "Short note explaining why the goal is complete." })),
});

const GoalStatusParams = Type.Object({
	includeDetails: Type.Optional(Type.Boolean({ default: true })),
});

function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function nowIso(): string {
	return new Date().toISOString();
}

function compactText(value: string, max = 140): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 3)}...` : collapsed;
}

function normalizeList(values: string[] | undefined, fallback: string[] = []): string[] {
	if (!values) return [...fallback];
	return values.map((value) => value.trim()).filter(Boolean);
}

function createGoal(input: GoalManageParamsType): GoalState {
	const objective = input.objective?.trim();
	if (!objective) throw new Error("objective is required for create");
	const timestamp = nowIso();
	return {
		id: createGoalId(timestamp, objective),
		objective,
		status: "active",
		criteria: normalizeList(input.criteria),
		constraints: normalizeList(input.constraints),
		nextAction: typeof input.nextAction === "string" && input.nextAction.trim() ? input.nextAction.trim() : undefined,
		evidence: normalizeList(input.evidence),
		risks: normalizeList(input.risks),
		createdAt: timestamp,
		updatedAt: timestamp,
		turnsActive: 0,
	};
}

function createGoalId(timestamp: string, objective: string): string {
	let hash = 0;
	for (const char of `${timestamp}\0${objective}`) {
		hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
	}
	return Math.abs(hash).toString(36).slice(0, 8).padStart(4, "0");
}

function readState(path: string | undefined): GoalState | undefined {
	if (!path || !existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return normalizeState(parsed);
}

function writeState(path: string | undefined, state: GoalState | undefined): void {
	if (!path) return;
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, state ? `${JSON.stringify(state, null, 2)}\n` : "{}\n", "utf8");
	renameSync(tempPath, path);
}

function normalizeState(value: unknown): GoalState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.objective !== "string" || !raw.objective.trim()) return undefined;
	if (!isGoalStatus(raw.status)) return undefined;
	const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
	const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : createGoalId(createdAt, raw.objective),
		objective: raw.objective.trim(),
		status: raw.status,
		criteria: normalizeList(Array.isArray(raw.criteria) ? raw.criteria.filter(isString) : []),
		constraints: normalizeList(Array.isArray(raw.constraints) ? raw.constraints.filter(isString) : []),
		nextAction: typeof raw.nextAction === "string" && raw.nextAction.trim() ? raw.nextAction.trim() : undefined,
		evidence: normalizeList(Array.isArray(raw.evidence) ? raw.evidence.filter(isString) : []),
		risks: normalizeList(Array.isArray(raw.risks) ? raw.risks.filter(isString) : []),
		createdAt,
		updatedAt,
		completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
		completionNote: typeof raw.completionNote === "string" ? raw.completionNote : undefined,
		turnsActive: typeof raw.turnsActive === "number" && Number.isFinite(raw.turnsActive) ? raw.turnsActive : 0,
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "completed";
}

function summarizeGoal(goal: GoalState | undefined, includeDetails = true): string {
	if (!goal) return "No goal is set.";
	const lines = [
		`Goal #${goal.id} [${goal.status}]: ${goal.objective}`,
		`Created: ${goal.createdAt}${goal.completedAt ? `; completed: ${goal.completedAt}` : ""}`,
		`Active turns: ${goal.turnsActive}`,
	];
	if (!includeDetails) return lines.join("\n");
	if (goal.criteria.length) lines.push(`Criteria:\n${formatList(goal.criteria)}`);
	if (goal.constraints.length) lines.push(`Constraints:\n${formatList(goal.constraints)}`);
	if (goal.nextAction) lines.push(`Next action: ${goal.nextAction}`);
	if (goal.evidence.length) lines.push(`Evidence:\n${formatList(goal.evidence)}`);
	if (goal.risks.length) lines.push(`Risks:\n${formatList(goal.risks)}`);
	if (goal.completionNote) lines.push(`Completion note: ${goal.completionNote}`);
	return lines.join("\n");
}

function formatList(values: string[]): string {
	return values.slice(0, MAX_LIST_ITEMS).map((value) => `- ${value}`).join("\n");
}

function applyUpdate(goal: GoalState, input: GoalManageParamsType): GoalState {
	const next: GoalState = { ...goal };
	if (typeof input.objective === "string" && input.objective.trim()) next.objective = input.objective.trim();
	if (input.criteria) next.criteria = normalizeList(input.criteria);
	if (input.constraints) next.constraints = normalizeList(input.constraints);
	if (input.nextAction === null) delete next.nextAction;
	else if (typeof input.nextAction === "string") next.nextAction = input.nextAction.trim() || undefined;
	if (input.evidence) next.evidence = normalizeList(input.evidence);
	if (input.risks) next.risks = normalizeList(input.risks);
	next.updatedAt = nowIso();
	return next;
}

function buildReminder(goal: GoalState | undefined): string | undefined {
	if (!goal || goal.status !== "active") return undefined;
	const parts = [
		`Active goal: ${goal.objective}`,
	];
	if (goal.criteria.length) parts.push(`Done when: ${goal.criteria.slice(0, 3).join("; ")}`);
	if (goal.constraints.length) parts.push(`Constraints: ${goal.constraints.slice(0, 3).join("; ")}`);
	if (goal.nextAction) parts.push(`Next: ${goal.nextAction}`);
	parts.push("Before finalizing, verify each explicit requirement against concrete evidence, then use goal_manage action complete with evidence or risks.");
	return compactText(parts.join(" "), MAX_REMINDER_CHARS);
}

function goalReminderIntent(text: string): ReminderIntent {
	return {
		source: SOURCE,
		id: REMINDER_ID,
		label: "Goal",
		priority: 30,
		ttl: "persistent",
		repeatEveryTurns: DEFAULT_REPEAT_TURNS,
		display: false,
		text,
	};
}

function goalReminderRemoveRequest(): ReminderRemoveRequest {
	return {
		source: SOURCE,
		id: REMINDER_ID,
	};
}

export default function goalsExtension(pi: ExtensionAPI): void {
	let state: GoalState | undefined;
	let statePath: string | undefined;
	let ready = false;

	function resolveCwd(ctx?: ExtensionContext): string {
		return ctx?.cwd ?? process.env.PWD ?? process.cwd();
	}

	function resolveStatePath(ctx?: ExtensionContext): string | undefined {
		const env = process.env.PI_GOALS?.trim();
		if (env === "off") return undefined;
		const cwd = resolveCwd(ctx);
		if (env?.startsWith("/")) return env;
		if (env?.startsWith(".")) return resolve(cwd, env);
		if (env) return join(process.env.HOME ?? cwd, ".pi", "goals", `${env}.json`);
		const sessionId = ctx?.sessionManager.getSessionId?.() ?? "session";
		return join(cwd, ".pi", "goals", `goal-${sessionId}.json`);
	}

	function ensureState(ctx?: ExtensionContext): void {
		if (ready) return;
		statePath = resolveStatePath(ctx);
		try {
			state = readState(statePath);
		} catch (error) {
			console.warn(`[pi-goals] Failed to read goal state: ${error instanceof Error ? error.message : String(error)}`);
			state = undefined;
		}
		ready = true;
	}

	function persist(ctx?: ExtensionContext, event?: string): void {
		try {
			writeState(statePath, state);
		} catch (error) {
			console.warn(`[pi-goals] Failed to write goal state: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (event) {
			pi.appendEntry(CUSTOM_TYPE, {
				event,
				goal: state,
				recordedAt: nowIso(),
			});
		}
		refreshUi(ctx);
		refreshReminder(ctx);
	}

	function refreshUi(ctx?: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		if (!state) {
			ctx.ui.setStatus("goals", undefined);
			return;
		}
		ctx.ui.setStatus("goals", `goal ${state.status}: ${compactText(state.objective, 40)}`);
	}

	function refreshReminder(ctx?: ExtensionContext): void {
		const reminder = buildReminder(state);
		if (reminder) {
			pi.events.emit(REMINDER_UPSERT_EVENT, goalReminderIntent(reminder));
		} else {
			pi.events.emit(REMINDER_REMOVE_EVENT, goalReminderRemoveRequest());
		}
	}

	function mutate(ctx: ExtensionContext, input: GoalManageParamsType): string {
		ensureState(ctx);
		if (input.action === "create") {
			state = createGoal(input);
			persist(ctx, "created");
			return `Created goal #${state.id}: ${state.objective}`;
		}
		if (input.action === "clear") {
			const previous = state;
			state = undefined;
			persist(ctx, "cleared");
			return previous ? `Cleared goal #${previous.id}.` : "No goal was set.";
		}
		if (!state) throw new Error("No goal is set.");
		if (input.action === "update") {
			state = applyUpdate(state, input);
			persist(ctx, "updated");
			return `Updated goal #${state.id}.`;
		}
		if (input.action === "pause") {
			state = { ...state, status: "paused", updatedAt: nowIso() };
			persist(ctx, "paused");
			return `Paused goal #${state.id}.`;
		}
		if (input.action === "resume") {
			state = { ...state, status: "active", updatedAt: nowIso() };
			persist(ctx, "resumed");
			return `Resumed goal #${state.id}.`;
		}
		if (input.action === "complete") {
			state = applyUpdate(state, input);
			state.status = "completed";
			state.completedAt = nowIso();
			state.completionNote = input.completionNote?.trim() || state.completionNote;
			state.updatedAt = state.completedAt;
			persist(ctx, "completed");
			return `Completed goal #${state.id}.`;
		}
		throw new Error(`Unsupported action: ${input.action}`);
	}

	pi.on("session_start", (_event, ctx) => {
		ready = false;
		ensureState(ctx);
		refreshUi(ctx);
		refreshReminder(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		ensureState(ctx);
		if (state?.status === "active") {
			state = { ...state, turnsActive: state.turnsActive + 1, updatedAt: nowIso() };
			persist(ctx);
		} else {
			refreshUi(ctx);
			refreshReminder(ctx);
		}
	});

	pi.registerTool({
		name: "goal_manage",
		label: "Goal Manage",
		description: "Manage Pi's single standalone active goal. Use for durable objective tracking, pause/resume, completion evidence, and goal status. Do not use as a task list.",
		promptSnippet: "Manage the active goal",
		promptGuidelines: [
			"Use goal_manage for a durable user-level objective, not for step-by-step todos.",
			"Keep exactly one active goal unless the user explicitly clears or replaces it.",
			"Do not wire this to task_manage or use task IDs here; this goal layer is standalone.",
			"Criteria should be observable checks or deliverables. Constraints should capture scope boundaries and non-goals.",
			"Before action:'complete', audit the original user request against concrete evidence. Include evidence and any residual risks.",
			"Use action:'pause' when the user interrupts or work cannot continue; use action:'resume' when continuing the same goal.",
		],
		parameters: GoalManageParams,
		async execute(_toolCallId, params: GoalManageParamsType, _signal, _onUpdate, ctx) {
			const text = mutate(ctx, params);
			return textResult(`${text}\n\n${summarizeGoal(state)}`, { goal: state });
		},
	});

	pi.registerTool({
		name: "goal_status",
		label: "Goal Status",
		description: "Show Pi's current standalone goal, completion criteria, next action, evidence, and risks.",
		promptSnippet: "Show current goal",
		promptGuidelines: ["Use when resuming, before finalizing, or when checking whether a durable goal exists."],
		parameters: GoalStatusParams,
		async execute(_toolCallId, params: { includeDetails?: boolean }, _signal, _onUpdate, ctx) {
			ensureState(ctx);
			return textResult(summarizeGoal(state, params.includeDetails ?? true), { goal: state });
		},
	});

	pi.registerCommand("goal", {
		description: "Manage the standalone active goal: /goal [status|pause|resume|complete|clear|next <text>|set <objective>|<objective>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ensureState(ctx);
			const trimmed = args.trim();
			if (!trimmed) return openGoalPanel(ctx);

			const [command, ...rest] = trimmed.split(/\s+/);
			const value = rest.join(" ").trim();
			if (command === "status") return ctx.ui.notify(summarizeGoal(state), "info");
			if (command === "pause") return ctx.ui.notify(mutate(ctx, { action: "pause" }), "info");
			if (command === "resume") return ctx.ui.notify(mutate(ctx, { action: "resume" }), "info");
			if (command === "clear") return ctx.ui.notify(mutate(ctx, { action: "clear" }), "info");
			if (command === "complete") return ctx.ui.notify(mutate(ctx, { action: "complete", completionNote: value || undefined }), "success");
			if (command === "next") return ctx.ui.notify(mutate(ctx, { action: "update", nextAction: value || null }), "info");
			const objective = command === "set" ? value : trimmed;
			if (!objective) return ctx.ui.notify("Usage: /goal set <objective>", "warning");
			return ctx.ui.notify(mutate(ctx, { action: "create", objective }), "success");
		},
	});

	async function openGoalPanel(ctx: ExtensionCommandContext): Promise<void> {
		const rows = [
			state ? "View goal" : "Create goal",
			...(state ? ["Set next action", state.status === "active" ? "Pause goal" : "Resume goal", "Complete goal", "Clear goal"] : []),
		];
		const choice = await ctx.ui.select("Goal", rows);
		if (!choice) return;
		if (choice === "View goal") {
			await ctx.ui.select(summarizeGoal(state), ["Back"]);
			return openGoalPanel(ctx);
		}
		if (choice === "Create goal") {
			const objective = await ctx.ui.input("Goal objective");
			if (!objective?.trim()) return;
			ctx.ui.notify(mutate(ctx, { action: "create", objective }), "success");
			return;
		}
		if (choice === "Set next action") {
			const nextAction = await ctx.ui.input("Next action", state?.nextAction ?? "");
			ctx.ui.notify(mutate(ctx, { action: "update", nextAction: nextAction?.trim() || null }), "info");
			return;
		}
		if (choice === "Pause goal") {
			ctx.ui.notify(mutate(ctx, { action: "pause" }), "info");
			return;
		}
		if (choice === "Resume goal") {
			ctx.ui.notify(mutate(ctx, { action: "resume" }), "info");
			return;
		}
		if (choice === "Complete goal") {
			const note = await ctx.ui.input("Completion note");
			ctx.ui.notify(mutate(ctx, { action: "complete", completionNote: note?.trim() || undefined }), "success");
			return;
		}
		if (choice === "Clear goal") {
			const confirmed = await ctx.ui.confirm("Clear goal?", "This clears the current goal state for this session.");
			if (confirmed) ctx.ui.notify(mutate(ctx, { action: "clear" }), "info");
		}
	}
}
