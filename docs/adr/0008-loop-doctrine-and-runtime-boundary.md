# Loop doctrine and runtime boundary

Status: accepted

## Decision

The pi-charter execution loop is owned by runtime code, not by Markdown. Markdown carries doctrine and persona behavior; code carries lifecycle, legal next actions, gates, reminders, and Ralph continuation.

Concretely:

- Code owns the lifecycle FSM, `nextActions[]`, evidence gates, drift views, Ralph idle reprompt, and reminders. These are not re-derivable from prose.
- Markdown (`charter.md`, persona prompts, `skills/pi-charter/SKILL.md`, future short doctrine snippets) carries judgment, coaching, and prompt contracts only. Markdown never names a legal transition.
- No new doctrine tree, no MD/TOML-defined transition graph, no frontmatter-driven stage interpreter, no second workflow language. Adding one duplicates the FSM and creates drift.

The persisted charter status set is unchanged: `planning | active | review | paused | awaiting-clarification | completed | budget_limited | abandoned`. Behavioral concepts the design discussion exposed — “orient / set checkpoint / execute / inspect / decide / next checkpoint / replan” — are not persisted statuses. They are advice rendered into `charter_status` and Ralph output for the agent inside `active`/`review`.

## Milestones and contracts

Milestones become first-class in status surfaces:

- `charter_status` groups features by milestone, shows VALs covered through `fulfills[]`, evidence state per VAL, and milestone-level QA/readiness debt.
- `nextActions[]` surfaces milestone-aware moves, e.g. “run milestone QA / readiness when all features in milestone M have implementation evidence but milestone-level QA/readiness evidence is missing”.

VALs remain the only contract. There is no separate `## Contract` section per milestone, no `userFacing` knob, and no other authored contract surface. Milestone outcomes are expressed as the VALs covered by that milestone’s features.

## Replan invariant

After `lock_plan`, the agent may refine internals via `charter_plan add_feature / update_feature` and amend milestone composition or ordering. Replan never weakens or removes Objective or VAL semantics. To change those, the agent must use `charter_manage action=amend_charter` and re-justify against planner-critic. This is the anchor that prevents incremental replanning from drifting away from the original outcome.

## Stuck handling

Ralph never stops the charter on its own (see ADR 0009). When the agent cannot find a legal next move, doctrine in `skills/pi-charter/SKILL.md` instructs it to call `charter_manage action=pause` (with a reason) or `abandon`/`force_complete`. No runtime cap, no no-tool suppression, no staleness counter in v1; if this proves insufficient in practice, revisit with a soft signal first.

## Rationale

- Existing tool outputs (`charter_status.nextActions[]`, drift views, completion gates) already work as a control surface. Strengthening them is higher leverage than authoring a new doctrine FSM.
- A Markdown-defined loop would need parsers, validators, and tests for transitions, and would drift relative to the TypeScript FSM. Two systems will disagree, and agents will trust prose over code.
- The locked plan + VALs already act as the durable contract surface. Reusing them avoids inventing duplicate concepts (`checkpoint`, `stage`, `contract`).
- Keeping the runtime boring lets new models improve the prose and persona behavior without changing code; it also lets us delete machinery cleanly when models get better.

## Out of scope

These are explicitly excluded from this decision and from any near-term charter executing on it:

- New persisted statuses, persisted checkpoint state, or any per-charter cursor pointer.
- Any doctrine tree at `doctrine/` or equivalent.
- TOML/JSON/YAML transition graphs and stage frontmatter parsing.
- New authored knobs in `charter.md` such as `userFacing`.
- Mission control / auto-spawn scheduler / worker pool.
- Cross-project mission dashboard.
