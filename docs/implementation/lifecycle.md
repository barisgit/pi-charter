# Lifecycle

## Status FSM

```text
create
  -> planning
planning
  -> active       after charter.md + plan/*.md pass planner-critic and before_lock_plan hooks
  -> paused       user/system pause
active
  -> review       all criteria currently pass
  -> paused
  -> budget_limited
  -> abandoned
review
  -> completed    completion gates and before_complete hooks pass
  -> active       evidence rejected, stale, or charter amended
  -> paused
paused
  -> previous non-terminal state via resume
```

## Spawn and create

Three entry points converge on the same create logic:

1. Agent calls `charter_manage({action:'create', objective})`.
2. User runs `/charter <objective>`.
3. Orchestrator launches Pi with `--charter-objective "<text>"` or `--charter-resume <id>`.

Specs are plain English context. If the prompt says "use `docs/spec.md`", the agent reads that file and authors the charter during planning. pi-charter does not auto-detect or copy specs.

## Planning phase

1. Resolve or create `<project>/.pi/charters/<charterId>/`.
2. If `charter.md` already exists, treat it as authoritative.
3. Otherwise, agent authors `charter.md` with Objective, Criteria, Scope and constraints.
4. Agent creates `plan/<featureId>.md` files with `fulfills[]` links.
5. `charter-planner-critic` or equivalent logic checks:
   - every criterion is covered by at least one feature;
   - every feature fulfills at least one criterion;
   - feature preconditions are acyclic;
   - scope/budget is plausible.
6. Emit `charter:before_lock_plan`.
7. If allowed, write digests and transition to `active`.

## Active phase

At each turn or status check:

1. Recompute sidecars if authored files changed.
2. Read drift views and `nextActions[]`.
3. Agent chooses one action:
   - implement a ready feature;
   - record evidence;
   - run verifier;
   - delegate review/verification;
   - amend charter;
   - pause;
   - ask user if blocked.
4. Evidence updates `criterion-state.json` and may update `feature-state.json`.
5. If all criteria pass and required review/freshness predicates pass, transition to `review`.

## Review phase

The agent gets one explicit evidence-inspection turn. `charter_status` should make the evidence summary prominent. Completion requires:

- all criteria pass;
- `requireFreshEvidence` predicates pass;
- `requireReviewSubagent` predicates pass;
- `charter:before_complete` hooks allow;
- no open hard blockers in drift views.

If any predicate fails, return to `active` with clear `nextActions[]`.

## Terminal states

- `completed` writes `result.json` with summary, criteria pass/fail counts, duration, and evidence/handoff highlights.
- `budget_limited` records the budget dimension and partial progress.
- `abandoned` records reason and leaves artifacts intact.

## Ralph role

Ralph reprompts from current status when the root agent and async children are idle. It does not complete, pause, or abandon a charter; verifier evidence and hooks decide terminal completion.
