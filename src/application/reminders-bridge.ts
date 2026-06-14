import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMINDER_REMOVE_EVENT, REMINDER_UPSERT_EVENT, type ReminderIntent, type ReminderRemoveRequest } from "pi-extension-utils";
import { charterDir, loadCharterState, loadParsedCharter } from "../infrastructure/store";
import { computeDrift } from "./drift-service";
import { loadCriterionState } from "./record-service";

const CHARTER_REMINDER_REPEAT_TURNS = 8;
const CHARTER_REMINDER_SOURCE = "pi-charter";

interface EventEmitterLike {
  events: {
    emit(channel: string, payload: unknown): void;
  };
}

export function registerCharterRemindersBridge(pi: ExtensionAPI): void {
  // The bridge is intentionally event-bus-only. pi-reminders may be absent;
  // emitting reminder events with no subscribers is a safe no-op.
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
  if (state.status === "completed" || state.status === "abandoned") {
    removeCharterReminder(pi, charterId);
    return;
  }
  const charter = await loadParsedCharter(dir);
  const criterionState = await loadCriterionState(dir, charterId);
  const passCount = charter.criteria.filter((criterion) => criterionState.criteria[criterion.id]?.outcome === "pass").length;
  const totalCount = charter.criteria.length;
  const displayName = state.name ?? state.charterId.slice(0, 8);
  const next = computeActiveNext(state.status, await computeDrift(projectDir, { charterId }));
  const guidance = state.status === "paused"
      ? "Charter is paused; resume before recording evidence."
      : "Prefer `subagent({async:true, ...})` for implementation and review verification whenever the next step does not need the child's output — async returns immediately so main can keep reading, editing, spawning more work, or handing control back to the user while the child runs. Sync subagent calls block main entirely until the child finishes (no reads, edits, or messages in between); use them only when the next move genuinely depends on the result. Record evidence in batches via `charter_record action=evidence { entries: [...] }`. `charterId` defaults to the bound charter — omit it. Use your own subagents for review; pi-charter ships no bundled personas.";

  const intent: ReminderIntent = {
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
  };
  pi.events.emit(REMINDER_UPSERT_EVENT, intent);
}

function computeActiveNext(
  status: string,
  drift: { readyNext: Array<{ criterionId: string; milestoneId?: string }> },
): string {
  if (status === "paused") return "charter action=resume";
  const next = drift.readyNext[0];
  if (!next) return "charter_status nextActions";
  return next.milestoneId ? `${next.criterionId} (${next.milestoneId})` : next.criterionId;
}

export function removeCharterReminder(pi: EventEmitterLike, charterId: string): void {
  const request: ReminderRemoveRequest = {
    id: reminderId(charterId),
    source: CHARTER_REMINDER_SOURCE,
  };
  pi.events.emit(REMINDER_REMOVE_EVENT, request);
}

function reminderId(charterId: string): string {
  return `${CHARTER_REMINDER_SOURCE}:${charterId}`;
}
