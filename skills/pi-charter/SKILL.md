---
name: pi-charter
description: Drive multi-feature work to completion under a durable contract with VAL criteria + evidence. Use for charter_manage/charter_plan/charter_record/charter_status tools, /charter command, --charter-objective flag, .pi/charters/ dirs, or user asks to implement/build/ship something spanning many turns. Skip for single-file edits or quick fixes.
---

# pi-charter

`CONTEXT.md` is the canonical domain-language reference for pi-charter. ADR 0008
keeps the lifecycle and legal next actions in runtime code instead of Markdown.
ADR 0009 keeps Ralph deterministic: Ralph nudges the main agent back into the
same contract, but it does not replace the agent or invent a second evaluator.

## What pi-charter is

A **charter** is an evidence-gated, multi-feature contract between the main
agent and the mission. The contract is complete only when every in-scope
`VAL-*` criterion has pass evidence and completion is not blocked by unresolved
handoff items.

The deterministic Ralph loop is the engine. `charter_status nextActions[]`, the
FSM, drift views, lock-plan gates, evidence gates, handoff gates, reminders, and
completion blockers are runtime-owned. Markdown teaches doctrine and persona
behavior; it does not define legal transitions.

The bundled personas are supporting controls around that engine:

- `charter-planner-critic` drafts and repairs `charter.md`, `criteria.md`, and
  `plan/*.md`, and explains `lock_plan` failures. The actual planner-critic
  gate is deterministic code inside `charter_plan action=lock_plan`.
- `charter-reviewer` checks implemented diffs against the feature plan and the
  worker handoff, then records review evidence.
- `charter-qa` exercises user-facing or runtime-facing surfaces against the
  feature's claimed VALs and records QA evidence.
- `charter-readiness-probe` checks readiness dependencies and records readiness
  evidence before completion.

Planner-critic plus reviewer/QA personas enforce shape and review in practice,
but the source of truth is the runtime contract plus typed evidence.

## File tree

A charter lives under `.pi/charters/<id>/`:

```text
charter.md
criteria.md
plan/<featureId>.md
work/<featureId>/evidence/<ts>/
work/<featureId>/handoffs/<sessionId>.handoff.json
feature-state.json
criterion-state.json
state.json
```

Authored surfaces:

- `charter.md` contains `## Objective`, `## Scope and constraints`,
  `## Mission Boundaries (NEVER VIOLATE)`, and `## Commands`.
- `criteria.md` contains the VAL register. New charters should keep criteria
  here; `loadParsedCharter()` still falls back to legacy `charter.md ## Criteria`.
- `plan/<featureId>.md` contains feature frontmatter (`fulfills`, `category`,
  `kind`, `preconditions`, milestone/order) and the feature body.
- `work/<featureId>/evidence/<ts>/` contains typed evidence and artifacts:
  `evidence.json`, `qa.json / qa.md`, `review.json / review.md`,
  `readiness.json`, `command.json`, and captured artifacts.
- `work/<featureId>/handoffs/<sessionId>.handoff.json` contains the worker's
  typed handoff record.

Evidence uses the dir-per-run layout `work/<feat>/evidence/<ts>/`.
Use paths like `work/<feat>/evidence/<ts>/{evidence.json, qa.md, artifacts...}`.
Do not create new flat criterion-id evidence JSON files; readers only tolerate
that legacy shape for old charters.

Subagent write boundary:

- Subagents may write only under `work/<featureId>/evidence/` and
  `work/<featureId>/handoffs/`.
- Subagents must never write `plan/*.md`, `feature-state.json`,
  `criterion-state.json`, `state.json`, `charter.md`, or `criteria.md`.
- The runtime audits those orchestrator-owned files during subagent runs. If a
  subagent tries to mutate them, the write is rejected with: `Plan is managed by
  the orchestrator; report results via charter_record action=handoff or
  charter_record action=evidence.`

## VAL doctrine

VALs are declarative behavioral assertions, not feature names, task titles, or
implementation steps. The read-aloud test is: someone who has never seen the
codebase should be able to verify this by reading the VAL, the verifier command,
and the produced evidence.

Good VALs:

- `VAL-AUTH-SESSION-PERSISTS`: A user who completes sign-in remains signed in
  after refreshing the dashboard.
- `VAL-CLI-BAD-CONFIG-EXPLAINS-FIX`: When the config file is malformed, the CLI
  exits non-zero and prints the path plus the exact field to repair.
- `VAL-CHARTER-COMPLETE-BLOCKS-UNTRIAGED-HANDOFFS`: Completion rejects while a
  handoff contains non-empty undone work or an untriaged discovered issue.

Bad VALs:

- `VAL-F1`: tautological feature id, not a behavior.
- `VAL-ADD-HANDOFF-SCHEMA`: implementation step, not observable behavior.
- `VAL-TESTS-PASS`: suite health can be evidence, but it is not the user or
  runtime behavior the charter exists to deliver.

Target an M:N relationship between VALs and features: one feature can satisfy
several VALs, and one VAL can need several features. A 1:1 VAL-to-feature ratio
is a planning smell because it usually means criteria are just renamed tasks.
Default VAL ceiling is 8. If the mission truly needs more, use
`charter_manage action=amend_charter` with a rationale before locking.

Every VAL should name pass criteria, plausible failure modes, and a verifier
shape. Prefer deterministic project-level commands (`bun test`,
`bun run check-types`, `bun run lint`, integration smoke commands) over bespoke
per-VAL scripts. Use `scripts/charter-named-test.sh [<test-file>] <phrase>`
instead of bare `bun test -t` to avoid silent 0-match pass.

## Feature doctrine

Every `plan/<featureId>.md` has frontmatter that describes how it participates
in the contract:

```yaml
id: f1-handoff-gate
milestone: m1-contract
order: 1
category: behavior
kind: impl
fulfills:
  - VAL-CHARTER-COMPLETE-BLOCKS-UNTRIAGED-HANDOFFS
preconditions: []
```

Rules:

- `fulfills: [VAL-X, VAL-Y]` lists the VALs the feature claims to advance.
- `category: behavior` must have a non-empty `fulfills[]` list.
- `category: infrastructure` may have an empty `fulfills[]` list for scaffold,
  setup, cleanup, migration, or harness work that supports later behavior.
- `kind: impl | readiness | review | qa` routes the intended persona and the
  expected evidence type.
- The feature body should answer the four-question gate: What does it do? What
  are its boundaries? Where does complexity concentrate? How would an
  independent party verify it works?

`charter_plan action=lock_plan` hard-fails orphan VAL references, duplicate VAL
ownership problems, behavior features with empty `fulfills[]`, feature-id
VAL tautologies, bespoke verifier script paths, and VAL count above the ceiling
unless an amend-charter override exists. It soft-warns on 1:1 VAL-feature shape
and on missing infrastructure features when the plan has at least four features.

## Handoff doctrine

Every worker emits a handoff at the end via `charter_record action=handoff`.
The runtime writes it to `work/<featureId>/handoffs/<sessionId>.handoff.json` and
updates `feature-state.json` with `lastWorkerSessionId` and `lastHandoffPath`.

A handoff records:

- `sessionId`, `featureId`, `agent`, `startedAt`, `completedAt`
- `successState: success | partial | failure`
- `validatorsPassed`, `fulfills[]`
- `whatWasImplemented` with at least 50 characters and enough detail to audit the diff
- `whatWasLeftUndone`
- `verification.commandsRun[]`
- `discoveredIssues[]` with `severity`, `kind`, `description`, optional
  `suggestedFix`, and `triageState`
- `skillFeedback`

Contract implications:

- `whatWasLeftUndone` non-empty means the feature is not done. It should revert
  to `pending` on the next loop until absorbed into follow-up work or cut.
- Evidence with `outcome: partial` or `outcome: fail`, and handoffs with
  `successState: partial` or `successState: failure`, revert the feature to
  `pending`.
- `discoveredIssues` with `triageState: untriaged` block completion until the
  item is triaged.
- Reviewers, QA, and readiness probes must read the latest handoff before
  judging. `readLatestHandoff(projectDir, charterId, featureId)` is the runtime
  helper for code paths that need this lookup.

Completion blocks with `untriaged-handoff-items` until each non-empty undone
item or untriaged issue is either absorbed into a follow-up feature whose plan
body mentions the `sessionId`, or cut with:

```ts
charter_manage({
  action: "amend_charter",
  triage: [{ handoffPath, itemId, decision: "cut", reason }],
})
```

## Lifecycle

1. **Planning.** Create the charter, write the contract surfaces, add features,
   and run planner-critic as a drafting/repair pass.
2. **Lock.** `charter_plan action=lock_plan` runs deterministic hard-fail gates
   and soft warnings. Fix the authored surfaces until lock succeeds.
3. **Active execution.** Implement features, record handoffs, run reviewer/QA/
   readiness personas, and record evidence. Partial/fail results send work back
   to pending instead of pretending it is done.
4. **Milestones complete.** A milestone is only meaningful when its behavior has
   pass evidence and any required review/QA/readiness evidence is present.
5. **Complete.** `charter_manage action=complete` is gated by `val-not-pass` and
   `untriaged-handoff-items`. Every in-scope VAL needs a pass record, and every
   handoff gap must be triaged.

`amend_charter` is the mid-mission tool for adding, cutting, or rescoping the
contract. Use it when the mission changes, when new VAL semantics are needed,
or when a handoff item is deliberately cut. Do not defer known in-mission scope
changes to a future charter just to get completion to pass.

## Planner-critic role

Planner-critic is now a deterministic check enshrined in `lock_plan`, not an LLM
persona alone. The persona named `charter-planner-critic` is useful because it
helps author drafts, explains why `lock_plan` failures fired, and proposes
fixes, but it does not own the gate.

Hard-fail examples owned by `lock_plan`:

- VAL tautology: a VAL description contains feature ids or only restates a
  feature name.
- Verifier shape: project-level commands are expected; bespoke
  `scripts/verify/<val-id>.sh` verifier paths are rejected.
- VAL ceiling: more than 8 VALs requires an explicit amend-charter override.
- Coverage shape: orphan VALs, duplicate VAL conflicts, and behavior features
  without fulfilled VALs reject the lock.

Soft-warn examples:

- 1:1 VAL-feature ratio instead of an M:N contract.
- No infrastructure feature in a plan large enough to need scaffold/setup/cleanup
  work.

## Replan policy

Mid-mission changes update the current charter. If the actual mission changes,
edit `charter.md`, edit `criteria.md`, and add or update features so the locked
contract reflects reality. Replanning inside the current charter is preferred to
creating a vague future charter for work discovered during this one.

Use `amend_charter` when Objective, VAL semantics, Mission Boundaries, or triage
decisions change. Use `charter_plan add_feature` or `update_feature` for feature
shape changes that still serve the same Objective and VAL semantics.

## Planning is the work

Planning is the work: implementation is mostly typing once the charter names the
real outcomes, boundaries, verification, and risks. Do not rush through the
planning phase as ceremony; a weak plan creates noisy status, shallow VALs, and
reviewer churn later.

### Failure modes to catch before lock

- VALs that only say "feature works" instead of naming observable pass criteria,
  failure modes, and the required evidence kind.
- VAL count matching feature count, with no cross-cutting criteria for
  integration, user-facing QA, architecture, commands, or suite health.
- Skipping `charter-planner-critic`, or running it without resolving every
  drafting issue it finds before `lock_plan`.
- Locking while an awaiting-clarification decision, missing dependency, or scope
  ambiguity is still unresolved.
- Treating a critic `BLOCK` as advisory; v2.3 moves hard gates into runtime, so
  `lock_plan` failures must be fixed before the plan can lock.

### What good looks like

- At least one planner-critic drafting pass has run, and its fixes have been
  reflected in `charter.md`, `criteria.md`, feature bodies, or scope constraints.
- Every VAL has explicit pass criteria, known failure modes, and a verifier or
  evidence kind that an independent party can evaluate.
- The charter includes cross-cutting VALs for non-feature outcomes such as
  architecture, commands, QA, integration, or full-suite health.
- Non-trivial work has `library/architecture.md` or an equivalent charter-local
  architecture note before implementation starts.
- `## Commands` declares the build/test/dev/lint/qa commands subagents must use
  verbatim.
- Each feature body answers the four-question gate:
  - What does it do?
  - What are its boundaries?
  - Where does complexity concentrate?
  - How would an independent party verify it works?

### Done planning

Done planning means the pre-lock `charter_status nextActions[]` has no remaining
move except `lock_plan`, and then `charter_plan action=lock_plan` succeeds. If
any other legal next action remains, keep planning.

## Online research delegation

Delegate online research when the plan depends on current ecosystem facts the
main agent should not guess. Indicators that research is needed include smaller or newer ecosystems such as Convex, Drizzle, and Hono; SDK-heavy integrations such as Vercel AI SDK, Stripe Elements, and Supabase Auth; or prompts like "Can this API do X?", "Are there breaking changes?", "Should I verify this behavior?", and "Find current docs".

Do not spend research budget on foundational, slowly evolving knowledge unless
the objective names a version-specific risk. React, PostgreSQL, Express, and
standard-library behavior normally need local docs or code recon, not web
research.

Store distilled, reusable findings in `library/<topic>.md`. Store raw research notes, citations, copied snippets, and uncertainty trails in `library/research/<topic>.md`. Keep raw research out of `library/` so the critic and future agents can distinguish settled project guidance from source material that still needs interpretation.

## Delegation discipline

Main-agent context is the scarce resource. Anything bounded or read-only goes to
a subagent, but subagents return evidence and handoffs instead of mutating the
orchestrator-owned plan.

| Job | Subagent |
| --- | --- |
| Plan drafting, lock failure explanation, repair proposals | `charter-planner-critic` |
| Per-feature code review + evidence write | `charter-reviewer` |
| Per-milestone/user/runtime QA + evidence write | `charter-qa` |
| Readiness probe verification + evidence write | `charter-readiness-probe` |
| Code/file recon, symbol tracing | `explorer` |
| External research (vendor docs, library API) | `explorer` |
| Bounded implementation | `fixer` |
| Hard-debug direction | `oracle` (advisory) |

The four charter personas are `scope: internal` and may not appear in
`subagent({action:'list'})`; invoke them by name when a charter is bound.

## Capture recipes

Planning QA briefs live under `qa-briefs/<surface>.md`, not `qa/`. For QA
capture recipe selection, start with `skills/pi-charter/references/qa.md`. That
shelf routes terminal, browser, desktop, mobile, HTTP/API, real-time,
database, logs/processes, generated-file, visual-regression, and reproducibility
capture surfaces. It also documents which recipes are verified and which are
stubs.

## Evidence and command robustness

Each v2 persona writes a typed JSON evidence file and calls
`charter_record action=evidence evidenceFile=<path>` itself. If you record
evidence directly for multiple criteria, use the batch shape:

```ts
charter_record({
  action: "evidence",
  entries: [
    { criterionId: "VAL-AUTH-001", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
    { criterionId: "VAL-AUTH-002", featureId: "f1", outcome: "pass", summary: "...", because: "..." },
  ],
})
```

Use `scripts/charter-named-test.sh [<test-file>] <phrase>` instead of bare
`bun test -t` to avoid silent 0-match pass. Example:

```bash
bash scripts/charter-named-test.sh tests/v21-skill-md-update.test.ts 'SKILL.md references qa-briefs'
```

Command validators should come from `charter.md ## Commands` or from the VAL's
own verifier line. Do not invent bespoke verifier behavior in persona prose.

## Reading status

Read `charter_status` whenever you are unsure, after recording evidence, and
before completing. It returns drift, ready features, completion blockers, and
`nextActions[]`. Follow `nextActions[]`; do not guess transitions from this
Markdown file.

If a Ralph reprompt appears, treat it as a nudge to re-read `charter_status` and
continue the legal runtime path. Only `charter_manage action=complete` can finish
the charter.

## Tactical tasks vs. charter features

Charter features are durable units in the mission contract. Tactical trackers
such as `task_manage` are per-turn scratch. A tactical task that spans the whole
charter is a smell: promote it to a feature, split it, or record it as a handoff
item with honest triage.

## Common pitfalls

- Stopping after planning to ask whether to implement. The locked plan is the
  authorization.
- Treating a partial handoff as done. `partial` and `failure` return the feature
  to pending.
- Writing `plan/*.md` or `*-state.json` from a subagent. The orchestrator owns
  those files.
- Recording evidence without `because`. Weak evidence is hard to audit and can
  fail trust ranking.
- Hiding undone work by leaving `whatWasLeftUndone` empty. If the diff is
  incomplete, the handoff must say so.
- Completing before handoff triage. `untriaged-handoff-items` is a real gate.

## Quick reference

| Tool | Purpose |
| --- | --- |
| `charter_manage action=create` | Open a charter; session auto-binds. |
| `charter_manage action=pause/resume` | Lifecycle escape hatch. |
| `charter_manage action=complete` | Gated finish; requires VAL pass evidence and triaged handoff items. |
| `charter_manage action=force_complete` | Manual override; subject to hook. |
| `charter_manage action=amend_charter` | Add/cut/rescope contract or triage cut handoff items. |
| `charter_plan action=view` | Inspect criteria, features, drift, and ready work. |
| `charter_plan action=add_feature` | Write a managed `plan/<id>.md`. |
| `charter_plan action=update_feature` | Revise a managed feature file. |
| `charter_plan action=lock_plan` | Deterministic planner-critic gates + transition to active. |
| `charter_record action=evidence` | Append pass/fail/partial evidence. |
| `charter_record action=verify` | Run a criterion's command verifier. |
| `charter_record action=handoff` | Write `work/<featureId>/handoffs/<sessionId>.handoff.json`. |
| `charter_status` | Status + drift + blockers + `nextActions[]`. |
