/**
 * pi-subagents bridge: local redeclaration of the one event constant
 * pi-charter consumes from the shared `pi.events` bus.
 *
 * We never import from pi-subagents directly; each side redeclares the
 * constants (pi-prune-router pattern). Source of truth:
 *   ~/Programming_local/Projects/pi-extensions/pi-subagents/types.ts
 *
 * `subagent:all-idle` fires when the main agent and every async child are
 * idle; it is the smart-Ralph reprompt trigger.
 */
export const SUBAGENT_ALL_IDLE_EVENT = "subagent:all-idle";
