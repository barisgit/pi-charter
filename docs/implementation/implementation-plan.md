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
- `charter_manage({action:'create'})` creates `<project>/.pi/charters/<uuid>/`.
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

## M2 — planning and plan sidecars

Definition of done:

- `plan/<featureId>.md` parser/writer exists.
- `plan.json` recomputes from frontmatter.
- `criterion-state.json` initializes from `charter.md §Criteria`.
- Planner-critic checks uncovered criteria, orphan features, and cycles.
- `charter_plan({action:'view'})` returns coverage and drift.
- `charter:before_lock_plan` hook is emitted before active transition.

## M3 — evidence and verification

Definition of done:

- `charter_record({action:'evidence'})` appends evidence records.
- `criterion-state.json` and `feature-state.json` recompute from evidence.
- Command verifier works.
- Manual evidence works with explicit weak marker.
- Completion is blocked without required evidence.
- `requireFreshEvidence` and `requireReviewSubagent` predicates are enforced.

## M4 — smart-Ralph status and evaluator

Definition of done:

- `charter_status` returns drift views and `nextActions[]`.
- Status widget shows compact charter state.
- Reminder/steer injection replaces v1 static reminder.
- Deterministic evaluator summary works.
- Model evaluator interface exists, even if default-off.

## M5 — subagent/persona integration

Definition of done:

- `charter-verifier`, `charter-planner-critic`, `charter-evaluator` persona docs exist.
- Subagent metadata passthrough conventions are implemented or documented against pi-subagents.
- `handoff_apply` ingests handoff envelopes.

## M6 — TUI and polish

Definition of done:

- `/charter` opens status/settings/TUI surface.
- Optional TUI approver subscribes to `charter:before_lock_plan`.
- Docs and README match shipped behavior.
- Dogfood on one real project task.

## Suggested first implementation slice

Build M1 + a thin M2 status path first:

1. Types and filesystem helpers.
2. `charter_manage(create|pause|resume)`.
3. `charter_status` with placeholder drift and real binding resolution.
4. `/charter <objective>` shortcut.
5. One smoke test creating a charter in a temp project.

This gives immediate dogfood value without requiring evaluator/model complexity.
