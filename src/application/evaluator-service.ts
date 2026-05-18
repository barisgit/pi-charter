/**
 * Charter evaluator: post-turn reasoner that folds intent-sentinel into a
 * charter-aware loop.
 *
 * The evaluator runs after every turn (host wires it on `turn_end`). It loads
 * the active charter's charter.md, current criterion-state, and drift views,
 * asks a cheap separate model for a verdict, and:
 *
 *   - appends the verdict to `evaluator-log.jsonl` (last 10 retained at read time);
 *   - returns a steer reminder text that the host injects on the NEXT turn.
 *
 * The evaluator NEVER gates completion. The completion gate is in
 * `completeCharter`; the evaluator only nudges the agent toward fresh
 * evidence, ready-next features, and uncovered criteria.
 *
 * This file is the pure service. Hook wiring lives in `registration.ts`.
 * The actual model call is injected so the test suite can use a fake.
 */

import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { charterDir, loadCharterState, withCharterLock, writeTextAtomic } from "../infrastructure/store";
import { loadCriterionState } from "./record-service";
import { computeDrift } from "./drift-service";
import { listUnreviewedMilestones, type UnreviewedMilestone } from "./service";

export type EvaluatorVerdict = "on_track" | "drifting" | "blocked" | "ready_to_complete" | "unclear";

export interface EvaluatorAssessment {
  verdict: EvaluatorVerdict;
  confidence: number; // 0..1
  reason: string;
  steerReminder?: string;
  cites: { criterionId?: string; featureId?: string }[];
}

export interface EvaluatorEntry extends EvaluatorAssessment {
  ts: string;
  charterId: string;
  trigger: "turn_end" | "manual";
}

export interface EvaluatorContext {
  charterId: string;
  objective: string;
  status: string;
  criteria: { id: string; title: string; outcome?: string; lastTs?: string }[];
  featureCount: number;
  drift: {
    uncovered: { criterionId: string; reason: string }[];
    stuck: { featureId: string }[];
    stale: { criterionId: string; ageMs: number }[];
    readyNext: { featureId: string; fulfills: string[] }[];
  };
  /**
   * Milestones with an unreviewed `milestone_ready_for_review` event. The
   * evaluator must cite these in its steer text; the renderer enforces a
   * deterministic `(milestone: <id>)` suffix if the LLM omits the id.
   */
  unreviewedMilestones: UnreviewedMilestone[];
  recentUserMessages: string[];
  recentToolNames: string[];
}

export interface EvaluatorModelInput {
  context: EvaluatorContext;
  prompt: string;
}

export type EvaluatorModelFn = (input: EvaluatorModelInput) => Promise<EvaluatorAssessment>;

const HISTORY_LIMIT = 10;
const LOG_FILENAME = "evaluator-log.jsonl";

export async function buildEvaluatorContext(
  projectDir: string,
  charterId: string,
  options: { recentUserMessages?: string[]; recentToolNames?: string[] } = {},
): Promise<EvaluatorContext> {
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterionState = await loadCriterionState(dir, charterId);
  const drift = await computeDrift(projectDir, { charterId });
  const featureCount = await countPlanFeatureFiles(join(dir, "plan"));
  const unreviewedMilestones = await listUnreviewedMilestones(dir);
  return {
    charterId,
    objective: state.objective,
    status: state.status,
    criteria: charter.criteria.map((c) => ({
      id: c.id,
      title: c.title,
      outcome: criterionState.criteria[c.id]?.outcome,
      lastTs: criterionState.criteria[c.id]?.lastTs,
    })),
    featureCount,
    drift: {
      uncovered: drift.uncovered,
      stuck: drift.stuck.map((s) => ({ featureId: s.featureId })),
      stale: drift.stale.map((s) => ({ criterionId: s.criterionId, ageMs: s.ageMs })),
      readyNext: drift.readyNext,
    },
    unreviewedMilestones,
    recentUserMessages: options.recentUserMessages ?? [],
    recentToolNames: options.recentToolNames ?? [],
  };
}

export function buildEvaluatorPrompt(context: EvaluatorContext): string {
  const unreviewedIds = context.unreviewedMilestones.map((entry) => entry.milestoneId);
  return [
    "You supervise a coding agent working under a durable charter.",
    "Decide whether the agent is on track toward the charter objective.",
    "",
    "Return strict JSON matching this schema:",
    '{ "verdict": "on_track"|"drifting"|"blocked"|"ready_to_complete"|"unclear",',
    '  "confidence": 0..1,',
    '  "reason": "one sentence citing a criterionId or featureId when possible",',
    '  "steerReminder": "<=300 chars actionable nudge for the next turn, or empty",',
    '  "cites": [ { "criterionId"?: "VAL-...", "featureId"?: "..." } ] }',
    "",
    "Hard rules:",
    "- Never claim the charter is done. completion is gated by VAL-* pass evidence elsewhere.",
    "- If `ready_to_complete`, only suggest calling charter_manage:complete; do not auto-complete.",
    "- Cite an id from `criteria[].id`, `drift.uncovered[].criterionId`, or `drift.readyNext[].featureId`.",
    "- If `unreviewedMilestones` is non-empty, the steerReminder MUST cite every milestoneId literally and recommend delegating to subagent({agent:'charter-verifier'}).",
    "- If nothing useful to say, return verdict=on_track with steerReminder empty.",
    "",
    "Charter:",
    JSON.stringify(
      {
        objective: context.objective,
        status: context.status,
        criteria: context.criteria,
        featureCount: context.featureCount,
        drift: context.drift,
        unreviewedMilestones: unreviewedIds,
        recentUserMessages: context.recentUserMessages.slice(-5),
        recentToolNames: context.recentToolNames.slice(-12),
      },
      null,
      2,
    ),
  ].join("\n");
}

export async function runEvaluator(
  projectDir: string,
  input: {
    charterId: string;
    trigger: "turn_end" | "manual";
    modelFn: EvaluatorModelFn;
    recentUserMessages?: string[];
    recentToolNames?: string[];
    now?: string;
  },
): Promise<EvaluatorEntry> {
  const context = await buildEvaluatorContext(projectDir, input.charterId, {
    recentUserMessages: input.recentUserMessages,
    recentToolNames: input.recentToolNames,
  });
  if (shouldSkipPlanningEvaluation(context)) {
    const entry: EvaluatorEntry = {
      ts: input.now ?? new Date().toISOString(),
      charterId: input.charterId,
      trigger: input.trigger,
      verdict: "on_track",
      confidence: 1,
      reason: planningSkipReason(context),
      cites: [],
    };
    await appendEvaluatorEntry(projectDir, input.charterId, entry);
    return entry;
  }
  const prompt = buildEvaluatorPrompt(context);
  const assessment = await input.modelFn({ context, prompt });
  const steerReminder = enforceMilestoneSteer(
    assessment.steerReminder?.trim() || undefined,
    context.unreviewedMilestones,
  );
  const entry: EvaluatorEntry = {
    ts: input.now ?? new Date().toISOString(),
    charterId: input.charterId,
    trigger: input.trigger,
    verdict: assessment.verdict,
    confidence: clampConfidence(assessment.confidence),
    reason: assessment.reason.trim() || "(no reason supplied)",
    steerReminder,
    cites: Array.isArray(assessment.cites) ? assessment.cites : [],
  };
  await appendEvaluatorEntry(projectDir, input.charterId, entry);
  return entry;
}

/**
 * Append a deterministic `(milestone: <id>)` suffix for every unreviewed
 * milestone whose id the LLM omitted. The post-condition is grep-testable:
 * for every unreviewed entry, the returned string contains the literal
 * milestoneId substring. Returns undefined only when there is nothing to say
 * (no steer and no unreviewed milestones).
 */
function enforceMilestoneSteer(
  steer: string | undefined,
  unreviewed: UnreviewedMilestone[],
): string | undefined {
  if (unreviewed.length === 0) return steer;
  const missing = unreviewed
    .map((entry) => entry.milestoneId)
    .filter((id) => !(steer ?? "").includes(id));
  if (missing.length === 0) return steer;
  const suffix = missing.map((id) => `(milestone: ${id})`).join(" ");
  return steer && steer.length > 0 ? `${steer} ${suffix}` : suffix;
}

export async function readEvaluatorLog(
  projectDir: string,
  charterId: string,
): Promise<EvaluatorEntry[]> {
  const path = join(charterDir(projectDir, charterId), LOG_FILENAME);
  try {
    await stat(path);
  } catch {
    return [];
  }
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries: EvaluatorEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as EvaluatorEntry);
    } catch {
      // ignore malformed log lines
    }
  }
  return entries.slice(-HISTORY_LIMIT);
}

async function appendEvaluatorEntry(
  projectDir: string,
  charterId: string,
  entry: EvaluatorEntry,
): Promise<void> {
  const dir = charterDir(projectDir, charterId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOG_FILENAME);
  // Wrap the read + filter + write in a per-charter lock so concurrent
  // appendEvaluatorEntry callers cannot base their write on stale contents
  // and torn writes are avoided. The actual file replacement goes through
  // writeTextAtomic (tmp-rename) for atomicity on the file system level.
  await withCharterLock(dir, async () => {
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split(/\r?\n/).filter(Boolean);
    lines.push(JSON.stringify(entry));
    const kept = lines.slice(-HISTORY_LIMIT);
    await writeTextAtomic(path, `${kept.join("\n")}\n`);
  });
}

async function countPlanFeatureFiles(planDir: string): Promise<number> {
  try {
    const entries = await readdir(planDir);
    return entries.filter((entry) => entry.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function shouldSkipPlanningEvaluation(context: EvaluatorContext): boolean {
  if (context.status !== "planning") return false;
  if (context.criteria.length === 0) return true;
  const hasEvidence = context.criteria.some((criterion) => criterion.outcome !== undefined || criterion.lastTs !== undefined);
  return context.featureCount === 0 && !hasEvidence;
}

function planningSkipReason(context: EvaluatorContext): string {
  if (context.criteria.length === 0) return "Planning charter has no parsed criteria yet; skipping evaluator model.";
  return "Planning charter has criteria but no feature plan or evidence yet; skipping evaluator model.";
}

function clampConfidence(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Build a turn-start reminder text from the latest evaluator entry.
 * The host injects this verbatim as a system reminder on the next turn.
 * Returns undefined when the last verdict is on_track with no steer text.
 */
export function reminderFromEntry(entry: EvaluatorEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (!entry.steerReminder && entry.verdict === "on_track") return undefined;
  const lines = [
    `charter-evaluator (${entry.verdict}, confidence ${entry.confidence.toFixed(2)}):`,
    entry.reason,
  ];
  if (entry.steerReminder) lines.push(`Next turn: ${entry.steerReminder}`);
  if (entry.cites.length > 0) {
    const cites = entry.cites
      .map((c) => c.criterionId ?? c.featureId)
      .filter((v): v is string => Boolean(v));
    if (cites.length > 0) lines.push(`Cites: ${cites.join(", ")}`);
  }
  return lines.join("\n");
}
