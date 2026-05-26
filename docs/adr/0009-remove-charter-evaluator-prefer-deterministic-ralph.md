# Remove charter-evaluator, prefer deterministic Ralph

Status: accepted

## Decision

The bundled `charter-evaluator` LLM persona and its post-turn steer pathway are removed. Continuation is driven entirely by the deterministic Ralph reprompt service.

- Ralph keeps firing for non-terminal statuses; the skip set is unchanged: `completed | abandoned | paused | awaiting-clarification | budget_limited`. Ralph still fires in `active` and `review`.
- Ralph reprompts only when both the root agent and async subagents are idle. It does not compete with delegated work.
- Ralph never stops the charter on its own. There is no no-tool suppression and no idle cap; only the main agent transitions out of the loop via `charter_manage action=pause`, `abandon`, or `force_complete`.
- Reminders and Ralph reprompts are distinct surfaces: reminders inject status/doctrine into context anytime without starting a turn; Ralph starts a new turn when idle. Both render from current `charter_status` so they never carry stale state.

## Rationale

- `charter-evaluator` produced an LLM verdict (`on_track`, `drifting`, `blocked`, `done`) that the lifecycle never used as a gate. It steered the agent with prose while the deterministic status surface already carried sharper, computed information (drift, ready-next, missing evidence, completion blockers).
- The evaluator added latency, model cost, and a second judgement layer that could disagree with computed status, especially around `done`. Removing it eliminates that conflict and reduces moving parts.
- Ralph already delivers the only continuation behavior the charter actually needs: keep the agent moving on real status when idle, stop when the lifecycle says so. Making it the single continuation surface clarifies who is responsible for advancing the loop (the runtime renders, the agent acts).

## Consequences

- `charter-evaluator` persona files, prompts, configuration, and call sites are deleted as part of the charter that implements this ADR.
- `charter_status` continues to return drift and `nextActions[]`. Any prior consumer relying on a steer/verdict field reads it as removed.
- Persona usage (planner-critic, charter-reviewer, charter-qa, charter-readiness-probe, charter-verifier) is unchanged; those personas remain the human-shaped judgment surface.
- Stuck handling is doctrine-only (see ADR 0008): the skill instructs the agent to call `pause` / `abandon` when no legal next move exists.
