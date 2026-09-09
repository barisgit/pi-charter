# pi-charter Context

pi-charter keeps a user's objective present during durable agent work. The objective is the completion contract. Lightweight phases explain the route through the work; they do not replace the objective or prove completion.

This file defines domain language, not TypeScript structure. ADR-0016 records the redesign.

## Language

### Core identity

**Charter**
A binding document that authorizes and constrains an agent run. It carries one substantial Objective, optional References and Scope, and an emerging account of Phases.
_Avoid_: Goal, mission, contract, quest

**charter.md**
The single authored file. The agent edits it directly as understanding and progress change.
_Avoid_: criteria.md, task list, evidence ledger

**Objective**
The full completion contract authorized by the user: intended outcome, why it matters, constraints, verification expectations, and report requirements. An agent may add authorized constraints or verification and reporting detail. It must not change or narrow the user's intent.
_Avoid_: Task title, prompt summary, criterion container

**References**
Optional durable pointers to external sources of authority, with each source's role. The worker audits them before completion.
_Avoid_: Context dump, mutable progress

**Scope**
Optional boundaries that clarify what is in and out without replacing or narrowing the Objective.
_Avoid_: Mission boundaries, non-authorized constraints

**Phase**
A numbered, lightweight description of an emerging part of the work. A phase has a title, optional body, and an upcoming, current, or done presentation status. It may include links to evidence captured while verifying. Phases are not acceptance criteria, dependencies, gates, milestones, or tactical tasks.
_Avoid_: Criterion, VAL, checklist item, work package

**Explore phase**
The one initial phase in every new charter. It is current by inference until the agent develops the next useful phases from the work.
_Avoid_: Planning state, discovery gate

**CharterId**
A timestamp-sortable identifier of the form `<YYYYMMDD-HHMMSS>-<slug>`.
_Avoid_: UUID, session id, goal id

### Lifecycle

**Active**
The execution state from creation until the charter pauses or reaches a terminal state. There is no separate planning or review state.
_Avoid_: Running, planning, review

**Paused**
A non-terminal interruption that preserves the charter binding. A worker may pause for a user decision. The Ralph guard may also pause a repeating idle loop.
_Avoid_: Abandoned, awaiting-user state

**Completed**
The terminal state reached when the worker judges the Objective met, provides a concise completion note, curates the report, and the completion hook allows. Phase count and phase status do not decide completion.
_Avoid_: All phases done, fresh passes

**Abandoned**
The terminal state for work intentionally stopped without delivering the Objective. A reason is required.
_Avoid_: Failed verification, deleted

### Loop

**Ralph**
The idle continuation mechanism. When the root worker and async subagents are idle, Ralph asks the worker to inspect the Objective, evidence, and current situation and choose the next move. Ralph does not plan, evaluate, schedule workers, or run checks.
_Avoid_: Auto worker, evaluator, scheduler

**Ralph activation**
An actual continuation message sent by Ralph. Guard accounting follows activations, not turns, compactions, or file edits.

**Recovery prompt**
The message that replaces the fifth normal Ralph activation in a rolling fifteen-minute window. It asks the worker to recover deliberately instead of repeating the same loop.

**Guard pause**
A runtime pause before the next eligible activation when it arrives at or before the five-minute warning boundary. Quiet time alone never pauses a charter. Only an explicit user `/charter resume` clears a guard pause and its activation history; a tool resume cannot bypass it.

### Evidence and delivery

**Worker judgment**
The worker's reasoned decision that the Objective and its external authorities have been satisfied. pi-charter records and presents this judgment; it does not manufacture a proof system around it.

**Verification artifact**
A screenshot, recording, output, or other file captured while verifying the real result. User-visible work should be exercised as a user would exercise it. Relevant artifacts are linked from phase bodies and later curated into the report.
_Avoid_: Retroactive screenshot, artifact quota

**REPORT.md**
The reviewable, artifact-rich account of what was delivered and why it satisfies the Objective. It curates evidence created during verification. Completion preserves an already curated report.
_Avoid_: Generated checklist, evidence creation step

**Journal**
The append-only history of lifecycle and meaningful whole-file changes. It is history, not a second authored state model.

**Legacy charter**
A charter from the prior file-interface schema. It remains visible in the dashboard as read-only history. It cannot resume or mutate; continued work starts in a new charter.
_Avoid_: Migrated charter, compatibility mode

**Tactical task**
A short-lived execution step managed outside pi-charter.
_Avoid_: Phase, charter task

## Relationships

- One session binds to at most one active Charter.
- `charter.md` contains the Objective, optional References and Scope, and zero or more Phases.
- The Objective carries the completion contract. Phases communicate the route and current progress.
- The worker chooses how to act and verify. pi-charter persists lifecycle, presents state, journals file changes, and supplies Ralph continuation.
- Verification artifacts are captured during verification, linked from phase bodies when useful, and curated into REPORT.md.
- A new charter may complete with zero phases. There is no empty-list open-ended mode.
- Old file-interface charters are read-only history. New work always starts with a new phases charter.

## Example dialogue

> **Dev:** "Should I turn the request into ten criteria before I start?"
>
> **Domain expert:** "No. Preserve the authorized outcome in the Objective. Start with Explore, then add only the phases that emerge from the work."
>
> **Dev:** "The source changed after I took a screenshot. Is the screenshot stale?"
>
> **Domain expert:** "There is no global freshness rule. Decide whether the artifact still supports the Objective. Re-verify only when the change actually affects what it shows."
>
> **Dev:** "Can every phase be done while the charter remains active?"
>
> **Domain expert:** "Yes. Phase status communicates progress; it is not the lifecycle or a completion gate. Audit the Objective and references, curate the report, and complete with a concise reason when the work is truly done."

## Recommended defaults while the user is away

- Preserve the user's wording and intent in the Objective.
- Add constraints, verification expectations, or report detail only when the user authorized them.
- Let phases emerge. Do not impose counts, dependencies, question states, or gates.
- Capture UI evidence while exercising user-visible behavior, not later to fill a report.
- Treat a repeating Ralph loop as a reason to recover or pause, not to add another evaluator.
- Keep tactical todos outside the charter.
