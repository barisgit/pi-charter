# pi-charter Context

pi-charter is a Pi extension for durable, charter-bound agent work: an agent receives an objective, authors or reuses a charter, decomposes the work into features, records evidence against criteria, and uses evaluator feedback to stay aligned until the charter is satisfied.

This context defines the domain language. It intentionally describes the product model, not TypeScript implementation details.

## Language

### Core identity

**Charter**:
A binding document that authorizes and constrains an agent run through three sections: Objective, Criteria, and Scope and constraints.
_Avoid_: Goal, mission, contract, quest

**Objective**:
The concise outcome the user or orchestrator wants the agent to achieve.
_Avoid_: Goal, task, prompt

**Criteria**:
Observable assertions that must hold before the charter can be completed.
_Avoid_: Acceptance tests, assertions, checklist, validation contract

**Scope and constraints**:
Boundaries that define what the agent should not do, what must be preserved, and what resources may be spent.
_Avoid_: Notes, preferences, non-goals

**Mission**:
The runtime execution container bound to one charter, session, budget, evaluator state, plan, and evidence history.
_Avoid_: Charter, project, campaign

**CharterId**:
The stable UUID identifying one mission directory and preventing stale writes.
_Avoid_: Session id, goal id, task id

**pi-charter**:
The Pi extension that manages charters, plans, evidence, status, hooks, and evaluator steering.
_Avoid_: pi-goals v2, pi-missions

### Lifecycle

**Planning phase**:
The pre-execution state where the agent turns the objective and any referenced specs into `charter.md`, feature files, and a planner-critic report.
_Avoid_: Setup, discovery, plan mode

**Active phase**:
The execution state where the agent implements, verifies, delegates, amends, or pauses based on status and drift views.
_Avoid_: Running, doing work

**Review phase**:
The state entered after criteria appear satisfied, giving the agent one explicit evidence-inspection step before completion.
_Avoid_: Done, final answer

**Completed**:
The terminal state for a charter whose criteria and completion gates have passed.
_Avoid_: Finished, closed, resolved

**Paused**:
A non-terminal interruption state that preserves the charter binding and can resume later.
_Avoid_: Stopped, abandoned

**Budget-limited**:
A terminal or near-terminal state reached when configured token, wall-clock, or turn budget is exhausted before completion.
_Avoid_: Failed, timed out

**Abandoned**:
A terminal state for a charter intentionally stopped without satisfying the criteria.
_Avoid_: Cancelled, deleted

**Smart-Ralph loop**:
The execution discipline where the agent, not a scheduler, reads current status and evaluator feedback each turn and chooses one next move.
_Avoid_: Auto-spawn scheduler, autonomous worker pool

### Planning and decomposition

**Feature**:
A durable unit of planned work that fulfills one or more criteria.
_Avoid_: Task, todo, worker job

**Macro DAG**:
The durable feature graph that decomposes the charter into milestones, features, preconditions, and criterion coverage.
_Avoid_: Todo list, task DAG, sprint plan

**Milestone**:
An ordered group of features used to structure the macro DAG.
_Avoid_: Phase, epic

**fulfills[]**:
The feature-to-criteria join showing which criteria a feature is expected to satisfy.
_Avoid_: validates, covers, dependsOn

**Precondition**:
An advisory dependency indicating another feature should normally happen first.
_Avoid_: Gate, blocker, required edge

**Tactical task**:
A short-lived turn-to-turn todo managed by pi-dag-tasks, not by pi-charter.
_Avoid_: Feature, charter task

### Evidence and verification

**Evidence record**:
An append-only record of a check result for one criterion, including who recorded it, when, and what was observed.
_Avoid_: Log line, note, proof string

**Command evidence**:
An evidence record produced by running a command and storing its command, exit code, and observation.
_Avoid_: Test output blob

**Verifier**:
The mechanism attached to a criterion that decides whether evidence passes, preferably deterministic before LLM-judged.
_Avoid_: Reviewer, validator, judge

**charter-verifier**:
The bundled internal persona used when independent review evidence is required.
_Avoid_: Reviewer subagent, validator worker

**requireFreshEvidence**:
A criterion rule requiring passing evidence newer than the last criterion or charter change.
_Avoid_: Rerun all tests, freshness hint

**requireReviewSubagent**:
A criterion rule requiring passing evidence recorded by `charter-verifier`, not only by the implementing agent.
_Avoid_: Manual approval, reviewer requested

**Criterion state**:
The computed mutable status bitmap for criteria.
_Avoid_: Criteria frontmatter, contract state

**Feature state**:
The computed mutable status bitmap for features.
_Avoid_: Feature frontmatter status

### Evaluator and drift

**charter-evaluator**:
The bundled internal evaluator that produces a verdict and reason after turns to steer the next agent move.
_Avoid_: Intent sentinel, judge, completion gate

**Evaluator verdict**:
The evaluator's current classification of progress, such as on-track, drifting, blocked, or done.
_Avoid_: Final status, completion decision

**Drift view**:
A computed status view that highlights uncovered criteria, stuck features, stale evidence, ready-next candidates, or wasted work.
_Avoid_: Scheduler queue, issue list

**Ready-next advisory**:
A suggested next feature from status analysis that the agent may follow or override.
_Avoid_: Assigned task, scheduled job

**Steer**:
A short evaluator-generated reason injected into context to influence the next agent turn.
_Avoid_: Reminder, instruction, command

### Tool and UI surface

**charter_manage**:
The lifecycle tool for creating, pausing, resuming, amending, completing, and force-completing a charter.
_Avoid_: charter_create, goal_manage

**charter_plan**:
The macro-DAG tool for viewing and editing planned features.
_Avoid_: task_manage, planner

**charter_record**:
The execution-write tool for recording evidence, verification results, and handoff envelopes.
_Avoid_: evidence tool, verifier tool

**charter_status**:
The read-only tool that returns status, drift views, evaluator reason, and legal next actions.
_Avoid_: mission_status, goal_status

**nextActions**:
The tool-return field listing legal next tool calls for the current state so agents do not memorize the FSM.
_Avoid_: Help text, suggestions

**/charter**:
The single slash-command tree for opening the TUI/status surface and running interactive charter commands.
_Avoid_: /mission, /missions, /goal

### Hooks and persona boundaries

**Decision-control hook**:
A hook event that another extension can block or modify before a high-risk charter transition.
_Avoid_: Notification hook, log event

**Internal persona**:
A bundled persona invocable by pi-charter code but not advertised to the root LLM as a general subagent.
_Avoid_: Hidden agent, worker role

**Metadata passthrough**:
Opaque metadata stamped onto subagent events so pi-charter can relate delegated work back to a charter and feature.
_Avoid_: Binding, bridge field

## Relationships

- A **Charter** belongs to exactly one **Mission** runtime container.
- A **Mission** has exactly one active **CharterId**.
- A **Charter** contains one **Objective**, many **Criteria**, and zero or more **Scope and constraints** entries.
- A **Macro DAG** belongs to one **Charter** and contains many **Features**.
- A **Feature** fulfills one or more **Criteria** through `fulfills[]`.
- A **Criterion** may be fulfilled by many **Features**.
- **Feature state** and **Criterion state** are mutable sidecars derived from authored files and evidence.
- **Evidence records** belong to one **Criterion** and may be associated with one **Feature**.
- The **charter-evaluator** may produce a **Steer**, but verifier evidence and hooks decide completion.
- A **Tactical task** may inform a **Drift view** via hook events, but pi-dag-tasks does not store a pointer into pi-charter.
- A root Pi session may bind to one **CharterId**; subagent sessions receive charter scope through **Metadata passthrough** and do not bind themselves.

## Example dialogue

> **Dev:** "The user gave us an OAuth spec and said to implement it. Do we create a goal?"
>
> **Domain expert:** "No. Create a **Charter** from the objective, read the spec with normal file tools, then author `charter.md` during the **Planning phase**."
>
> **Dev:** "Should each implementation step become a pi-dag-task?"
>
> **Domain expert:** "No. Durable work units are **Features** in the **Macro DAG**. pi-dag-tasks is only for short-lived tactical todos."
>
> **Dev:** "The tests passed. Can the agent complete the charter?"
>
> **Domain expert:** "Only if the relevant **Criteria** have fresh passing **Evidence records**, any `requireReviewSubagent` criteria have `charter-verifier` evidence, and decision-control hooks allow completion."

## Flagged ambiguities

- **Charter vs Mission**: The user-facing product name is pi-charter, and the authored file is `charter.md`; the runtime TypeScript container may still be called **Mission** because it describes execution state, not the document. If this feels too split during implementation, prefer user-facing `Charter` names and keep `Mission` internal only.
- **Contract**: Earlier research used `contract.md`. Current decision is Option A: collapse objective, criteria, and constraints into one `charter.md`. Use **Criteria** for the contract-like section, not **Contract** as a top-level term.
- **Goal**: v1 used **Goal**. In pi-charter, "goal" survives only as an informal synonym for **Objective** and should not appear in public APIs.
- **Mission**: Avoid using "mission" in extension names, slash commands, tools, or package names because `pi-missions` is taken and Factory.ai uses Missions publicly.
- **Validation**: Use **Verifier** for the mechanism and **Evidence record** for the observed result. Avoid calling all of this "validation" because Factory and existing pi-missions use that word differently.
- **Scheduler**: pi-charter does not schedule workers. The **Ready-next advisory** tells the agent what looks next; the agent chooses.

## Recommended defaults while user is away

- Keep the root context as a single `CONTEXT.md`; this repo has one domain context.
- Use `charter.md` as the only authored charter file.
- Use four LLM tools, not one giant discriminated union and not twelve narrow tools.
- Make every tool return `nextActions[]`.
- Prefer filesystem state over session-entry-only state; use session entries as audit/complement only.
- Keep implementation headless first; TUI approver subscribes through hooks later.
- If a question arises between autonomy and human gating, default to autonomous-first with explicit evidence gates.
