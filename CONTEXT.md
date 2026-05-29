# pi-charter Context

pi-charter is a Pi extension for durable, charter-bound agent work: an agent receives an objective, authors or reuses a charter (charter.md + criteria.md), groups VAL-* criteria under milestone headings, records evidence against each criterion, and stays aligned until the completion gate passes.

This context defines the domain language. It intentionally describes the product model, not TypeScript implementation details.

## Language

### Core identity

**Charter**:
A binding document that authorizes and constrains an agent run, authored as two files: `charter.md` (Objective, Scope and constraints, Mission Boundaries, Commands) and `criteria.md` (the VAL-* register).
_Avoid_: Goal, mission, contract, quest

**charter.md**:
The authored narrative file containing Objective, Scope and constraints, Mission Boundaries, and Commands. Does not contain Criteria.
_Avoid_: Charter, contract.md

**criteria.md**:
The authored assertion register containing every Criterion as a `VAL-*`-prefixed heading with pass criteria, failure modes, and trust-gate flags. Indexed by stable `VAL-*` id; safe to reorder.
_Avoid_: Contract.md, assertions.md, validation.md

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
The runtime execution container bound to one charter, session, budget, plan, and evidence history.
_Avoid_: Charter, project, campaign

**CharterId**:
The stable UUID identifying one mission directory and preventing stale writes.
_Avoid_: Session id, goal id, task id

**pi-charter**:
The Pi extension that manages charters, plans, evidence, status, and hooks.
_Avoid_: pi-goals v2, pi-missions

### Lifecycle

**Active**:
The execution state. A charter is `active` from creation; there is no separate planning or review state.
_Avoid_: Running, doing work, planning, review

**Paused**:
A non-terminal interruption state that preserves the charter binding and can resume to active later.
_Avoid_: Stopped, abandoned

**Completed**:
The terminal state for a charter whose criteria, evidence freshness, reviewer-stamp requirements, and REPORT.md gate have passed.
_Avoid_: Finished, closed, resolved

**Abandoned**:
The terminal state for a charter intentionally stopped without satisfying the criteria. A reason is required.
_Avoid_: Cancelled, deleted, failed

**Smart-Ralph loop**:
The execution discipline where the agent, not a scheduler, reads current status each turn and chooses one next move. The runtime’s Ralph service reprompts the agent on idle for non-terminal charters; the agent decides when to stop by calling `pause` or `abandon`.
_Avoid_: Auto-spawn scheduler, autonomous worker pool

**Reminder**:
Status/doctrine text injected into context, widgets, or tool responses; it does not start a turn.
_Avoid_: Steer, prompt, nag

**Ralph reprompt**:
A fresh continuation message sent when the root agent and async subagents are all idle and the charter is non-terminal; it starts a new turn.
_Avoid_: Reminder

### Decomposition

**Milestone**:
An ordered group of VALs in `criteria.md`, expressed as a `##` heading. The persisted layer between Objective and VAL.
_Avoid_: Phase, epic, feature group

**Tactical task**:
A short-lived turn-to-turn todo managed by pi-dag-tasks, not by pi-charter.
_Avoid_: Charter task, milestone task

### Evidence and verification

**Evidence record**:
An append-only record of a check result for one criterion, including the outcome, summary, optional `because`, source (`manual` | `command` | `subagent`), optional `recordedBy`, and timestamp.
_Avoid_: Log line, note, proof string

**Verifier**:
The mechanism that produces evidence for a criterion. Preferred: deterministic command verifiers declared in `charter.md ## Commands`. Fallback: manual or subagent evidence.
_Avoid_: Reviewer, validator, judge

**requireFreshEvidence**:
A per-criterion trust-gate flag in `criteria.md` requiring passing evidence newer than the last `src/` change.
_Avoid_: Rerun all tests, freshness hint

**requireReviewSubagent**:
A per-criterion trust-gate flag in `criteria.md` requiring at least one passing evidence row with `source: subagent` and non-empty `recordedBy`. Any subagent satisfies it; pi-charter ships no bundled personas.
_Avoid_: Manual approval, reviewer requested

**because**:
A short justification field required on `source: manual` evidence rows. Explains why the agent believes the criterion is satisfied without an automated check.
_Avoid_: Reason, note, comment

**Criterion state**:
The computed mutable status sidecar for criteria, stored in `criterion-state.json`.
_Avoid_: Criteria frontmatter, contract state

### Status and continuation

**Status view**:
The `charter_status` read showing per-VAL outcomes, completion blockers, the next non-pass VAL, and milestone groupings. Replaces v2.x "drift view."
_Avoid_: Scheduler queue, issue list, drift view

**Ready-next advisory**:
The first non-pass VAL in declaration order, surfaced in status output. Advisory only; the agent may pick any non-pass VAL.
_Avoid_: Assigned task, scheduled job

**REPORT.md**:
A scaffolded markdown file authored at first `charter complete` attempt. Three sections (Title and Objective prefilled from charter.md; Outcome and Notes empty). Completion gate requires every heading have non-empty content.
_Avoid_: Summary, changelog, release notes

### Tool and UI surface

**charter**:
The lifecycle tool. Actions: `create`, `pause`, `resume`, `complete`, `abandon`. Replaces v2.x `charter_manage`.
_Avoid_: charter_manage, charter_create, goal_manage

**charter_record**:
The execution-write tool. Actions: `evidence` (manual or batch), `verify` (run a `## Commands` entry and stamp the result).
_Avoid_: evidence tool, verifier tool

**charter_status**:
The read-only tool that returns per-VAL outcomes, completion blockers, milestone groupings, and legal next actions.
_Avoid_: mission_status, goal_status

**nextActions**:
The tool-return field listing legal next tool calls for the current state so agents do not memorize the FSM.
_Avoid_: Help text, suggestions

**/charter**:
The single slash-command tree for opening the TUI/status surface and running interactive charter commands.
_Avoid_: /mission, /missions, /goal

### Hooks and subagent boundaries

**Decision-control hook**:
A hook event that another extension can block or modify before a high-risk charter transition.
_Avoid_: Notification hook, log event

**Metadata passthrough**:
Opaque metadata stamped onto subagent events so pi-charter can relate delegated work back to a charter and criterion. Used to populate the `recordedBy` field on subagent-sourced evidence.
_Avoid_: Binding, bridge field

## Relationships

- A **Charter** belongs to exactly one **Mission** runtime container.
- A **Mission** has exactly one active **CharterId**.
- A **Charter** is authored as **charter.md** plus **criteria.md**.
- **charter.md** contains one **Objective**, zero or more **Scope and constraints** entries, optional **Mission Boundaries**, and optional **Commands**.
- **criteria.md** contains zero or more **Milestones**, each with one or more **Criteria** (VAL-*).
- A **Milestone** is a group heading in `criteria.md`; **Criteria** are leaves.
- **Criterion state** is a mutable sidecar derived from criteria.md and evidence records.
- **Evidence records** belong to one **Criterion**.
- The runtime’s deterministic Ralph reprompt service keeps non-terminal charters moving when the agent and async children are idle; the completion gate (every VAL pass + fresh evidence + reviewer-where-required + REPORT.md gate) decides completion.
- A **Tactical task** may inform a **Status view** via hook events, but pi-dag-tasks does not store a pointer into pi-charter.
- A root Pi session may bind to one **CharterId**; subagent sessions receive charter scope through **Metadata passthrough** and do not bind themselves.

## Example dialogue

> **Dev:** "The user gave us an OAuth spec and said to implement it. Do we create a goal?"
>
> **Domain expert:** "No. Create a **Charter** from the objective with `charter action=create`, then read the spec with normal file tools and author **charter.md** and **criteria.md** directly. There is no planning state — the charter is `active` from creation."
>
> **Dev:** "Should each implementation step become a pi-dag-task?"
>
> **Domain expert:** "Tactical turn-to-turn todos belong in pi-dag-tasks. Durable assertions belong in **criteria.md** as `VAL-*` entries grouped under **Milestone** headings."
>
> **Dev:** "The tests passed. Can the agent complete the charter?"
>
> **Domain expert:** "Only if every Criterion has a fresh passing **Evidence record**, criteria with `requireReviewSubagent` have at least one subagent-sourced evidence row, REPORT.md exists with non-empty content under every heading, and decision-control hooks allow completion."

## Flagged ambiguities

- **Charter vs Mission**: The user-facing product name is pi-charter; the authored files are `charter.md` and `criteria.md`. The runtime TypeScript container may still be called **Mission** because it describes execution state. Prefer user-facing `Charter` names and keep `Mission` internal only.
- **Contract**: Earlier research used `contract.md`. v3 splits the contract into two authored files: **charter.md** (narrative) and **criteria.md** (assertion register). See ADR-0010.
- **Goal**: v1 used **Goal**. In pi-charter, "goal" survives only as an informal synonym for **Objective** and should not appear in public APIs.
- **Mission**: Avoid using "mission" in extension names, slash commands, tools, or package names because `pi-missions` is taken and Factory.ai uses Missions publicly.
- **Validation**: Use **Verifier** for the mechanism and **Evidence record** for the observed result.
- **Loop / stage**: pi-charter does not persist micro-stages. Persisted layers are `Objective → Milestone → VAL`. Behavioral coaching lives in `skills/pi-charter/SKILL.md` and in `charter_status.nextActions[]` advisories.
- **Scheduler**: pi-charter does not schedule workers or features. The agent decides what to chunk and parallelise; the **Ready-next advisory** is one VAL pointer, nothing more.
- **Features**: v2.x had a Feature decomposition layer with `fulfills[]` and `preconditions[]`. v3 removes it; the unit of work is the VAL, and the agent decides chunking in flight (ADR-0012).

## Recommended defaults while user is away

- Keep the root context as a single `CONTEXT.md`; this repo has one domain context.
- Use `charter.md` for narrative (objective, scope, boundaries, commands) and `criteria.md` for the VAL-* register; sidecar JSON files hold mutable runtime state.
- Use three LLM tools (`charter`, `charter_record`, `charter_status`); every tool return carries `nextActions[]`.
- Persisted decomposition is `Objective → Milestone → VAL`; features and a macro DAG are not persisted.
- Ship zero bundled personas. `requireReviewSubagent` is satisfied by any subagent.
- Prefer filesystem state over session-entry-only state; use session entries as audit/complement only.
- Keep implementation headless first; TUI approver subscribes through hooks later.
- Think 100x before adding anything: features, knobs, layers, or actions. The right v3 is the one that survives the next refactor by virtue of having nothing to delete.
