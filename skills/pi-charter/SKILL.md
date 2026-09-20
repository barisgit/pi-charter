---
name: pi-charter
description: "Create, list, inspect, pause, resume, complete, or abandon durable Pi charters; author objectives and phases, record verification evidence, handle recovery pauses, and curate REPORT.md. Use for multi-turn resumable work or explicit charter requests; skip quick single-turn fixes."
---

# pi-charter

Use this skill for durable, multi-turn, resumable work or when the user explicitly requests a charter. Work normally for quick fixes.

`CONTEXT.md`, ADR-0016 as amended by ADR-0017, `AGENTS.md`, and `src/domain/template.ts` are binding. Earlier criterion-based docs are historical where they conflict.

## Create only when ready

Create after the authorized outcome is clear enough to begin:

```ts
charter({ action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon", id?, objective?, note? })
```

Follow returned `nextActions[]`; do not memorize lifecycle legality.

A session has at most one active or paused charter. Complete or abandon it before creating another. Sub-slices belong in phases or pi-dag-tasks, never sibling charters. Mutations target the bound charter; an unbound session can pick up a paused charter by resuming it with an explicit id.

The Objective is the durable completion contract, not a task title. Preserve the user's intent. You may add constraints, verification expectations, and report requirements only when the user authorized them. Never change or narrow the request while making it more detailed.

## Author the charter

After creation, edit `.charters/<id>/charter.md` directly.

- Keep `# Objective` substantial enough to survive compaction, handoff, or agent replacement.
- Add `## References` when specs, plans, ADRs, docs, or code are durable sources of authority. State each source's role.
- Add `## Scope` only to clarify authorized in/out boundaries.
- Phases are fully optional; new charters have an empty `## Phases` section with no scaffold.
- Add phases only when they help explain the route. Do not invent a quota, dependency graph, acceptance checklist, or planning state.
- Put progress notes and evidence links in indented Markdown beneath the relevant phase.

Canonical grammar:

```md
# Objective

Ship the approved account recovery flow without changing login behavior. Verify the real browser flow at desktop and mobile widths, and deliver a reviewable report with the captured UI evidence.

## References

- [Recovery specification](../../docs/recovery.md) — behavior authority

## Scope

Password recovery UI and API integration only. Login and registration are unchanged.

## Phases

1. Confirm recovery boundaries — done
   Confirmed the approved flow and existing login boundaries.
2. Implement — done
   Added the recovery form and token exchange.
3. Verify — current
   - Desktop result: ![Recovery confirmation with the return-to-login action](work/recovery-desktop.png)
   - Mobile flow: [recording](work/recovery-mobile.mp4)
```

The optional exact suffix is `— upcoming`, `— current`, or `— done`. If no phase is explicitly current, the first unfinished unmarked phase is current by inference; other unmarked phases are upcoming. Unknown Markdown is inert, and parser problems become warnings.

A phase is a progress narrative. It is not a criterion, tactical task, evidence schema, freshness unit, dependency, or completion gate. A charter can complete with zero phases.

## Work and verify

1. Re-read the Objective and authoritative References before consequential work.
2. Use phases to explain the approach and current progress, not to duplicate a todo list.
3. Implement normally. Use pi-dag-tasks for tactical steps when needed.
4. Verify the real outcome. For user-visible behavior, exercise it as a user would.
5. Capture screenshots or recordings at verification time under `.charters/<id>/work/`.
6. Inspect artifacts before embedding or linking them from a phase body.
7. Re-verify only when the actual change calls earlier evidence into question. There is no global source-change invalidation.

A shared reminder periodically restates the active Objective and current phase, if any, to check that the work still serves the requested outcome.

A failed check ends that verification pass, not the charter lifecycle. Fix and verify again. Pause only when work intentionally stops or needs a user decision.

Do not create artificial screenshots at report time. There is no artifact count gate. One useful recording can prove more than ten decorative files.

## Handle Ralph recovery

Ralph continues only when the root agent and async subagents are idle. Treat a recovery prompt as a signal to inspect the Objective, recent attempts, evidence, and blockers before choosing a different move.

The fifth actual Ralph send within rolling fifteen minutes is recovery. If another eligible activation arrives at or before the five-minute warning boundary, the runtime pauses before sending. Quiet time does not trigger a pause. Compaction and file edits do not reset history.

After a guard pause, only the user can reset it with explicit `/charter resume`. Do not try to bypass it with the `charter` tool. The guard does not authorize killing unrelated jobs.

## Complete and curate REPORT.md

Before completion:

1. Audit the complete Objective, including constraints, verification expectations, and report requirements.
2. Check each external Reference that has authority over the result.
3. Curate REPORT.md as the reviewable account of what changed, why it meets the Objective, and what the captured artifacts demonstrate. Embed relevant captured images beside the claims they support, with captions identifying the observed state; link recordings and raw logs. Use focused code/diffs, schemas, or diagrams to explain changes that prose would obscure. Distinguish explanatory illustrations from verification evidence.
4. Supply a concise completion note that states why the Objective is met.

Completion can generate REPORT.md when it is missing; it does not require a deliberately failed scaffold call. If REPORT.md is already curated, completion preserves it. The existing `charter:before_complete` hook still decides whether the transition may proceed.

Phase count and status do not gate completion. Neither do freshness, evidence counts, or screenshot quotas. Completion is worker judgment grounded in the Objective and observed result.

Completing a charter is a point to reassess, not a trigger for the next one. Before creating another, check whether it still serves the requested outcome or merely continues the sequence.

## Legacy charters

A `file-interface` charter is read-only history. It may appear in `/charters`, but you cannot edit, resume, complete, or migrate it. Start a new charter for continued work and reference the old charter when useful.
