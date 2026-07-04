export type CharterHookEvent = "charter:before_complete" | "charter:before_abandon";

export interface HookPayloadBase {
  charterId: string;
  ts: string;
}

export interface BeforeCompletePayload extends HookPayloadBase {
  type: "charter:before_complete";
  criteriaCount: number;
  completionNote?: string;
}

export interface BeforeAbandonPayload extends HookPayloadBase {
  type: "charter:before_abandon";
  reason: string;
}

export type HookPayload = BeforeCompletePayload | BeforeAbandonPayload;
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
  if (!set) return;
  for (const handler of set) {
    const result = await handler(payload);
    if (result.decision === "block") throw new Error(`${event} blocked: ${result.reason}`);
  }
}
