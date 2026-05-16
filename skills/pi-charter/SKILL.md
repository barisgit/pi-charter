---
name: pi-charter
description: |
  Run durable, charter-bound work end-to-end: create a charter, write VAL-*
  criteria, decompose into features, lock the plan, then implement every
  feature to completion in this same loop using subagents for verification
  and critique. Use whenever you see charter_manage / charter_plan /
  charter_record / charter_status tools, the /charter slash command, the
  --charter-objective CLI flag, or a charter directory under
  <project>/.pi/charters/.
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

### 2a. Author criteria

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

### 2b. Seed features

For each feature:

```
charter_plan action=add_feature {
  charterId,
  id: "f1-pin-deps",
  milestone: "m1-bootstrap",
  order: 1,
  fulfills: ["VAL-BOOT-001", "VAL-BOOT-002"],
  preconditions: [],
  body: "Markdown body describing what this feature does and how it satisfies the listed criteria.",
}
```

- `id` must match `/^[a-z0-9][a-z0-9_-]*$/i`.
- `fulfills[]` must list at least one real VAL-* id from `charter.md`.
- Use `update_feature` (same params) to revise.

### 2c. Run planner-critic (mandatory)

```
subagent({
  agent: 'charter-planner-critic',
  prompt: 'Critique charter <id>.',
  metadata: { 'pi-charter.projectDir': <cwd>, 'pi-charter.charterId': '<id>' },
})
```

Resolve every BLOCK before locking. ADVISORY findings are optional but
worth fixing when cheap.

### 2d. Lock

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
  directly.
- `/charter` bare prints the current charter status block.
- `/charter status` is the same block.
- `/charter pause` and `/charter resume` are lifecycle shortcuts.

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
