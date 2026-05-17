import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { charterDir, loadCharterState } from "../infrastructure/store";
import { computeDrift } from "./drift-service";
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
  const charter = parseCharterMarkdown(await readFile(join(dir, "charter.md"), "utf8"));
  const criterionState = await loadCriterionState(dir, charterId);
  const drift = await computeDrift(projectDir, { charterId });
  const passCount = charter.criteria.filter((criterion) => criterionState.criteria[criterion.id]?.outcome === "pass").length;
  const totalCount = charter.criteria.length;
  const displayName = state.name ?? state.charterId.slice(0, 8);
  const next = state.status === "planning"
    ? "lock_plan after VAL criteria and features"
    : drift.readyNext[0]?.featureId ?? "charter_status nextActions";

  pi.events.emit(REMINDER_UPSERT_EVENT, {
    id: reminderId(charterId),
    source: CHARTER_REMINDER_SOURCE,
    label: "Charter",
    priority: 10,
    display: true,
    ttl: "persistent",
    repeatEveryTurns: CHARTER_REMINDER_REPEAT_TURNS,
    text: `${displayName} (${state.status}): ${passCount}/${totalCount} VAL pass. Next: ${next}. Use subagents for recon, implementation, and charter-verifier verification; update charter evidence and feature progress as each VAL passes.`,
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

export function removeCharterReminder(pi: EventEmitterLike, charterId: string): void {
  pi.events.emit(REMINDER_REMOVE_EVENT, {
    id: reminderId(charterId),
    source: CHARTER_REMINDER_SOURCE,
  });
}

function reminderId(charterId: string): string {
  return `${CHARTER_REMINDER_SOURCE}:${charterId}`;
}
