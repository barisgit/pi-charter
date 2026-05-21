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
3. EXECUTE   per feature: implement -> charter-reviewer / charter-qa / charter-readiness-probe -> evidence recorded
4. COMPLETE  charter_manage action=complete    (gated on pass evidence)
```

Once the plan is locked, do not stop between features to ask "should I
keep going?". The objective + locked plan is your authorization to ship.

## Planning is the work

Planning is the work: implementation is mostly typing once the charter
names the real outcomes, boundaries, verification, and risks. Do not
rush through the planning phase as ceremony; a weak plan creates noisy
status, shallow VALs, and reviewer churn later.

### Failure modes to catch before lock

- VALs that only say "feature works" instead of naming observable pass
  criteria, failure modes, and the required evidence kind.
- VAL count matching feature count, with no cross-cutting criteria for
  integration, user-facing QA, architecture, commands, or suite health.
- Skipping `charter-planner-critic`, or running it without resolving
  every `BLOCK` finding.
- Locking while an awaiting-clarification decision, missing dependency,
  or scope ambiguity is still unresolved.
- Treating a critic `BLOCK` as advisory because the implementation path
  feels obvious.

### What good looks like

- At least one critic round has run, and every `BLOCK` has been resolved
  in `charter.md`, feature bodies, or scope constraints.
- Every VAL has explicit pass criteria, known failure modes, and a
  verifier/evidence kind that an independent party can evaluate.
- The charter includes cross-cutting VALs for non-feature outcomes such
  as architecture, commands, QA, integration, or full-suite health.
- Non-trivial work has `library/architecture.md` (or an equivalent
  charter-local architecture note) before implementation starts.
- `## Commands` declares the build/test/dev/lint/qa commands subagents
  must use verbatim.
- Each feature body answers the four-question gate enforced by
  `charter-planner-critic`: What does it do? What are its boundaries?
  Where does complexity concentrate? How would an independent party
  verify it works?

### Done planning

Done planning means the pre-lock `charter_status nextActions[]` has no
remaining move except `lock_plan`, and then `charter_plan action=lock_plan`
succeeds. If any other legal next action remains, keep planning.

## Online research delegation

Delegate online research when the plan depends on current ecosystem
facts the main agent should not guess. Indicators that research is
needed include smaller or newer ecosystems such as Convex, Drizzle, and
Hono; SDK-heavy integrations such as Vercel AI SDK, Stripe Elements, and
Supabase Auth; or prompts like "Can this API do X?", "Are there breaking
changes?", "Should I verify this behavior?", and "Find current docs".

Do not spend research budget on foundational, slowly evolving knowledge
unless the objective names a version-specific risk. React, PostgreSQL,
Express, and standard-library behavior normally need local docs or code
recon, not web research.

Store distilled, reusable findings in `library/<topic>.md`. Store raw research notes, citations, copied snippets, and uncertainty trails in
`library/research/<topic>.md`. Keep raw research out of `library/` so the
critic and future agents can distinguish settled project guidance from
source material that still needs interpretation.

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
| Per-feature code review + evidence write     | `charter-reviewer`        |
| Per-milestone agentic QA + evidence write    | `charter-qa`              |
| Readiness probe verification + evidence write| `charter-readiness-probe` |
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

Each v2 persona (reviewer / qa / readiness-probe) writes a typed JSON evidence file and calls `charter_record action=evidence evidenceFile=<path>` itself.
Evidence and its artifacts use the v2.1 dir-per-run layout:

```
work/<feat>/evidence/<ts>/
  evidence.json          # canonical charter_record evidence
  qa.json / qa.md        # QA machine record + human narrative, when applicable
  review.json / review.md
  readiness.json
  command.json
  artifacts...
```

Use paths like `work/<feat>/evidence/<ts>/{evidence.json, qa.md, artifacts...}`.
Do not create new flat `<criterionId>__<ts>.json` evidence files; readers only
tolerate that shape for legacy charters.
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
v2 personas record typed evidence via `evidenceFile`), `hook` / `prompt` (advanced).

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
3. For each feature, dispatch the matching v2 persona (`charter-reviewer` for code review, `charter-qa` for milestone agentic QA, `charter-readiness-probe` for readiness probes)
   (async by default) with `featureId` + `criterionId` in metadata. It
   runs the verifier or its own equivalent checks and writes one
   `charter_record action=evidence`.
4. Move to the next feature. Loop until `drift.uncovered: []`.

### Capture recipes

Planning QA briefs live under `qa-briefs/<surface>.md`, not `qa/`. For QA
capture recipe selection, start with `skills/pi-charter/references/qa.md`.
That shelf routes terminal, browser, desktop, mobile, HTTP/API, real-time,
database, logs/processes, generated-file, visual-regression, and
reproducibility capture surfaces.

### Verifier robustness

Use `scripts/charter-named-test.sh [<test-file>] <phrase>` instead of bare
`bun test -t` to avoid silent 0-match pass. Example:

```
bash scripts/charter-named-test.sh tests/v21-skill-md-update.test.ts 'SKILL.md references qa-briefs'
```

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
verifier inline, but prefer the v2 reviewer/qa personas for context hygiene.

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
- **Verifying inline** instead of delegating to the matching v2 persona (charter-reviewer / charter-qa / charter-readiness-probe).
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
| `charter-reviewer`       | Per-feature code review + typed evidence. Async by default. |
