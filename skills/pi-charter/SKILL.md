---
name: pi-charter
description: Drive multi-feature work to completion under a durable contract with VAL criteria + evidence. Use for charter_manage/charter_plan/charter_record/charter_status tools, /charter command, --charter-objective flag, .pi/charters/ dirs, or user asks to implement/build/ship something spanning many turns. Skip for single-file edits or quick fixes.
---

# pi-charter

A **charter** is a durable contract you (the agent) hold with yourself:
plan once, then implement end to end until every `VAL-*` criterion has
pass evidence. Four phases, driven in one continuous run:

```
1. CREATE    charter_manage action=create
2. PLAN      edit charter.md (criteria) -> add_feature -> planner-critic -> lock_plan
3. EXECUTE   per feature: implement -> charter-verifier -> evidence recorded
4. COMPLETE  charter_manage action=complete    (gated on pass evidence)
```

Once the plan is locked, do not stop between features to ask "should I
keep going?". The objective + locked plan is your authorization to ship.

## Hard rules

1. **Never write `charter.md` or `plan/*.md` directly.** `charter.md` lives
   at `<cwd>/.pi/charters/<id>/charter.md` and is created by
   `charter_manage action=create`; you only edit it to add criteria.
   Feature files are written by `charter_plan action=add_feature`.
2. **`charter-planner-critic` is mandatory before `lock_plan`.** Resolve
   every `BLOCK` finding it returns; `ADVISORY` is optional.
3. **`complete` is evidence-gated.** Every `VAL-*` needs `outcome: 'pass'`
   evidence before `charter_manage action=complete` will succeed. If the
   gate rejects, `charter_status` lists the gaps.
4. **Follow `charter_status nextActions[]`.** It returns the legal moves
   for the current state; don't guess transitions.
5. **End-of-turn questions are last resort.** If `nextActions[]` has an
   unblocked move, take it. Surface decisions in the commit message, not
   as blocking questions, when the objective already implies the answer.

## Delegation discipline

Main-agent context is the scarce resource. Anything bounded or read-only
goes to a subagent:

| Job                                          | Subagent                  |
|----------------------------------------------|---------------------------|
| Plan critique before `lock_plan`             | `charter-planner-critic`  |
| Per-criterion verification + evidence write  | `charter-verifier`        |
| Code/file recon, symbol tracing              | `explorer`                |
| External research (vendor docs, library API) | `explorer`                |
| Bounded implementation                       | `fixer`                   |
| Hard-debug direction                         | `oracle` (advisory)       |

Call shape for the bundled personas:

```
subagent({
  agent: 'charter-verifier',                  // or 'charter-planner-critic'
  prompt: '<short, concrete task>',
  metadata: {
    'pi-charter.projectDir': <cwd>,           // required
    'pi-charter.charterId': '<id>',
    'pi-charter.featureId': '<id>',           // verifier only
    'pi-charter.criterionId': 'VAL-...',      // verifier only
  },
})
```

`charter-verifier` records exactly one `charter_record action=evidence`.
`charter-planner-critic` returns `PASS | BLOCK | ADVISORY`.

**Default to `async: true`** for anything you don't need synchronously to
choose the next move (most fixer handoffs, most verifier runs, long
explorers). The runtime wakes main when the child finishes, so you can
spawn the next handoff or hand control back to the user. Use sync only
when you must read the result before the next move — typically
`charter-planner-critic` before `lock_plan`, or an `explorer` whose
finding decides spawn-vs-abandon.

If you stay active between async spawns, sleep briefly between status
checks rather than busy-polling.

## Phase 1: Create

```
charter_manage action=create { objective: "<one-line intent>", charterId?: "short-slug" }
```

The tool stubs `charter.md` with a worked `VAL-EXAMPLE` (template format
in-line), empty `plan/`, and `state.status: planning`. Session is bound
to this charter; subsequent charter tools default `charterId` to it.

## Phase 2: Plan

### 2a. Recon before authoring

A charter authored without recon produces brittle criteria and orphan
features. Before editing `charter.md`:

- Read the obvious sources of truth the objective points at (referenced
  spec, entry-point file, existing tests, `CONTEXT.md` / ADRs in the
  target tree).
- Dispatch 1-3 parallel `explorer` subagents for cross-cutting questions
  (what pattern is used, what tests exist, what config governs the
  behavior, vendor docs). One angle per child.
- Cite recon in the artifacts you author next — paths/symbols go into
  feature bodies and `## Scope and constraints`. The planner-critic
  flags features whose bodies reference no concrete code.

Recon is normal discipline, not a charter phase. If recon invalidates
the objective, say so before authoring criteria.

### 2b. Author criteria

Edit `<cwd>/.pi/charters/<id>/charter.md`. Replace the `VAL-EXAMPLE`
block. **Use `### VAL-<ID>` H3 headings** with field lines beneath;
bullet lists like `- VAL-1: ...` are silently ignored.

```markdown
### VAL-AUTH-001 Sign-in succeeds with Google OAuth
Description: User can complete OAuth and reach the dashboard.
Verifier: command
Command: bun test tests/oauth-google.test.ts
Fresh evidence required: true
```

Verifier kinds: `command` (exit 0 = pass), `manual` (person or
`charter-verifier` records evidence), `hook` / `prompt` (advanced).

Fill in `## Scope and constraints` if the stub left it empty.

### 2c. Seed features

```
charter_plan action=add_feature {
  features: [
    {
      id: "f1-pin-deps",
      milestone: "m1-bootstrap",
      order: 1,
      fulfills: ["VAL-BOOT-001", "VAL-BOOT-002"],
      preconditions: [],
      body: "What this feature does and how it satisfies the listed criteria.",
    },
    { id: "f2-validate", milestone: "m1-bootstrap", order: 2, fulfills: ["VAL-BOOT-003"], body: "..." },
  ],
}
```

The batch is atomic — every feature lands or none do. `id` matches
`/^[a-z0-9][a-z0-9_-]*$/i`; `fulfills[]` must list at least one real
`VAL-*` from `charter.md`. Use `update_feature` to revise.

### 2d. Run planner-critic (mandatory)

```
subagent({
  agent: 'charter-planner-critic',
  prompt: 'Critique charter <id>.',
  metadata: { 'pi-charter.projectDir': <cwd>, 'pi-charter.charterId': '<id>' },
})
```

Resolve every `BLOCK`. Sync (not async) — you need the result to lock.

### 2e. Lock

```
charter_plan action=lock_plan
```

Runs checks (uncovered scope, orphan features, cyclic preconditions,
unknown `VAL-*` refs, missing verifier commands). Throws with details on
drift. On success: `planning -> active`.

## Phase 3: Execute

Drive every feature to evidence without stopping. Per feature:

1. Pull the next ready feature from `charter_status` (`drift.readyNext[]`).
2. Implement (delegate bounded work to `fixer`). Run local checks as you go.
3. For each `VAL-*` the feature fulfills, dispatch `charter-verifier`
   (async by default) with `featureId` + `criterionId` in metadata. It
   runs the verifier or its own equivalent checks and writes one
   `charter_record action=evidence`.
4. Move to the next feature. Loop until `drift.uncovered: []`.

If you record evidence yourself for multiple criteria, use the batch
shape:

```
charter_record action=evidence {
  entries: [
    { criterionId: "VAL-AUTH-001", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
    { criterionId: "VAL-AUTH-002", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
  ],
}
```

You can also `charter_record action=verify` to run a criterion's command
verifier inline, but prefer `charter-verifier` for context hygiene.

## Phase 4: Complete

```
charter_manage action=complete { completionNote?: "..." }
```

Gated: every `VAL-*` must have `outcome: 'pass'` evidence. On success:
`active -> completed`, session unbound. `force_complete` and
`amend_charter` are escape hatches.

## Reading status

`charter_status` whenever you're unsure, after recording evidence, and
before completing. Returns:

- `drift.uncovered[]` — criteria with no/non-pass evidence.
- `drift.stuck[]` — features `in_progress` with no recent update.
- `drift.stale[]` — pass evidence past the fresh-evidence window.
- `drift.readyNext[]` — features whose preconditions are satisfied.
- `nextActions[]` — legal next moves. **Take one of these.**

A post-turn evaluator may inject a `drifting | blocked |
ready_to_complete` steer as a reminder on your next turn. Treat it as a
nudge to re-read `charter_status`, not as a literal instruction.
`on_track` is **not** a completion signal — only the `complete` gate is.

## Tactical tasks vs. charter features

Charter features are durable units fixed at `lock_plan`. Tactical
trackers (e.g. `task_manage`) are per-turn scratch. A tactical task that
spans the whole charter is a smell — promote it to a feature or split
it. Charter sidecars are the source of truth; the task tracker is just a
turn-to-turn surface.

## Common pitfalls

- **Stopping after planning** to ask "should I implement now?". No. The
  locked plan is your authorization.
- **Verifying inline** instead of delegating to `charter-verifier`.
  Burns main-agent context on long charters.
- **Writing `charter.md` / `plan/*.md` at the repo root** — they live
  under `.pi/charters/<id>/`, and the tools own `plan/*.md`.
- **Asking decisions the objective already implies** (commit author,
  branch name, build flags). Pick the obvious default and proceed.
- **Trusting evaluator `on_track` as a completion signal.** It's a steer.
- **Forgetting `pi-charter.projectDir` in subagent metadata.** Without
  it, the child can't locate the charter dir and won't record evidence.
- **Assuming `handoff_apply` always completes the feature.** It only
  flips a feature to `completed` once every criterion in its `fulfills[]`
  has pass evidence. Partial handoffs leave it `in_progress` — intentional.

## Quick reference

| Tool                                  | Purpose                                          |
|---------------------------------------|--------------------------------------------------|
| `charter_manage action=create`        | Open a charter; session auto-binds.              |
| `charter_manage action=pause/resume`  | Lifecycle escape hatch.                          |
| `charter_manage action=complete`      | Gated finish; requires all `VAL-*` pass.         |
| `charter_manage action=force_complete`| Manual override; subject to hook.                |
| `charter_manage action=amend_charter` | Mutate `charter.md` mid-flight.                  |
| `charter_plan action=view`            | Inspect coverage and uncovered criteria.         |
| `charter_plan action=add_feature`     | Write a managed `plan/<id>.md`.                  |
| `charter_plan action=update_feature`  | Revise an existing managed feature file.         |
| `charter_plan action=lock_plan`       | Planner checks + transition to `active`.         |
| `charter_record action=evidence`      | Append a pass/fail/partial evidence entry.       |
| `charter_record action=verify`        | Run the criterion's command verifier.            |
| `charter_record action=handoff_apply` | Apply a returned handoff envelope.               |
| `charter_status`                      | Status + drift + `nextActions` + guidelines.     |

| Persona                  | Use when                                                 |
|--------------------------|----------------------------------------------------------|
| `charter-planner-critic` | Before `lock_plan`. Resolve every `BLOCK`. Sync.         |
| `charter-verifier`       | Per-criterion verification + evidence. Async by default. |
