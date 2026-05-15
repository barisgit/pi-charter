---
name: pi-charter
description: |
  Run durable, charter-bound work: create a charter, write VAL-* criteria,
  decompose into features under .pi/charters/<id>/plan/, lock the plan, execute
  feature by feature, record evidence, and complete. Use whenever you see
  charter_manage / charter_plan / charter_record / charter_status tools, the
  /charter slash command, the --charter-objective CLI flag, or a charter
  sitting in <project>/.pi/charters/.
---

# pi-charter

This is the end-to-end workflow for working under a charter. Charters are how
the agent declares intent up front, decomposes work, records evidence, and
gates completion. Use this skill when any of the `charter_*` tools are
involved or when a charter already exists in the project.

## Hard rules (do not break)

- **Never create `charter.md` at the repo root.** It lives at
  `<cwd>/.pi/charters/<id>/charter.md`. `charter_manage action=create` writes
  the stub for you; edit that file directly to add criteria.
- **Never write `plan/<featureId>.md` files yourself.** Use
  `charter_plan action=add_feature` (and `update_feature`). The tool writes
  them under `<cwd>/.pi/charters/<id>/plan/<id>.md` with the correct YAML
  frontmatter.
- **Never call `charter_manage action=complete` until every VAL-* criterion
  has pass evidence.** The completion gate will reject it and `charter_status`
  will tell you exactly which criteria are still uncovered.
- **Always follow `charter_status` `nextActions[]`.** Do not guess
  transitions. The tool returns the legal next moves for the current state.
- **Delegate planning critique and verification to bundled personas** instead
  of running them inline (see "Delegation" below).

## Filesystem layout

```
<cwd>/.pi/charters/<charterId>/
  charter.md             # objective + Criteria (VAL-*) + Scope + Constraints
  state.json             # status, phase, sessionId, planDigest
  events.jsonl           # append-only event log
  plan/
    <featureId>.md       # ONE FILE PER FEATURE, written by charter_plan
  plan.json              # computed sidecar (generated from plan/*.md)
  criterion-state.json   # last evidence outcome per VAL-*
  feature-state.json     # per-feature progress
  work/<featureId>/
    evidence/VAL-*__<ts>.json
  handoffs/<ts>__<featureId>__<sessionId>.json
```

You usually only touch:
- `charter.md` (with a normal text editor / Edit tool — to add VAL-* criteria
  and scope/constraints once `charter_manage create` has stubbed it).
- Code under the project root that fulfills the criteria.

Everything else is owned by tools.

## Lifecycle

```
[no charter]
     |
     |  charter_manage action=create { objective, charterId? }
     v
  planning   <-- edit charter.md criteria here
     |
     |  charter_plan action=add_feature  (repeat per feature)
     |  charter_plan action=update_feature  (optional)
     |  subagent({agent:'charter-planner-critic'})
     |  charter_plan action=lock_plan
     v
   active    <-- execute features, record evidence
     |       <-- charter_record action=evidence | action=verify
     |       <-- subagent({agent:'charter-verifier', ...})
     |
     |  charter_manage action=complete  (only when all criteria pass)
     v
  completed
```

`charter_manage action=pause | resume | force_complete | amend_charter` are
escape hatches; use them deliberately.

## Step-by-step workflow

### 1. Create the charter

```
charter_manage action=create { objective: "<one-line intent>", charterId?: "short-slug" }
```

- The tool creates `<cwd>/.pi/charters/<id>/` with a stub `charter.md`,
  empty `plan/`, empty event log, and `state.status: 'planning'`.
- If you omit `charterId`, a UUID is generated. Prefer passing a concise
  slug-style id for readability.
- The session is automatically bound: `state.sessionId` and a reverse pointer
  under `~/.pi/agent/sessions/<sessionId>/charter.json` are written.

### 2. Author the contract

Edit `<cwd>/.pi/charters/<id>/charter.md` directly (Edit tool). Replace the
`<!-- Add VAL-* criteria during planning. -->` placeholder. Each criterion
looks like:

```markdown
### VAL-AUTH-001 — User can sign in with Google OAuth
- verifier: command
- command: bun test tests/oauth-google.test.ts
- timeoutMs: 60000
- requireFreshEvidence: true
```

Verifier kinds:
- `verifier: manual` — a person/subagent decides. Default if not specified.
- `verifier: command` — the tool runs `command` via `/bin/sh -c` with
  `timeoutMs` (default 120000) and 64 KB stdout/stderr capture. Exit 0 = pass.

Also flesh out the `Scope` and `Constraints` sections in `charter.md` if the
stub left them empty.

### 3. Seed the macro plan

For each feature, call:

```
charter_plan action=add_feature {
  charterId,
  id: "f1-pin-deps",
  milestone: "m1-bootstrap",
  order: 1,
  fulfills: ["VAL-BOOT-001", "VAL-BOOT-002"],
  preconditions: [],          // optional, list other feature ids
  body: "Markdown body describing what this feature does and how it satisfies the listed criteria."
}
```

- `id` must match `/^[a-z0-9][a-z0-9_-]*$/i`.
- `fulfills[]` MUST list at least one VAL-* criterion id from `charter.md`.
- The tool writes `<cwd>/.pi/charters/<id>/plan/<featureId>.md` with the
  correct YAML frontmatter and your body. Do not create that file yourself.
- Use `charter_plan action=update_feature` to revise an existing feature (pass
  `id` plus any fields you want to change).

### 4. Critique the plan before locking

```
subagent({
  agent: 'charter-planner-critic',
  prompt: 'Critique charter <id>. Read .pi/charters/<id>/charter.md and plan/.',
  metadata: {
    'pi-charter.projectDir': <cwd>,
    'pi-charter.charterId': '<id>',
  },
})
```

The persona is read-only and emits a structured
`charter-planner-critic verdict: PASS | BLOCK | ADVISORY` with bullet
findings. Resolve every BLOCK before locking.

### 5. Lock the plan

```
charter_plan action=lock_plan { charterId }
```

- Runs in-process checks (uncovered scope, orphan features, cyclic
  preconditions, unknown VAL-* references, missing verifier commands).
- Computes `planDigest` (sha256 of features), writes it to `state.json`,
  appends a `plan_locked` event, transitions `planning → active`.
- Throws `Cannot lock plan because of drift: ...` if anything is off.

### 6. Execute and record evidence

For each feature:

- Do the work (edit code, add tests, run commands).
- Record a manual pass/fail:

  ```
  charter_record action=evidence {
    charterId,
    criterionId: 'VAL-AUTH-001',
    outcome: 'pass' | 'fail' | 'partial',
    summary: '<one line>',
    artifacts: { command: '...', stdoutPath: '...' },   // optional
    featureId?: '<id>',
  }
  ```

- Or run the criterion's command verifier directly:

  ```
  charter_record action=verify { charterId, criterionId: 'VAL-AUTH-001' }
  ```

  The tool runs the criterion's `command` and writes evidence based on exit
  code.

- Prefer delegating verification to the bundled persona:

  ```
  subagent({
    agent: 'charter-verifier',
    prompt: 'Verify VAL-AUTH-001 on charter <id>.',
    metadata: {
      'pi-charter.projectDir': <cwd>,
      'pi-charter.charterId': '<id>',
      'pi-charter.featureId': 'f1-pin-deps',
      'pi-charter.criterionId': 'VAL-AUTH-001',
    },
  })
  ```

  The persona reads the criterion, runs the verifier (or its own checks),
  and calls `charter_record action=evidence` exactly once. The async bridge
  picks up `subagent:async-complete` and appends a `feature_completed` event
  to the charter's `events.jsonl` if the metadata is set.

### 7. Complete

```
charter_manage action=complete { charterId }
```

The completion gate verifies every VAL-* has `outcome: 'pass'` evidence; if
not, it throws and `charter_status` will list the gaps. After it succeeds,
status moves to `completed` and the session is unbound.

## Reading status and drift

```
charter_status { charterId? }
```

Returns:
- `status`, `phase`, `objective`, `budget`.
- `drift`:
  - `uncovered[]` — criteria with no evidence or non-pass evidence.
  - `stuck[]` — features in `in_progress` with no recent update.
  - `stale[]` — pass evidence past `requireFreshEvidence` window.
  - `readyNext[]` — features whose preconditions are satisfied.
- `nextActions[]` — legal next moves (tool + action + hint).
- `guidelines[]` — short reminders for the current status.

Run `charter_status` whenever you are unsure what to do next, after recording
evidence, and before calling `charter_manage action=complete`.

## Delegation

Two bundled internal personas. Both default to `anthropic/claude-sonnet-4.6`.

- **`charter-planner-critic`** — read-only adversarial plan critic. Run BEFORE
  `charter_plan action=lock_plan`. Emits `PASS | BLOCK | ADVISORY` with bullet
  findings citing ids/paths. Resolves uncovered scope, orphan features,
  cyclic preconditions, scope/constraint violations, missing verifier
  commands. Never proposes fixes — only finds problems.

- **`charter-verifier`** — read-only contract-aware verifier. Reads the
  criterion definition in `charter.md`, gathers evidence (no code mutations),
  records exactly one `charter_record action=evidence` entry. Use it instead
  of judging evidence inline.

You SHOULD use these subagents rather than doing planning critique or
verification inline whenever the work fits. The host agent stays in control
and coordinates; the personas do bounded read-only work and return.

## CLI / slash entry points

- `/charter <objective>` and `pi --charter-objective "<text>"` hand the
  objective to the agent via `pi.sendUserMessage`. They DO NOT call
  `charter_manage create` directly — the agent owns charter creation.
- `/charter` bare opens the status surface.
- `/charter status` prints the same formatted status block tools see.
- `/charter pause` and `/charter resume` are lifecycle shortcuts.

## Hooks (advanced)

Four blocking hook events:
- `charter:before_lock_plan`
- `charter:before_complete`
- `charter:before_force_complete`
- `charter:before_amend_charter`

Subscribers receive `{charterId, ...}` and return `{decision: 'allow'}` or
`{decision: 'block', reason}`. A block throws so the FSM never advances when
any subscriber vetoes. This is the integration point for a TUI approver, CI
gate, or compliance check.

## Common pitfalls

- Writing `charter.md` or `plan/*.md` at the repo root. The agent has done
  this — do not. The tools manage these paths.
- Calling `charter_manage action=complete` early. The gate will reject; check
  `charter_status` drift.uncovered first.
- Letting the post-turn evaluator's `on_track` verdict substitute for real
  evidence. The evaluator is a steering signal, not a gate.
- Forgetting `pi-charter.projectDir` in subagent metadata. Without it the
  async bridge cannot locate the per-project charter dir; feature events
  will not be appended.

## Quick reference

| Tool                                  | Purpose                                          |
|---------------------------------------|--------------------------------------------------|
| `charter_manage action=create`        | Open a new charter; sessions auto-bind.          |
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
