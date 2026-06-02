# Lifecycle

## Status FSM

Current runtime statuses are exactly `active`, `paused`, `completed`, and `abandoned`. Charters are created in `active`; there is no live planning, review, or budget-limited state.

```text
create
  -> active
active
  -> completed    completeCharter gates pass and charter:before_complete allows
  -> paused       pause from any non-terminal state
  -> abandoned    abandonCharter with reason and charter:before_abandon allows
paused
  -> active       resume
  -> abandoned    abandonCharter with reason and charter:before_abandon allows
completed         terminal
abandoned         terminal
```

Legacy persisted statuses (`planning`, `review`, `awaiting-clarification`, `budget_limited`) are read only for back-compat normalization. They are not live states and should not be emitted by new lifecycle logic.

## Spawn and create

Three entry points converge on the same create logic:

1. Agent calls `charter` with `action: "create"` and an `objective`.
2. User runs `/charter <objective>`.
3. Orchestrator launches Pi with `--charter-objective "<text>"` or `--charter-resume <id>`.

Specs are plain English context. If the prompt says "use `docs/spec.md`", the agent reads that file and authors or edits the charter files directly. pi-charter does not auto-detect, copy, or lock specs.

Creation resolves or creates `<project>/.pi/charters/<charterId>/`, writes `charter.md`, `criteria.md`, `state.json`, `criterion-state.json`, `events.jsonl`, and `work/`, updates `.pi/charters/index.json`, and binds the current session when available. The authored contract is split: `charter.md` contains Objective, Scope and constraints, Mission Boundaries, and optional Commands; `criteria.md` contains the VAL register grouped under milestone headings.

## Active phase

At each turn or status check:

1. Read `charter_status` for current VAL totals, completion blockers, parse warnings, ready-next advisory, and legal `nextActions[]`.
2. Agent chooses one action:
   - author or repair `charter.md` / `criteria.md`;
   - implement work needed for one or more VALs;
   - run checks and record the output as evidence;
   - delegate review or verification to user-owned subagents when useful, then record their output as evidence;
   - pause;
   - ask the user directly if blocked.
3. Evidence is appended through `charter_record` with `action: "evidence"`; it updates `criterion-state.json` and stores flat evidence JSON under `work/<feature-or-_charter>/evidence/<stamp>/`.
4. When every in-scope VAL has pass evidence and the completion gates pass, the agent calls `charter` with `action: "complete"` directly. There is no transition to a review state.

`Verifier:` and `Command:` annotations in `criteria.md` are descriptive only. The agent or a chosen subagent runs checks; charter records evidence and never executes commands, runs verifier personas, or dispatches subagents itself. `requireReviewSubagent` is display-only provenance guidance, not a completion gate.

## Completion

Completion is a gated active-state transition, not a separate review phase. `completeCharter` only accepts an `active` charter, scaffolds `REPORT.md` on the first attempt if needed, then requires:

- every parsed in-scope VAL has latest pass evidence;
- `RequireFreshEvidence: true` VALs have pass evidence newer than the latest `src/` change;
- `REPORT.md` has non-empty content under every heading;
- manual evidence blockers are cleared by providing `because` on `source: manual` pass evidence;
- `charter:before_complete` subscribers allow the transition.

If any predicate fails, the tool returns `complete.gate_blocked` with `nextActions[]`; the charter remains `active` until the agent records more evidence, fills the report, or pauses/abandons.

## Terminal states

- `completed` records `completedAt` and optional `completionReason` in `state.json`, appends a `charter_completed` event, and leaves the session binding available for terminal widget display until the next session-start cleanup.
- `abandoned` requires a non-empty reason, runs `charter:before_abandon`, records the reason in `completionReason`, appends a `charter_abandoned` event, and leaves artifacts intact.

There is no `budget_limited` terminal state and no `result.json` artifact in the current workspace layout.

## Hooks and vestigial surfaces

Live decision-control hooks are `charter:before_complete` and `charter:before_abandon`. The `charter:before_lock_plan` hook type still exists in code for compatibility, but there is no live planning state, lock-plan action, or emitter in the current lifecycle. Likewise, exported `forceCompleteCharter` and `amendCharter` service symbols are unwired to any registered tool action and should not be documented as live lifecycle features.

## Ralph role

Ralph reprompts from current status when the root agent and async children are idle. It does not complete, pause, or abandon a charter; recorded evidence and the alignment gates decide terminal completion. The current `RalphCase` union contains only `active`, and paused/completed/abandoned charters are skipped.
