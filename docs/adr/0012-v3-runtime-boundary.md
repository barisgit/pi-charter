# pi-charter v3 runtime boundary

Status: accepted; supersedes ADR-0008

## Decision

The pi-charter v3 execution model: runtime code owns the lifecycle FSM, evidence ledger, trust gates, status output, and Ralph idle reprompt. Markdown (`charter.md`, `criteria.md`, `skills/pi-charter/SKILL.md`) carries the authored contract and the agent-coaching patterns. The agent — not pi-charter, not a bundled persona — decides how to execute the charter on each turn.

## What's persisted

- Authored: `charter.md` (Objective, Scope and constraints, Mission Boundaries, Commands), `criteria.md` (milestones as `##` headings, VALs as `### VAL-*` headings with trust-gate flags), `REPORT.md` (scaffolded at first `charter complete` attempt).
- Runtime sidecars: `state.json` (lifecycle + `lastToolWriteAt`), `criterion-state.json` (VAL outcomes and evidence arrays + `lastToolWriteAt`).
- Captures: `work/<milestoneId>/evidence/<ts>/` for qa shelf artifacts.

## FSM

Four states: `active`, `paused`, `completed`, `abandoned`. No planning, no review, no budget_limited. LLM-callable transitions: `create` → active, `pause` (active → paused), `resume` (paused → active), `complete` (active → completed, gated), `abandon` (active or paused → abandoned, reason required).

## Personas

Zero bundled. The trust gate `requireReviewSubagent` is satisfied by evidence from any subagent (`source: subagent` with non-empty `recordedBy`), not by a specific bundled persona. SKILL documents patterns without naming personas; users invoke their own.

## Persisted decomposition layers

`Objective → Milestone → VAL`. No features. The agent decides in flight what's parallelisable and how to chunk work; nothing in the charter graph encodes that.

## Trust gates

- `requireFreshEvidence` — evidence must be newer than last `src/` change
- `because` required on `source: manual` evidence
- `requireReviewSubagent` — at least one passing evidence row with `source: subagent` and non-empty `recordedBy`

## Soft surfaces (status output, advisory only)

- Milestone artifact reminder when a milestone closes without a captured artifact
- `lastToolWriteAt < file mtime` warning ("sidecar edited out-of-band; use charter_record")

## What got cut from v2.3

- Features (features.md, plan/&lt;featureId&gt;.md, feature-state.json, fulfills[], preconditions[], category, kind)
- Coverage gate at lock (no lock action; markdown shape validates on every read)
- Planner-critic gates at lock (tautology, dup-ID, missing-section) — re-runnable as a SKILL pattern, not enforced
- Handoff store (work/&lt;feat&gt;/handoffs/, HandoffRecord schema, triage gate)
- Reminders bridge (12 call sites + pi-reminders channel emit)
- Typed evidence variants (command|review|qa|readiness) — one flat Evidence row
- Library/architecture.md requirement
- planDigest in state.json
- Force-complete escape hatch

## Rationale

ADR-0008's premise — "code owns the loop, Markdown carries doctrine" — survives. v3 narrows what "the loop" means: lifecycle FSM + evidence ledger + trust gates + Ralph reprompt. Removed concerns: per-feature scheduler, persona orchestration, planning-phase gate, handoff coordination. Those existed because v2.x tried to model a multi-actor assembly line; v3 returns to the original ADR-0005 stance that "the agent is the loop driver."

## Out of scope (still)

- Auto-spawn scheduler
- Cross-project mission dashboard
- TOML/JSON/YAML transition graphs
- New persisted statuses or checkpoint cursors
