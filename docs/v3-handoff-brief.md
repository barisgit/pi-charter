# pi-charter v3 — handoff brief

Status: lock-list complete, doctrine committed (96f0248 + the v3 ADR pair), ready for implementation.

## What v3 is

A return to ADR-0005's stance: the agent is the loop driver. v2.x grew a per-feature scheduler, a planning state, a persona orchestration layer, a coverage gate, a handoff store, a reminders bridge, and ~12 transition reasons. v3 keeps the lifecycle FSM, the evidence ledger, the trust gates, and the Ralph reprompt — and removes everything else.

Read these first, in order:

1. `CONTEXT.md` (post v3 commit) — canonical glossary
2. `docs/adr/0010-split-charter-md-and-criteria-md.md`
3. `docs/adr/0011-three-tool-llm-surface.md` (supersedes ADR-0003)
4. `docs/adr/0012-v3-runtime-boundary.md` (supersedes ADR-0008)
5. `docs/adr/0005-agent-is-the-loop-driver.md` (still in force; v3 narrows but does not contradict it)

## Objective

Refactor pi-charter src/ from the v2.3 surface into the v3 surface described in ADR-0011 + ADR-0012. Single-user, no migration burden. Old charters under `.pi/charters/<id>/` may be left as-is; v3 reads only the live shape.

## Persisted shape

```
.pi/charters/<id>/
├── charter.md            # authored: Objective, Scope, Mission Boundaries, Commands
├── criteria.md           # authored: ## Milestone headings, ### VAL-* leaves
├── REPORT.md             # authored: scaffolded at first `complete` attempt
├── state.json            # runtime: id, status, createdAt, updatedAt, lastToolWriteAt
├── criterion-state.json  # runtime: { VAL-*: { outcome, evidence[] } }, lastToolWriteAt
└── work/<milestoneId>/evidence/<ts>/   # capture artifacts
```

## FSM

States: `active`, `paused`, `completed`, `abandoned`.

Transitions:
- `create` → active
- `pause` (active → paused)
- `resume` (paused → active)
- `complete` (active → completed, gated)
- `abandon` (active or paused → abandoned, reason required)

No planning, no review, no budget_limited, no lock_plan, no force_complete, no amend_charter, no ask.

## Tools (3 total)

### `charter`

Lifecycle. Actions:
- `create({ objective, budget?, idempotencyKey? })` → returns charterId + nextActions
- `pause({ reason? })`
- `resume({ acknowledgeClarification? })`
- `complete()` — gated: every VAL pass + fresh evidence + reviewer-where-required + REPORT.md gate
- `abandon({ reason })` — reason required

### `charter_record`

Writes. Actions:
- `evidence({ entries: [{ criterionId, outcome, summary, because?, source, recordedBy?, details?, artifacts? }] })` — manual or batch; atomic per call
- `verify({ criterionId, timeoutMs? })` — runs the matching `## Commands` entry, parses exit, stamps evidence

### `charter_status`

Read-only. Returns:
- per-VAL outcomes
- completion blockers
- next non-pass VAL (advisory)
- milestone groupings
- `lastToolWriteAt < file mtime` drift warnings
- `nextActions[]`

## Trust gates

- `requireFreshEvidence` — per-VAL flag in criteria.md; passing evidence must be newer than last src/ change
- `because` — required on `source: manual` evidence rows
- `requireReviewSubagent` — per-VAL flag; satisfied by any `source: subagent` evidence row with non-empty `recordedBy`. Zero bundled personas; user invokes their own.

## Soft surfaces (status output, advisory only)

- Milestone artifact reminder when a milestone closes without a `work/<milestoneId>/evidence/` capture
- `lastToolWriteAt` drift warning when a sidecar's file mtime is newer than the last tool write

## REPORT.md scaffold

Created on first `complete` attempt. Three sections:
- `# <Title>` — prefilled from charter.md
- `## Objective` — prefilled from charter.md
- `## Outcome` — empty
- `## Notes` — empty

Completion gate = non-empty content under every heading.

## What dies

Files:
- `features.md`
- `plan/<featureId>.md`
- `feature-state.json`
- `LEGACY_QA_BRIEFS_DIR` references, `qa/` flat fallback walker (already cut in 2bab1a1b m1-purge)
- `library/architecture.md` requirement (was advisory; remove from doctrine)

Schema fields:
- `fulfills[]`, `preconditions[]`, `category`, `kind`
- `planDigest` in state.json
- `triage[]` in state.json (handoff store gone)

Actions:
- `charter_manage` (renamed to `charter`)
- `lock_plan`, `force_complete`, `amend_charter`, `ask`
- `charter_plan` namespace entirely (no `view`, no `add_feature`, no `update_feature`, no `lock_plan`)
- `charter_record action=handoff`, `charter_record action=handoff_apply`

Concepts:
- Feature (as both file and decomposition layer)
- Macro DAG, ready-next-feature computation, coverage gate
- Planning state, review state, budget_limited state
- Bundled personas (charter-planner-critic, charter-qa, charter-readiness-probe, charter-reviewer, charter-verifier — all 5 directories removed)
- Typed evidence variants (command|review|qa|readiness) — collapse to one flat Evidence row
- Reminders bridge (12 call sites + pi-reminders channel emit)

## What survives unchanged

- TypeBox schemas, atomic temp-file writes, lazy state loading
- Status widget basics
- Slash command parsing
- Decision-control hook event shape (`charter.transition.requested`)
- Metadata passthrough on subagent spawn (used to populate `recordedBy`)
- Ralph reprompt service (Ralph stays a deterministic reprompt; debounce + min-interval + self-heal regression test from b56 stays)
- Structured logging from m2-logging (lifecycle transitions, verifier dispatch, completion blockers, ralph trace at debug)

## Implementation order (suggested)

A single v3 charter, not a bootstrap+sweep split. Eat own food.

1. **Author v3 charter.md + criteria.md.** Use the v3 shape. Milestones: m0-tools, m1-fsm, m2-decomp, m3-personas-out, m4-report, m5-status-cleanup.
2. **m0-tools.** Rename `charter_manage` → `charter`. Drop `lock_plan`/`force_complete`/`amend_charter`/`ask` actions. Drop `charter_plan` namespace. Drop `charter_record action=handoff`/`handoff_apply`.
3. **m1-fsm.** Collapse FSM to 4 states. Remove planning/review/budget_limited from every enum, UI hint, and status output. Remove planDigest.
4. **m2-decomp.** Remove Feature concept end-to-end: features.md, plan/<featureId>.md, feature-state.json, fulfills[], preconditions[], category, kind, ready-next-feature computation, coverage gate. criteria.md becomes the only decomposition source. Status output groups VALs by `##` milestone heading.
5. **m3-personas-out.** Delete `agents/*` directory. Remove every reference to specific persona names from src/ and SKILL.md. `requireReviewSubagent` checks for any subagent-sourced evidence row with non-empty `recordedBy`.
6. **m4-report.** Implement REPORT.md scaffold on first `complete` attempt. Gate `complete` on non-empty content under every heading.
7. **m5-status-cleanup.** Add `lastToolWriteAt` field to both sidecars; surface drift warning in status. Add milestone artifact reminder. Remove typed evidence variants from the schema — one flat Evidence row.

After each milestone: `bun test` + `bun run check-types` green. Record evidence.

## Verification plan

- Per-milestone: full suite green (`bun test`), types clean (`bun run check-types`), and a manual smoke against the live charter.
- Final: end-to-end create → record → complete cycle on a throwaway charter. Inspect REPORT.md scaffold. Inspect criterion-state.json. Inspect that lastToolWriteAt drift warning surfaces when a sidecar is hand-edited.

## Out of scope

- Migrating old charter directories under `.pi/charters/`
- Cross-project mission dashboard
- TOML/JSON/YAML transition graphs
- TUI changes beyond status output
- `.pi/charters/` → `.charters/` directory move (user flagged future; not v3)

## Governing principle

Think 100x before adding anything. The right v3 is the one that survives by virtue of having nothing to delete.
