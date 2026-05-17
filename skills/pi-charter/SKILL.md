---
name: pi-charter
description: Drive multi-feature work to completion under a durable contract with VAL criteria + evidence. Use for charter_manage/charter_plan/charter_record/charter_status tools, /charter command, --charter-objective flag, .pi/charters/ dirs, or user asks to implement/build/ship something spanning many turns. Skip for single-file edits or quick fixes.
---

# pi-charter

You are operating under a **charter**. A charter is a multi-phase commitment:
plan once, then implement end to end without stopping until every VAL-*
criterion has pass evidence. Read this skill once at the start of any charter
work and refer back to the Quick Reference when in doubt.

## What a charter actually is

A charter is **not** a planning artifact you hand off. It is the agent's own
contract with itself, broken into four phases that you drive in one
continuous run:

```
1. CREATE        charter_manage action=create
                 |
2. PLAN          edit charter.md to add VAL-* criteria
                 charter_plan action=add_feature  (per feature)
                 subagent({agent:'charter-planner-critic'})   <-- mandatory
                 charter_plan action=lock_plan
                 |
3. EXECUTE       feature-by-feature implementation
                 subagent({agent:'charter-verifier'})         <-- per criterion
                 charter_record action=evidence | verify
                 |
4. COMPLETE      charter_manage action=complete
                 (gated: every VAL-* must have pass evidence)
```

Once the plan is locked the charter is a single end-to-end commitment. You
do not pause between features to ask the user "should I keep going?". The
Ralph-style outer loop will re-prompt you if your turn ends, but every turn
inside the active phase should be moving toward the next feature, the next
piece of evidence, the next completion.

## Hard rules (do not break)

1. **Use subagents for bounded work. Main agent context is precious.**
   Verification of a criterion, plan critique, and any long read-only recon
   MUST go through `subagent({...})`. Doing them inline burns your context
   window and kills the loop on long charters. See "Delegate aggressively"
   below.
2. **Never write `charter.md` at the repo root.** It lives at
   `<cwd>/.pi/charters/<id>/charter.md`. `charter_manage action=create`
   writes the stub for you; edit that file directly to add criteria.
3. **Never write `plan/<featureId>.md` files yourself.** Use
   `charter_plan action=add_feature` / `update_feature`. The tool writes
   them under `<cwd>/.pi/charters/<id>/plan/<id>.md` with correct frontmatter.
4. **Never call `charter_manage action=complete` until every VAL-* has pass
   evidence.** The gate will reject and `charter_status` will list the gaps.
5. **Always follow `charter_status` `nextActions[]`.** Do not guess
   transitions; the tool returns the legal next moves for the current state.
6. **Run `charter-planner-critic` before `lock_plan`.** Resolve every BLOCK
   finding it returns; ADVISORY findings are optional.
7. **End-of-turn questions are last resort.** If you have an unblocked next
   move per `charter_status nextActions`, take it. Surface a decision in the
   commit message, not as a blocking question, when the user's intent is
   already clear from the objective.

## Delegate aggressively (the single most important rule)

The main agent runs the charter loop and coordinates. Anything bounded and
read-only is a subagent job. Concretely:

| Job                                              | Where it runs            |
|--------------------------------------------------|--------------------------|
| Plan critique before `lock_plan`                 | `charter-planner-critic` |
| Per-criterion verification + evidence recording  | `charter-verifier`       |
| Code recon, symbol tracing, file/path discovery  | `explorer`               |
| Long external research (vendor docs, library API)| `explorer`               |
| Bounded same-language implementation             | `fixer` (after you scope) |
| Hard-debug deterministic-loop building           | `oracle` (advisory)      |

If you catch yourself reading a third file in a row, stop and delegate to
`explorer`. If you catch yourself running the same verifier command twice,
stop and delegate to `charter-verifier`. Long charters die when the main
agent's context fills with grep results and tool output that a subagent
could have absorbed and summarized.

Subagent call shape for the bundled charter personas:

```
subagent({
  agent: 'charter-verifier',                  # or 'charter-planner-critic'
  prompt: '<short, concrete task>',
  metadata: {
    'pi-charter.projectDir': <cwd>,           # required for async bridge
    'pi-charter.charterId': '<id>',
    'pi-charter.featureId': '<id>',           # verifier only
    'pi-charter.criterionId': 'VAL-...',      # verifier only
  },
})
```

Both bundled personas are read-only. The verifier records exactly one
`charter_record action=evidence`. The planner-critic returns a structured
`PASS | BLOCK | ADVISORY` report.

## Task hygiene

pi-charter and any tactical task tracker (e.g. `task_manage` from
pi-dag-tasks) operate at **different scales**. Do not confuse them.

| Layer        | Scope                              | Source of truth                       |
|--------------|------------------------------------|---------------------------------------|
| Macro DAG    | Milestones and features for the    | `charter.md` + `plan/<id>.md` +       |
|              | whole charter, fixed at lock_plan. | `feature-state.json`,                 |
|              |                                    | `criterion-state.json`.               |
| Tactical     | One turn or a few turns of work    | `task_manage` (pi-dag-tasks) or       |
| tasks        | inside the current feature.        | inline todos; rewritten as you go.    |

Rules:

- Features and milestones are the **only** durable units across the
  charter. They are immutable in shape once `lock_plan` runs (use
  `update_feature` or `amend_charter` for real changes).
- Tactical tasks (`task_manage`) are **per-turn or per-feature
  scratch**. A tactical task that spans the whole charter is a smell:
  promote it to a feature instead, or split it.
- Charter progress is read from `feature-state.json` and
  `criterion-state.json`. The reminder bridge re-emits every 8 turns from
  these sidecars, so anything you forget to record shows up in the
  reminder and in `charter_status`.
- Record `charter_record action=evidence` (or let `charter-verifier` do
  it) the moment a criterion has a real pass/fail signal — not at the end.
- `charter_record action=handoff_apply` only flips a feature to
  `status: 'completed'` once every criterion in its `fulfills[]` has pass
  evidence. Partial handoffs leave the feature `status: 'in_progress'`,
  which is correct.
- If you use `task_manage` alongside pi-charter, seed it from the locked
  plan with one tactical entry per ready feature, mark
  `status: 'in_progress'` before working that feature, and mark it
  `status: 'completed'` only after the feature's evidence is recorded.
  Then drop or rewrite the tactical task when you move on. Charter
  sidecars remain the source of truth; the task tracker is just a
  turn-to-turn surface.

## Filesystem layout

```
<cwd>/.pi/charters/<charterId>/
  charter.md             # objective + Criteria (VAL-*) + Scope + Constraints
  state.json             # status, phase, sessionId, planDigest
  events.jsonl           # append-only event log
  plan/<featureId>.md    # ONE per feature, written by charter_plan
  plan.json              # computed sidecar
  criterion-state.json   # last evidence outcome per VAL-*
  feature-state.json     # per-feature progress
  work/<featureId>/evidence/VAL-*__<ts>.json
  handoffs/<ts>__<featureId>__<sessionId>.json
```

You only touch `charter.md` directly (to add criteria). Everything else is
owned by tools.

## Phase 1: Create

```
charter_manage action=create { objective: "<one-line intent>", charterId?: "short-slug" }
```

- Pass a concise slug `charterId` when you can; otherwise a UUID is generated.
- The tool stubs `charter.md` with a worked VAL-EXAMPLE criterion (template
  format is documented in-line), empty `plan/`, and `state.status: planning`.
- Session is auto-bound.

## Phase 2: Plan

### 2a. Recon before authoring (do not skip)

A charter written without recon produces brittle VAL criteria and orphan
features. Before editing `charter.md`, do bounded recon proportional to the
objective:

- **Read the obvious sources of truth** the objective implies: the spec the
  user referenced, the entry-point file, the existing tests in the area,
  and any `CONTEXT.md` / ADRs in the target tree.
- **Dispatch 1-3 parallel `explorer` subagents** for anything cross-cutting:
  what pattern is already used, what tests exist, what config/env knobs
  govern the behavior, what external vendor docs apply. Keep each explorer
  scope tight (one angle per child).
- **`recall` past memories** when the work touches a project you've worked
  on before; cross-session decisions live in ICM, not the code.
- **Cite the recon in the artifacts you author next.** Drop the relevant
  paths/symbols into feature bodies or `## Scope and constraints` so the
  later execution phase doesn't redo the same lookups. The planner-critic
  in 2c will flag features whose bodies reference no concrete code.

Recon is *not* a charter phase or an FSM state; it is normal agent
discipline. There are no `charter_research_*` tools, no evidence kind for
it, and no gate. The deliverable is a better `charter.md` and tighter
feature bodies. If recon turns up something that invalidates the objective,
say so before authoring criteria and either narrow the objective or pause
the charter.

### 2b. Author criteria

Edit `<cwd>/.pi/charters/<id>/charter.md` directly. Replace the VAL-EXAMPLE
block. The format is strict — use `### VAL-<ID>` H3 headings with field
lines beneath. **Bullet lists like `- VAL-1: ...` are silently ignored by
the parser.**

```markdown
### VAL-AUTH-001 Sign-in succeeds with Google OAuth
Description: User can complete OAuth and reach the dashboard.
Verifier: command
Command: bun test tests/oauth-google.test.ts
Fresh evidence required: true
```

Verifier kinds:
- `Verifier: command` — tool runs `Command` via `/bin/sh -c`, exit 0 = pass.
- `Verifier: manual` — a person or `charter-verifier` subagent records evidence.
- `Verifier: hook` / `Verifier: prompt` — advanced; rarely used at first.

Also fill in the `## Scope and constraints` section if the stub left it
empty.

### 2c. Seed features

Prefer the **batch shape** when you have more than one feature to add
(typical at planning time). It is atomic: either every feature lands or
none do, and aggregated validation errors come back in one response.

```
charter_plan action=add_feature {
  // charterId optional once the session is bound to this charter.
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

The single-entry inline shape (`{ id, milestone, order, fulfills, body }`)
still works for one-off additions and edits but emits a `deprecated`
warning. Use `update_feature` (same single-entry params) to revise.

- `id` must match `/^[a-z0-9][a-z0-9_-]*$/i`.
- `fulfills[]` must list at least one real VAL-* id from `charter.md`.
- The response preserves request order: `features[i].featureId` matches
  `input.features[i].id` regardless of the `order` field.

### 2d. Run planner-critic (mandatory)

```
subagent({
  agent: 'charter-planner-critic',
  prompt: 'Critique charter <id>.',
  metadata: { 'pi-charter.projectDir': <cwd>, 'pi-charter.charterId': '<id>' },
})
```

Resolve every BLOCK before locking. ADVISORY findings are optional but
worth fixing when cheap.

### 2e. Lock

```
charter_plan action=lock_plan { charterId }
```

Runs in-process checks (uncovered scope, orphan features, cyclic
preconditions, unknown VAL-* refs, missing verifier commands). Throws
`Cannot lock plan because of drift: ...` with details if anything is off.
On success: `planning → active`, `plan_locked` event appended.

## Phase 3: Execute (end to end)

Once the plan is locked, **drive every feature to evidence without
stopping**. The shape per feature:

1. Pull the next ready feature from `charter_status` (`drift.readyNext[]`).
2. Implement the code. Run local checks (tests, typecheck) as you go.
3. For each VAL-* the feature fulfills, delegate verification:

   ```
   subagent({
     agent: 'charter-verifier',
     prompt: 'Verify VAL-AUTH-001 on charter <id>, feature f1-pin-deps.',
     metadata: {
       'pi-charter.projectDir': <cwd>,
       'pi-charter.charterId': '<id>',
       'pi-charter.featureId': 'f1-pin-deps',
       'pi-charter.criterionId': 'VAL-AUTH-001',
     },
   })
   ```

   The persona runs the criterion's verifier or its own equivalent checks
   and writes exactly one `charter_record action=evidence`. The async
   bridge appends `feature_completed` / `feature_failed` based on outcome.

   When you do record evidence yourself for multiple criteria at once,
   prefer the **batch shape**:

   ```
   charter_record action=evidence {
     // charterId optional once bound.
     entries: [
       { criterionId: "VAL-AUTH-001", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
       { criterionId: "VAL-AUTH-002", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
     ],
   }
   ```

   The batch writes `criterion-state.json` once atomically, avoiding the
   load-modify-write race that the legacy single-entry loop exposed. The
   inline single-entry shape still works but warns `deprecated`.

4. Move to the next feature. Loop until `charter_status` shows
   `drift.uncovered: []` and every VAL-* has pass evidence.

You can also call `charter_record action=verify` directly if you want the
main agent to run the criterion's `Command` itself, but **prefer the
subagent** for context hygiene.

## Phase 4: Complete

```
charter_manage action=complete { charterId, completionNote?: "..." }
```

Completion gate verifies every VAL-* has `outcome: 'pass'` evidence. On
success: `active → completed`, session unbound. If the gate rejects,
`charter_status` will list the gaps; resolve them and try again.

`force_complete` and `amend_charter` are escape hatches subject to blocking
hooks; use them deliberately.

## Ralph loop and the post-turn evaluator

pi-charter runs a post-turn evaluator that returns one of
`on_track | drifting | blocked | ready_to_complete | done` with a short
reason. It is a **steer**, not a gate.

- `on_track` is not a completion signal. Only the `complete` gate (every
  VAL-* has pass evidence + hooks allow) completes a charter.
- `drifting`, `blocked`, and `ready_to_complete` re-trigger your next turn
  with the steer reason injected as a reminder. Treat that as a nudge to
  read `charter_status` and pick the next legal action, not as a literal
  instruction.
- Identical verdicts in a row are de-duped, so spurious repeats will not
  spam the loop.

## Reading status and drift

Run `charter_status` whenever you are unsure what to do next, after
recording evidence, and before completing. The tool returns:

- `status`, `phase`, `objective`, `budget`.
- `drift.uncovered[]` — criteria with no/non-pass evidence.
- `drift.stuck[]` — features in `in_progress` with no recent update.
- `drift.stale[]` — pass evidence past the fresh-evidence window.
- `drift.readyNext[]` — features whose preconditions are satisfied.
- `nextActions[]` — legal next moves.
- `guidelines[]` — short reminders for the current status.

The text channel formatted block shows phase, drift counts, the top 3
nextActions, and current guidelines.

## CLI / slash entry points

- `/charter <objective>` and `pi --charter-objective "<text>"` hand the
  objective to the agent via a structured user message. **The agent owns
  charter creation** — these surfaces never call `charter_manage create`
  directly. Any non-empty arg text is treated as objective (no reserved
  verbs); bare `/charter` emits a usage hint pointing at
  `/charter <objective>` and `/charters`.
- `/charters` is the inspection/management command:
  - bare opens the master-detail picker overlay (lists active charters on
    the left, full per-charter status on the right; `j/k/up/down` navigate,
    `enter` selects, `q/esc` cancel),
  - `/charters status` notifies the status block for the selected charter,
  - `/charters pause` and `/charters resume` are lifecycle shortcuts on the
    selected charter,
  - `/charters select <id>` or `/charters select none` pins / clears the
    persistent charter-detail widget without opening the overlay,
  - `/charters list` notifies a one-line summary per active charter.
  When no selection is set, `status|pause|resume` use the sole active
  charter if there is exactly one; otherwise they re-open the picker (TUI)
  or notify a hint listing active ids (non-TUI).

## Bound-charter defaults

Once a charter is bound to your session (automatic on `charter_manage
action=create`, or via `session_start` reconcile when the reverse binding
at `~/.pi/agent/sessions/<sid>/charter.json` exists), **every charter tool
except `charter_manage action=create` defaults `charterId` to the bound
charter when omitted**. You only need to pass `charterId` when:

- you want to operate on a different charter than the bound one;
- you have no session binding (the tools then throw a typed
  `NoCharterBoundError` containing the literal phrase `"no charter bound"`
  and a `hint` field).

This applies to `charter_status`, every `charter_plan` action, every
`charter_record` action, and `charter_manage` actions `pause`, `resume`,
`complete`, `force_complete`, `amend_charter`.

## Hooks (advanced)

Four blocking hook events: `charter:before_lock_plan`,
`charter:before_complete`, `charter:before_force_complete`,
`charter:before_amend_charter`. Subscribers return `{decision: 'allow'}` or
`{decision: 'block', reason}`. A block throws and the FSM does not advance.
This is the integration point for a TUI approver or CI gate.

## Common pitfalls

- **Stopping after planning** to ask the user "should I implement now?".
  No. The objective + locked plan is your authorization to implement end to
  end. If you hit a real blocker, record it as evidence/fail and
  `charter_status nextActions[]` will tell you the next legal move.
- **Doing verification inline** instead of delegating to `charter-verifier`.
  Your main-agent context is the scarcest resource in a long charter.
- **Writing `charter.md` or `plan/*.md` at the repo root.** Common mistake;
  the tools own these paths.
- **Asking decision questions whose answer is implied by the objective**
  (commit author, build flags, branch name). Pick the obvious default,
  proceed, and surface the choice in the commit message.
- **Trusting the post-turn evaluator's `on_track` verdict as a completion
  signal.** It is a steering nudge, not a gate.
- **Forgetting `pi-charter.projectDir` in subagent metadata.** Without it
  the async bridge cannot locate the per-project charter dir; feature
  events will not be appended.
- **Assuming `handoff_apply` always completes the feature.** It only does
  so when every criterion the feature fulfills already has pass evidence.
  If a handoff covers a subset, the feature stays `in_progress` until the
  remaining criteria are recorded — that is intentional.

## Quick reference

| Tool                                  | Purpose                                          |
|---------------------------------------|--------------------------------------------------|
| `charter_manage action=create`        | Open a new charter; session auto-binds.          |
| `charter_manage action=pause/resume`  | Lifecycle escape hatch.                          |
| `charter_manage action=complete`      | Gated finish; requires all VAL-* pass.           |
| `charter_manage action=force_complete`| Manual override; subject to hook.                |
| `charter_manage action=amend_charter` | Mutate `charter.md` mid-flight; subject to hook. |
| `charter_plan action=view`            | Inspect coverage and uncovered criteria.         |
| `charter_plan action=add_feature`     | Write a managed `plan/<id>.md` for the feature.  |
| `charter_plan action=update_feature`  | Revise an existing managed feature file.         |
| `charter_plan action=lock_plan`       | Planner checks + transition to `active`.         |
| `charter_record action=evidence`      | Append a pass/fail/partial evidence entry.       |
| `charter_record action=verify`        | Run the criterion's command verifier.            |
| `charter_record action=handoff_apply` | Apply a returned handoff envelope.               |
| `charter_status`                      | Status + drift + nextActions + guidelines.       |

| Persona                  | Use when                                                 |
|--------------------------|----------------------------------------------------------|
| `charter-planner-critic` | Before `lock_plan`. Resolve every BLOCK it returns.      |
| `charter-verifier`       | Per-criterion verification + evidence recording.         |
