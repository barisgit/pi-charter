# Implementation plan

This is a pragmatic AI-assisted path, not a calendar estimate.

## M0 — scaffold and docs

Status: started.

- Create repo scaffold.
- Preserve v1 pi-goals reference.
- Copy research archive.
- Write CONTEXT.md and ADRs.
- Draft implementation docs.

## M1 — kernel and filesystem store

Definition of done:

- `CharterState` / `CharterStatus` types exist.
- `charter({action:'create'})` creates `<project>/.pi/charters/<uuid>/`.
- Atomic write helpers exist.
- `charter.md` template is written or detected.
- `state.json`, `events.jsonl`, and `index.json` update correctly.
- `charter_status` resolves by explicit id, session binding, or exactly-one active charter.

Lift from v1:

- temp-file + rename writes;
- lazy state load;
- TypeBox + StringEnum schemas;
- text result helper;
- slash command parsing pattern.

## M2 — criteria register (planning/plan sidecars removed)

Definition of done:

- Removed per ADR-0011/0012: the feature DAG, `plan/<featureId>.md`, `plan.json`, the planner-critic, and the `charter_plan` tool. There is no lock-plan flow; charters are created `active`.
- `criterion-state.json` initializes from `criteria.md` (Objective → Milestone → VAL).
- `charter:before_lock_plan` hook type remains defined but has no live emitter (lock-plan flow removed).

## M3 — evidence and verification

Definition of done:

- `charter_record({action:'evidence'})` appends evidence records.
- `criterion-state.json` and `feature-state.json` recompute from evidence.
- Removed per ADR-0013: charter-run command checks; commands are run by the agent and recorded as evidence.
- Manual evidence works with required `because`.
- Completion is blocked without required recorded evidence.
- `requireFreshEvidence` is enforced; `requireReviewSubagent` is display-only.

## M4 — smart-Ralph status and Ralph reprompting

Definition of done:

- `charter_status` returns drift views and `nextActions[]`.
- Status widget shows compact charter state.
- Reminder/steer injection replaces v1 static reminder.
- Deterministic Ralph reprompting works from status data.

## M5 — subagent/persona integration

Definition of done:

- Removed per ADR-0013: bundled verifier/planner personas are not shipped.
- Subagent metadata passthrough conventions are documented for user-owned subagents.
- `handoff_apply` ingests handoff envelopes.

## M6 — TUI and polish

Definition of done:

- `/charter` opens status/settings/TUI surface.
- Optional TUI approver subscribes to `charter:before_complete`.
- Docs and README match shipped behavior.
- Dogfood on one real project task.

## Suggested first implementation slice

Build M1 + a thin M2 status path first:

1. Types and filesystem helpers.
2. `charter(create|pause|resume)`.
3. `charter_status` with placeholder drift and real binding resolution.
4. `/charter <objective>` shortcut.
5. One smoke test creating a charter in a temp project.

This gives immediate dogfood value without requiring evaluator/model complexity.
