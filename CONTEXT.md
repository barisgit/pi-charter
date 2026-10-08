# pi-charter Context

pi-charter keeps a user's authorized Objective available when durable agent work needs to continue. It is a quiet, opt-in backstop, not a planning or progress system.

This file defines domain language, not TypeScript structure. ADR-0018 records the current model; ADR-0016 and ADR-0017 contribute the surviving session-binding, lifecycle, legacy, and guard rules.

## Language

### Core identity

**Charter**
A durable record of one authorized Objective, bound to the session doing the work.
_Avoid_: Goal, mission, contract, quest, plan

**charter.md**
The single authored file: the Objective, optional References and Scope, and optional notes.
_Avoid_: criteria.md, task list, evidence ledger

**Objective**
The full outcome the user authorized, including constraints, verification expectations, and requested deliverables. It may gain authorized detail but is never summarized, changed, or narrowed.
_Avoid_: Task title, prompt summary, criterion container

**References**
Optional durable pointers to external sources of authority, with each source's role.
_Avoid_: Context dump, mutable progress

**Scope**
Optional boundaries that clarify what is in and out without narrowing the Objective.
_Avoid_: Mission boundaries, non-authorized constraints

**Notes**
Ordinary Markdown the worker keeps in `charter.md` when useful, outside the Objective. Notes carry no status and gate nothing; older phase lists are notes.
_Avoid_: Phase, checklist, progress tracker

**CharterId**
A timestamp-sortable identifier of the form `<YYYYMMDD-HHMMSS>-<slug>`.
_Avoid_: UUID, session id, goal id

### Lifecycle

**Session binding**
A session's link to at most one active or paused charter. Mutations target only the bound charter; an unbound session may pick up a paused charter by resuming it explicitly.
_Avoid_: Sibling charter

**Active**
The working state from creation until the charter pauses or ends. There is no planning or review state.
_Avoid_: Running, planning, review

**Paused**
A non-terminal interruption that keeps the binding, chosen by the worker or imposed by a guard pause.
_Avoid_: Abandoned, awaiting-user state

**Completed**
The terminal state reached when the worker judges the Objective met, gives a completion note, and the completion hook allows.
_Avoid_: All phases done, fresh passes

**Abandoned**
The terminal state for work intentionally stopped without delivering the Objective. A reason is required.
_Avoid_: Failed verification, deleted

### Continuation

**Ralph**
The idle-only continuation: when the root worker and async subagents are idle, it restates the Objective with any References and Scope and asks the worker to continue or finish. It does not plan, evaluate, schedule workers, or run checks.
_Avoid_: Auto worker, evaluator, scheduler, periodic reminder

**Ralph activation**
An actual continuation message sent by Ralph. Guard accounting counts activations, not turns, compactions, or edits.

**Recovery prompt**
The message that replaces the fifth Ralph activation in a rolling fifteen-minute window, asking the worker to recover deliberately instead of repeating the loop.

**Guard pause**
A pause applied before the next eligible activation when it arrives at or before the five-minute warning boundary. Only an explicit user `/charter resume` clears it.

### Completion and history

**Worker judgment**
The worker's reasoned decision that the Objective and its References are satisfied. pi-charter records it; it does not prove it.

**Completion note**
The worker's concise reason the Objective is met, required to complete.
_Avoid_: Generated report, audit checklist

**REPORT.md**
An optional report file, written only when the Objective asks for one. pi-charter never generates or overwrites it.
_Avoid_: Completion gate, mandatory report

**Journal**
The append-only history of lifecycle transitions and Ralph activations. Older journals may also hold `charter_file_changed` entries; nothing writes them now.

**Legacy charter**
A charter from the file-interface schema: visible in the dashboard as read-only history, never resumed or migrated.
_Avoid_: Migrated charter, compatibility mode

**Tactical task**
A short-lived execution step managed outside pi-charter.
_Avoid_: Phase, charter task

## Relationships

- One session binds to at most one active or paused Charter.
- The Objective is the completion contract; notes, artifacts, and reports serve it but never replace it.
- The worker chooses how to act and verify. pi-charter persists lifecycle, reads the current `charter.md` on demand, and supplies guarded Ralph continuation.
- Older writable charters keep their authored text unchanged; their phase lists read as notes.
- Legacy charters are read-only history; continued work starts in a new charter.

## Example dialogue

> **Dev:** "Should I break the request into phases or criteria before I start?"
>
> **Domain expert:** "No. Record the authorized outcome in the Objective and work normally. Use pi-dag-tasks for steps."
>
> **Dev:** "Do I have to write REPORT.md to complete?"
>
> **Domain expert:** "Only when the user asked for a report. Completion needs your concise note and the hook's approval."
