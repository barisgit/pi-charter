import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { charterDir, loadCharterState, loadParsedCharter } from "../infrastructure/store";
import { computeDrift } from "./drift-service";
import { viewPlan } from "./plan-service";
import { loadCriterionState } from "./record-service";

const CHARTER_REMINDER_REPEAT_TURNS = 8;
const CHARTER_REMINDER_SOURCE = "pi-charter";
const REMINDER_UPSERT_EVENT = "reminder:upsert";
const REMINDER_REMOVE_EVENT = "reminder:remove";

interface EventEmitterLike {
  events: {
    emit(channel: string, payload: unknown): void;
  };
}

export function registerCharterRemindersBridge(pi: ExtensionAPI): void {
  // The bridge is intentionally event-bus-only. pi-reminders may be absent;
  // emitting reminder:* events with no subscribers is a safe no-op.
  void pi;
}

export async function upsertCharterReminder(
  pi: EventEmitterLike,
  projectDir: string,
  charterId: string,
): Promise<void> {
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  // Defense in depth: terminal charters should never carry an active reminder.
  // If an upsert path slips past trySyncCharterReminder, convert it to a remove.
  if (state.status === "completed" || state.status === "abandoned" || state.status === "budget_limited") {
    removeCharterReminder(pi, charterId);
    return;
  }
  const charter = await loadParsedCharter(dir);
  const criterionState = await loadCriterionState(dir, charterId);
  const passCount = charter.criteria.filter((criterion) => criterionState.criteria[criterion.id]?.outcome === "pass").length;
  const totalCount = charter.criteria.length;
  const displayName = state.name ?? state.charterId.slice(0, 8);
  const next = state.status === "planning"
    ? await computePlanningNext(projectDir, charterId, charter.criteria.length)
    : computeActiveNext(state.status, await computeDrift(projectDir, { charterId }));
  const guidance = state.status === "planning"
    ? "Author criteria.md then add features in one batch call (`charter_plan action=add_feature { features: [...] }`); do not start implementation until lock_plan succeeds. Bundled charter personas are hidden from `subagent action=list` but invocable by name (`subagent({agent:'charter-planner-critic',...})`); see `skills/pi-charter/SKILL.md`."
    : state.status === "paused"
      ? "Charter is paused; resume before recording evidence."
      : "Prefer async subagents (`subagent({async:true, ...})`) for implementation and charter-reviewer verification — main stays free for user fixes while the charter progresses itself. Use sync subagents only when the next step depends on the result. Record evidence in batches via `charter_record action=evidence { entries: [...] }`. `charterId` defaults to the bound charter — omit it. Bundled charter personas are hidden from `subagent action=list` but invocable by name; see `skills/pi-charter/SKILL.md`.";

  pi.events.emit(REMINDER_UPSERT_EVENT, {
    id: reminderId(charterId),
    source: CHARTER_REMINDER_SOURCE,
    label: "Charter",
    priority: 10,
    display: true,
    ttl: "persistent",
    repeatEveryTurns: CHARTER_REMINDER_REPEAT_TURNS,
    text: `${displayName} (${state.status}): ${passCount}/${totalCount} VAL pass. Next: ${next}. ${guidance}`,
    metadata: {
      charterId,
      projectDir,
      status: state.status,
      passCount,
      totalCount,
      next,
    },
  });
}

async function computePlanningNext(
  projectDir: string,
  charterId: string,
  criterionCount: number,
): Promise<string> {
  if (criterionCount === 0) return "author criteria.md VAL-* criteria";
  // viewPlan.drift.uncovered = VAL ids with no feature fulfilling them, which is
  // the right signal during planning. computeDrift.uncovered is evidence-based
  // and is always full during planning (no evidence yet).
  const plan = await viewPlan(projectDir, { charterId });
  if (plan.features.length === 0) return "add features that fulfill VAL-* criteria";
  if (plan.drift.uncovered.length > 0) {
    const ids = plan.drift.uncovered.slice(0, 3).map((c) => c.id).join(", ");
    const more = plan.drift.uncovered.length > 3 ? `, +${plan.drift.uncovered.length - 3} more` : "";
    return `cover uncovered VAL(s): ${ids}${more}`;
  }
  return "charter_plan action=lock_plan";
}

function computeActiveNext(
  status: string,
  drift: { readyNext: Array<{ featureId: string }> },
): string {
  if (status === "paused") return "charter_manage action=resume";
  if (status === "review") return "charter_manage action=complete after charter-reviewer review";
  return drift.readyNext[0]?.featureId ?? "charter_status nextActions";
}

export function removeCharterReminder(pi: EventEmitterLike, charterId: string): void {
  pi.events.emit(REMINDER_REMOVE_EVENT, {
    id: reminderId(charterId),
    source: CHARTER_REMINDER_SOURCE,
  });
}

function reminderId(charterId: string): string {
  return `${CHARTER_REMINDER_SOURCE}:${charterId}`;
}
