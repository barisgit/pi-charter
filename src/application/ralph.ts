import type { CharterStatusResult } from "./service";
import type { RalphGuardState } from "../domain/types";
import { appendEvent, charterDir, chartersRoot, loadCharterState, withCharterLock, writeCharterState } from "../infrastructure/store";

const WINDOW_MS = 15 * 60_000;
const RECOVERY_WINDOW_MS = 5 * 60_000;

/** Candidate transition; persist it only when the message is actually sent. */
export function nextRalphActivation(guard: RalphGuardState | undefined, at: number): {
  kind: "normal" | "recovery" | "pause";
  state: RalphGuardState;
} {
  const activations = (guard?.activations ?? []).filter((time) => time >= at - WINDOW_MS);
  if (guard?.warnedAt !== undefined && at <= guard.warnedAt + RECOVERY_WINDOW_MS) {
    return { kind: "pause", state: { activations, warnedAt: guard.warnedAt, pausedByGuard: true } };
  }
  const recovery = activations.length >= 4;
  return {
    kind: recovery ? "recovery" : "normal",
    state: { activations: [...activations, at], ...(recovery ? { warnedAt: at } : {}) },
  };
}

export const RALPH_GUARD_PAUSE_NOTE = "Ralph paused: another automatic activation was requested within five minutes of the recovery prompt. Review the loop, then use /charter resume to continue.";

/** Serialize the eligibility check, actual send and guard update with lifecycle mutations. */
export async function attemptRalphActivation(input: {
  projectDir: string;
  charterId: string;
  sessionId?: string;
  at: number;
  isEligible: () => boolean;
  send: (kind: "normal" | "recovery") => void;
}): Promise<"normal" | "recovery" | "pause" | "skipped"> {
  return withCharterLock(chartersRoot(input.projectDir), async () => {
    const dir = charterDir(input.projectDir, input.charterId);
    const state = await loadCharterState(dir);
    if (state.schemaVersion !== "phases" || state.status !== "active" || state.sessionId !== input.sessionId || !input.isEligible()) return "skipped";
    const next = nextRalphActivation(state.ralph, input.at);
    if (next.kind === "pause") {
      state.previousStatus = state.status;
      state.status = "paused";
    } else {
      input.send(next.kind);
    }
    state.ralph = next.state;
    await writeCharterState(dir, state);
    await appendEvent(dir, {
      type: next.kind === "pause" ? "charter_paused" : "ralph_activated",
      ts: new Date(input.at).toISOString(),
      charterId: input.charterId,
      ...(next.kind === "pause" ? { note: RALPH_GUARD_PAUSE_NOTE, reason: "ralph-guard" } : { kind: next.kind }),
    });
    return next.kind;
  });
}

/** Charter fields the Ralph continuation restates; the Objective, references and scope are passed through verbatim. */
export type RalphPromptInput = Pick<CharterStatusResult, "charterId" | "objective" | "references" | "scope">;

const RALPH_RECOVERY = "Ralph has sent five continuations in fifteen minutes; another within five minutes pauses the charter. If you are repeating checks or waiting with nothing running, do something different or pause and say what blocks you.";

const RALPH_CONTINUATION = "Take the next useful step toward the Objective; if a job is already running, check on it instead of starting another. When the Objective is satisfied, complete the charter with a concise note. If you are blocked, pause and say why.";

/** Render the model-facing continuation; `recovery` adds the guard warning sent on the fifth activation. */
export function renderRalphPrompt(status: RalphPromptInput, recovery = false): string {
  return [
    `Continue the charter at .charters/${status.charterId}/charter.md.`,
    `Objective:\n${status.objective}`,
    status.references ? `References:\n${status.references}` : "",
    status.scope ? `Scope:\n${status.scope}` : "",
    recovery ? RALPH_RECOVERY : "",
    RALPH_CONTINUATION,
  ].filter(Boolean).join("\n\n");
}
