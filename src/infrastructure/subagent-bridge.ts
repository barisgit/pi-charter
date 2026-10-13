/**
 * pi-subagents bridge: local redeclarations of the event constants
 * pi-charter consumes from the shared `pi.events` bus.
 *
 * We never import from pi-subagents directly; each side redeclares the
 * constants (pi-prune-router pattern). Source of truth:
 *   ~/Programming_local/Projects/pi-extensions/pi-subagents/src/protocol/types.ts
 *
 * `subagent:all-idle` fires when the main agent and every async child are
 * settled with no live async runs; it is the Ralph reprompt trigger.
 */
export const SUBAGENT_ALL_IDLE_EVENT = "subagent:all-idle";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_RUN_COMPLETE_EVENT = "subagent:async-run-complete";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_REQUEST_API_EVENT = "subagent:request-api";
export const SUBAGENT_EXPOSE_API_EVENT = "subagent:expose-api";
