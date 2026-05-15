/**
 * Charter hook bus. Minimal in-process registry that lets subscribers veto
 * charter state transitions (charter:before_lock_plan, charter:before_complete,
 * charter:before_amend_charter, charter:before_force_complete).
 *
 * Subscribers return `{decision: 'block', reason}` to block the transition or
 * `{decision: 'allow'}` to pass through. The host agent decides whether to
 * surface a TUI approver, run an external verifier, etc.
 */

export type CharterHookEvent =
  | "charter:before_lock_plan"
  | "charter:before_complete"
  | "charter:before_amend_charter"
  | "charter:before_force_complete";

export interface HookPayloadBase {
  charterId: string;
  ts: string;
}

export interface BeforeLockPlanPayload extends HookPayloadBase {
  type: "charter:before_lock_plan";
  planDigest: string;
  featureCount: number;
}

export interface BeforeCompletePayload extends HookPayloadBase {
  type: "charter:before_complete";
  criteriaCount: number;
  completionNote?: string;
}

export interface BeforeAmendCharterPayload extends HookPayloadBase {
  type: "charter:before_amend_charter";
  target: "planning" | "review";
  reason: string;
}

export interface BeforeForceCompletePayload extends HookPayloadBase {
  type: "charter:before_force_complete";
  target: "completed" | "abandoned" | "budget_limited";
  reason: string;
}

export type HookPayload =
  | BeforeLockPlanPayload
  | BeforeCompletePayload
  | BeforeAmendCharterPayload
  | BeforeForceCompletePayload;

export type HookDecision = { decision: "allow" } | { decision: "block"; reason: string };

export type HookSubscriber<P extends HookPayload = HookPayload> = (
  payload: P,
) => HookDecision | Promise<HookDecision>;

const subscribers = new Map<CharterHookEvent, Set<HookSubscriber>>();

export function subscribeHook<P extends HookPayload>(
  event: P["type"],
  handler: HookSubscriber<P>,
): () => void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
  }
  const wrapped = handler as HookSubscriber;
  set.add(wrapped);
  return () => set!.delete(wrapped);
}

export function clearHookSubscribers(event?: CharterHookEvent): void {
  if (event) subscribers.delete(event);
  else subscribers.clear();
}

export async function dispatchHook<P extends HookPayload>(
  event: P["type"],
  payload: P,
): Promise<void> {
  const set = subscribers.get(event);
  if (!set || set.size === 0) return;
  for (const handler of set) {
    const result = await handler(payload);
    if (result.decision === "block") {
      throw new Error(`${event} blocked: ${result.reason}`);
    }
  }
}
