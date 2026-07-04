# pi-charter Context

pi-charter is a Pi extension for durable, charter-bound agent work: an agent receives an objective, calls `charter create`, and from then on works normally — editing one markdown file (`charter.md`) to author criteria and record evidence, while the runtime watches the file, steers via the smart-Ralph loop, and gates completion.

The file is the interface. There is no tool for editing criteria or recording evidence; the only tool is lifecycle.

This context defines the domain language. It intentionally describes the product model, not TypeScript implementation details.

## Language

### Core identity

**Charter**:
A binding document that authorizes and constrains an agent run, authored as a single file `charter.md` containing the Objective, optional Scope, and the Criteria with their Evidence lines.
_Avoid_: Goal, mission, contract, quest

**charter.md**:
The single authored file and sole contentful interface: Objective, optional Scope, Criteria headings, Depends lines, Evidence lines. The agent edits it directly; the runtime diffs it.
_Avoid_: Charter, contract.md, criteria.md

**Objective**:
The concise outcome the user or orchestrator wants the agent to achieve. The only required input to `create`.
_Avoid_: Goal, task, prompt

**Criterion**:
An observable assertion (`### C<n>. <title>` heading in charter.md) that must hold before the charter can be completed, with an optional prose body describing how to verify and one Evidence line.
_Avoid_: VAL, acceptance test, checklist item, validation contract

**Scope**:
Optional inert prose section in charter.md defining what is in and out of bounds.
_Avoid_: Mission Boundaries, notes, non-goals

**CharterId**:
`<YYYYMMDD-HHMMSS>-<slug>` identifying one charter directory. Chronologically sortable by construction; addressable by unique prefix or slug fragment.
_Avoid_: UUID, session id, goal id

**Open-ended charter**:
A charter whose `## Criteria` section is empty. It can never complete; it runs until paused or abandoned. Adding criteria later makes it bounded.
_Avoid_: Endless mode, watch mode

**pi-charter**:
The Pi extension that manages charter lifecycle, file diffing, staleness, Ralph steering, and the completion gate.
_Avoid_: pi-goals, pi-missions

### Lifecycle

**Active**:
The execution state. A charter is `active` from creation; there is no separate planning or review state.
_Avoid_: Running, planning, review

**Paused**:
A non-terminal interruption state that preserves the charter binding and can resume to active later. Also the mechanism for "blocked on the user": pause with a note carrying the question.
_Avoid_: Stopped, abandoned, awaiting user

**Completed**:
The terminal state for a charter that passed the completion gate (all criteria pass, no stale evidence, REPORT.md, hooks allow).
_Avoid_: Finished, closed, resolved

**Abandoned**:
The terminal state for a charter intentionally stopped without satisfying the criteria. A note is required.
_Avoid_: Cancelled, deleted, failed

**Smart-Ralph loop**:
The execution discipline where the agent, not a scheduler, reads current status and chooses one next move. The runtime reprompts the agent on idle for non-terminal charters; the agent decides when to stop by calling `pause` or `abandon`.
_Avoid_: Auto-spawn scheduler, autonomous worker pool

**Ralph reprompt**:
A fresh continuation message sent when the root agent and async subagents are all idle and the charter is non-terminal. Condensed: state, evidence counts, top blocker, stale mentions. It starts a new turn.
_Avoid_: Reminder, wall of text

### Evidence and verification

**Evidence line**:
The `Evidence: pass|fail|none — <note>` line under a criterion heading. Latest state only; history lives in the journal. `none` until actually verified; the note carries what was run/observed and artifact paths.
_Avoid_: Evidence record, log line, proof string, checkbox

**Evidence hierarchy**:
Doctrine for evidence quality, strongest first: (1) used it like a user would — drove the real app, captured screenshot/recording to `work/`; (2) observed the real system — real command or endpoint output; (3) ran the checks — tests/typecheck/lint, acceptable alone only for criteria about code behavior.
_Avoid_: Test evidence as default

**Artifact**:
A file in the charter's `work/` directory produced at verification time — screenshot, recording, output dump — referenced by path from an Evidence line and later curated into REPORT.md. Never captured retroactively to satisfy the report.
_Avoid_: Attachment, upload

**Staleness**:
Computed, global: a criterion is stale when its `pass` evidence precedes the latest source-modifying tool call (sequence-counter order). Advisory in status/Ralph; hard-rejected at `complete`.
_Avoid_: requireFreshEvidence, freshness flag

**Verifier**:
The mechanism an agent uses to produce evidence. The charter records the result; it does not run checks.
_Avoid_: Reviewer, validator, judge

### Structure

**Depends line**:
Optional `Depends: C1, C2` line under a criterion heading. Feeds Ralph steering and status ordering only; never gates evidence or completion. Cycles and dangling refs are warnings.
_Avoid_: DAG, blockedBy, precondition

**Grouping heading**:
Any inert heading inside `## Criteria` used to visually group criteria. Not modeled by the runtime; there is no milestone entity.
_Avoid_: Milestone, phase, epic, feature

**Tactical task**:
A short-lived turn-to-turn todo managed by pi-dag-tasks, not by pi-charter.
_Avoid_: Charter task

### Runtime mechanics

**Snapshot diff**:
How the runtime observes edits: at every tool result and turn boundary it hash-compares charter.md against the last snapshot and, on change, parses and diffs per-criterion sections into the journal. No polling, no fs watcher.
_Avoid_: File watcher, poll loop

**Sequence counter**:
A monotonic index over tool calls in the session. Evidence edits and source modifications each get a seq; staleness is a comparison of seqs.
_Avoid_: Turn counter, timestamp ordering

**Journal**:
`events.jsonl`, the append-only history: evidence diffs, source-change ticks, lifecycle transitions, external edits.
_Avoid_: Log file, audit table

### Completion

**Completion gate**:
`complete` succeeds only when every criterion's Evidence line is `pass` with a non-empty note, no pass evidence is stale, REPORT.md exists and is filled in, and the `charter:before_complete` hook allows.
_Avoid_: Done check, sign-off

**REPORT.md**:
The charter's main deliverable: a showcase of what was built, suitable for pasting into a PR. Scaffolded at first `complete` attempt, pre-populated from charter.md (objective, criteria, pass notes, artifact links). The agent curates narrative and ordering; it does not produce new evidence at report time. Artifact links per criterion are encouraged, not code-gated.
_Avoid_: Summary, changelog

### Tool surface

**charter**:
The single LLM tool. Params: `action`, `id?`, `objective?`, `note?`. Actions: `create`, `list`, `status`, `pause`, `resume`, `complete`, `abandon`.
_Avoid_: charter_record, charter_status, charter_manage

**nextActions**:
The tool-return field listing legal next tool calls for the current state so agents do not memorize the FSM.
_Avoid_: Help text, suggestions

**Status view**:
The `status` action's terse read: FSM state, per-criterion `{id, title, evidence, stale?, depends}`, blockers for complete, nextActions.
_Avoid_: Drift view, dashboard, wall of text

**Scaffold template**:
The charter.md that `create` writes: objective filled in, grammar and evidence doctrine taught in HTML comments (including one example criterion inside a comment), zero live placeholder criteria.
_Avoid_: Boilerplate, empty file

## Relationships

- A Pi session binds to at most one active **Charter**; `create` while one is active fails with a pointer to it. `id` addresses other charters.
- A **Charter** is authored as one **charter.md**; `state.json` holds lifecycle/session/snapshot state; the **Journal** holds history; `work/` holds **Artifacts**; **REPORT.md** is the deliverable.
- **charter.md** contains one **Objective**, optional **Scope**, and zero or more **Criteria** (flat; grouping headings are inert).
- Each **Criterion** has one **Evidence line**, an optional prose body, and an optional **Depends line**.
- The runtime observes edits via **Snapshot diff**, orders them with the **Sequence counter**, computes **Staleness**, and steers via **Ralph reprompts**; the **Completion gate** decides completion.
- Charters live in `.charters/` at the project root; old `.pi/charters/` dirs are never read.
- A **Tactical task** stays in pi-dag-tasks; subagent sessions receive charter scope through metadata passthrough and do not bind themselves.

## Example dialogue

> **Dev:** "The user gave us an OAuth spec and said to implement it. Do we create a goal?"
>
> **Domain expert:** "Clarify anything genuinely unclear first — a charter is created when the agent has what it needs. Then `charter action=create` with the objective, and author the criteria by editing the scaffolded **charter.md** directly. There is no planning state."
>
> **Dev:** "How do I record that a criterion passed?"
>
> **Domain expert:** "Edit its **Evidence line** in charter.md: `Evidence: pass — <what you ran and what it showed>`, with artifact paths from `work/` when you drove the real thing. There is no evidence tool."
>
> **Dev:** "The tests passed. Can the agent complete the charter?"
>
> **Domain expert:** "Tests are the weakest evidence — fine for pure code-behavior criteria, not for anything user-facing. And only if no pass evidence is stale: if source changed after a criterion was verified, `complete` rejects until it's re-verified. Then REPORT.md gets curated from the artifacts that already exist."

## Flagged ambiguities

- **Charter vs Mission**: The user-facing name is pi-charter. "Mission" survives only as an internal TypeScript container name if at all; never in public surfaces (Factory.ai owns Missions publicly).
- **Goal**: Codex and Claude Code ship `/goal` features (May 2026) occupying the same niche. pi-charter's differentiator is the structured, evidence-carrying completion contract in charter.md. "Goal" should not appear in public APIs.
- **VAL**: the previous design used `VAL-*` headings in criteria.md. Criteria are now `### C<n>.` headings in charter.md. "VAL" is dead vocabulary.
- **Milestone**: previously a modeled entity; now grouping headings are inert prose.
- **Evidence record**: the previous structured envelope (source/outcome/because/details) is dead; the Evidence line's note carries everything, and the journal keeps history.
- **Turn**: a turn can last hours with long-horizon agents; staleness is ordered by the per-tool-call sequence counter, never by turns.

## Recommended defaults while user is away

- Keep the root context as a single `CONTEXT.md`; this repo has one domain context.
- One tool, four params, seven actions; every return carries `nextActions[]`.
- One file: charter.md is both contract and evidence surface. Sidecar JSON holds only lifecycle/snapshot state.
- Parser is tolerant: unknown structure is inert, breakage is a warning, evidence-side work is never blocked on parse errors.
- Template and skill teach; Ralph advises; only the completion gate enforces.
- Ship zero bundled personas. Evidence quality is doctrine plus advisories, not gates.
- Keep implementation headless first; TUI approver subscribes through hooks later.
- Think 100x before adding anything: features, knobs, layers, or actions. The right design is the one that survives the next refactor by virtue of having nothing to delete.
