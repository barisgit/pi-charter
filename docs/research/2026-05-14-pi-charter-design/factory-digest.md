# Factory Droid Missions — Technical Digest

> Compiled: 2026-05-14. Sources: docs.factory.ai, factory.ai/blog, changelog, third-party analysis.

---

## Factory Droid Missions

### Definition — what is a Mission vs. a chat / session

A **Mission** is a structured, multi-session autonomous workflow for large, multi-feature work. It contrasts with a standard Droid chat session, which is interactive and bounded (~8 min median, ~60% under 15 min). Missions are designed for work that runs hours to days, with a median of ~2 hours and a distribution extending to 16+ days. Access: `/missions` or `/enter-mission` in any Droid session. Early-access status (Enterprise/Max plans at launch, now GA).

A **Session** is a single conversational context with a Droid; it degrades over long trajectories due to context dilution and self-evaluation bias. A Mission wraps multiple sessions — orchestrated, with fresh context per work unit — to overcome these failure modes.

---

### Lifecycle — spec → plan → execute → review (with actual stage names from docs)

The official doc calls this a **planning phase** then **Mission Control** (execution). The engineering blog ("How Missions Work") adds richer internal stage names:

| User-facing stage | Internal stage name(s) | Description |
|---|---|---|
| **Collaborate on plan** | — | Droid asks clarifying questions; iterates with user on scope. |
| **Build plan** | — | Droid constructs structured plan: features + milestones. |
| **Plan approval** | — | User approves; mission transitions to automated execution. |
| **Mission Control** | — | Orchestration view; user monitors, intervenes, redirects. |
| **Execution** | **Worker** | Each feature gets a fresh worker session; TDD per feature (write tests → implement). |
| **Validation** | **Scrutiny validator** | Reviews each worker's implementation + trajectory for quality/correctness. |
| **Validation** | **User-testing validator** | Exercises the app as a black box; verifies against validation contract. |
| **Fix loop** | **Fix feature** | Orchestrator creates follow-up features for gaps; re-executes before re-validation. |
| **Milestone gate** | — | Loop repeats until milestone validation passes. |
| **Block / handoff** | — | If blocked, orchestrator halts and returns control to user. |

The per-feature loop (TDD inside a worker): **Test phase → Implementation phase → Verification phase**.

The per-milestone loop: **Feature execution → Validation → Fix features → Re-validation** (repeats until pass).

The lifecycle formula: `total runs ≈ #features + 2 × #milestones` (floor; fix loops add more).

---

### Spec format — what fields a mission spec has

The spec is built collaboratively during planning, then structured as artifacts:

| Artifact | Description |
|---|---|
| **Objective** | The user's high-level goal (from conversation). |
| **Validation contract** (`validation-contract.md`) | Finite checklist of testable behavioral assertions defining mission completion/correctness. Written *before* features. Each assertion includes: ID, description, tool (e.g. `agent-browser`), evidence type (screenshot, network trace). |
| **Features** (`features.json`) | Bounded implementation units; each claims which validation assertions it fulfills. |
| **Milestones** | Logical groupings of features; each is a checkpoint with its own validation gate. |
| **Services manifest** (`services.yaml`) | Boundaries and procedures for workers. |
| **Shared AGENTS.md** | Project conventions carried into all worker sessions. |
| **Skills** | Existing skills leveraged; new skills developed during planning and usable by workers. |

Feature spec fields (per the TDD architecture): feature name, acceptance criteria, validation command (e.g. `pnpm test`), paths for log output, skills required, which validation assertions it claims to fulfill.

---

### Autonomy levels — how user trades supervision for speed; per-mission settings

Four levels (Off / Low / Medium / High), set per session or via `/settings`. Missions **require High autonomy** by default, or `--skip-permissions-unsafe`.

| Level | Without approval | In missions |
|---|---|---|
| **Off** | Read tools + allowlisted commands only | N/A — missions blocked |
| **Low** | File edits + low-risk read commands | N/A — missions blocked |
| **Medium** | Low + reversible workspace changes (`npm install`, `git commit`, `mv`, `cp`, build tooling) | N/A — missions blocked |
| **High** | High-risk actions unless safety checks require it (`docker compose up`, `git push`, migrations) | Required for mission orchestration |

Enterprise admins can cap the Maximum Autonomy Level org-wide, hiding High for lower-privilege members.

Command-level allowlists and denylists (`commandAllowlist`, `commandDenylist` in settings) layer on top of autonomy levels. Org-managed settings override local ones.

---

### Persistence — where mission state lives, how it survives across sessions / handoffs

- **Git as source of truth**: Workers coordinate through git; changes are committed by workers and read by subsequent workers.
- **Shared state artifacts**: No single agent holds the full picture in context. State is distributed across:
  - `validation-contract.md` — the correctness checklist
  - `features.json` — feature list with status
  - `services.yaml` — worker boundaries/procedures
  - `AGENTS.md` — conventions (carried into all worker sessions)
  - Knowledge base — accumulated semantic understanding
- **Mission Control**: Persists to session settings (per May 2026 changelog: token usage persisted to session settings, toggleable in Mission Control).
- **Externalized state pattern**: Each agent reads only what's relevant to its current job; the orchestrator delegates deep investigation to subagents to avoid consuming detail itself.
- **Resumable**: User can pause the orchestrator and resume; the orchestrator re-assesses state and picks back up.

---

### Multi-droid handoff — how a mission moves between droids or to a human reviewer

- **Coordinator / Orchestrator**: Central agent; decomposes the ticket into droid-sized work items, assigns to appropriate droids, sequences execution. Visible to user — you can inspect the plan and override assignments.
- **Worker sessions**: Each feature gets a fresh session with clean context; workers are spawned in order by a programmatic runner. Workers write tests first, then implement.
- **Validator sessions**: Fresh agents injected at milestone boundaries; two types:
  - **Scrutiny validators**: Review implementation quality + trajectory; encode knowledge updates into shared state.
  - **User-testing validators**: Exercise the system as a black box (UI clicks, page flows); capture screenshots; verify against validation contract.
- **Fix feature flow**: After validation, orchestrator creates targeted fix features → workers execute them → milestone re-validates. Loop repeats.
- **Block / human handoff**: If blocked, orchestrator halts and returns control to user. User can pause and instruct the orchestrator to recover or re-plan.
- **Custom droids as subagents**: Subagents configured in the project are available to workers. Custom droids can be invoked by workers or the orchestrator.
- **Knowledge Droid** (persistent memory layer): Indexes repo, docs, ticket history. Downstream droids query it instead of re-reading the codebase. Accumulates semantic understanding (naming conventions, patterns) across the mission.

Canonical droid types (from the product overview — not all participate in every mission):

| Droid | Role in general operation | Role in missions |
|---|---|---|
| Code Droid | Feature implementation, refactoring, bug fixes | Worker (feature implementation) |
| Review Droid | PR analysis, regression detection | Scrutiny validator |
| Test Droid | Test generation, coverage analysis | Writes tests (TDD phase) |
| Docs Droid | README, changelog, internal docs | Updates docs after feature merges |
| Knowledge Droid | Memory layer; indexes codebase + docs | Shared context store for all droids |
| Product Droid | Ticket/project management automation | (mission planning input) |
| Reliability Droid | On-call incident triage, root cause | (incident response context) |

---

### Verification / evaluation — what success looks like; evidence captured

- **Validation contract** is the primary success definition: a finite checklist of testable behavioral assertions. Assertions include expected behavior, tool to use (e.g. `agent-browser`), and evidence type (screenshot, network trace).
- **Per-feature TDD**: Workers write tests before code; test failures map to acceptance criteria. Test suite (`pnpm test`, `pytest -q`) is the per-feature verification gate.
- **Milestone validation** (two-pronged):
  1. Scrutiny: implementation quality + trajectory review; knowledge updates to shared state.
  2. User-testing: black-box exercise of the app (clicking through UI, verifying state transitions, checking layout renders).
- **Evidence captured**: screenshots, network traces (HTTP responses), text snapshots for terminal flows, step-level pass/fail tables from QA flows.
- **Mission passes** when: all milestones validate (all scrutiny + user-testing assertions green), no unresolved fix features remain.
- **Signals framework** (separate from missions): LLM-as-judge analyzes sessions for friction; surfaces patterns without exposing raw conversation; files Linear tickets that Droid can act on.
- **Crucible**: Factory's proprietary benchmarking suite covering code migration, refactoring, API integration, unit-test generation, code review, documentation, debugging.

---

### Reminders / surfacing — how the active mission appears in the UI / context

- **Mission Control** (CLI + app): Central orchestration view showing feature/milestone progress, which agent is working on what, token usage per worker. Changelog entries (2026): per-worker token breakdown, keyboard shortcuts (`g`/`G`) to jump between workers and features list, Mission Control shortcut (`Ctrl+T`), token usage toggleable in Mission Control, factory token usage persisted to session settings.
- **Mission worker view**: Per-worker progress and output monitoring (added post-GA).
- **The orchestrator as a conversation surface**: The user treats themselves as project manager; talks directly to the orchestrator agent to intervene, redirect, unblock, or request re-planning.
- **Changelog (May 2026)**: `/missions` system reminder no longer shows when already in a mission session (fixed as bug fix).
- **Session persistence**: Missions and their progress survive session ends; user can `/sessions` to resume.

---

### Diagram — Mermaid mission lifecycle

```mermaid
flowchart TD
    User([User]) --> Enter[/missions]

    Enter --> Planning[Collaborative Planning<br/>Clarify goal, scope, constraints]

    Planning --> PlanBuild[Droid builds structured plan:<br/>Features + Milestones + Skills]

    PlanBuild --> PlanReview{User approves plan?}

    PlanReview -->|No| PlanBuild
    PlanReview -->|Yes| MC[Enter Mission Control]

    MC -->|for each milestone| FeatureLoop[/Feature execution loop/]

    FeatureLoop --> WorkerSpawn[Spawn feature worker<br/>fresh context per feature]

    WorkerSpawn --> TestPhase[Test Phase:<br/>Write failing tests]
    TestPhase --> ImplementPhase[Implementation Phase:<br/>Implement to pass tests]
    ImplementPhase --> VerificationPhase[Verification Phase:<br/>Review diffs, run test suite]

    FeatureLoop -->|all features done| ValidationPhase[Milestone Validation]

    ValidationPhase --> ScrutinyVal[Scrutiny Validator:<br/>Quality + trajectory review]
    ScrutinyVal --> UserTestVal[User-Testing Validator:<br/>Black-box UI/exercise]

    UserTestVal -->|gaps found| FixFeature[Orchestrator creates<br/>fix features]
    FixFeature --> WorkerSpawn

    UserTestVal -->|all pass| NextMilestone{Next<br/>milestone?}

    NextMilestone -->|Yes| FeatureLoop
    NextMilestone -->|No| Complete[Mission Complete]

    FeatureLoop -->|blocked| Blocked{Halted:<br/>Return to user?}
    Blocked -->|Yes| User
    Blocked -->|orchestrator recovers| FeatureLoop

    User -->|"monitor, intervene, redirect"| MC
```

---

### Citations

1. `docs.factory.ai/cli/features/missions` — Primary docs: definition, how it works, planning phase, Mission Control, validation, cost estimation, configuration inheritance, open questions.
2. `factory.ai/news/missions-architecture` — Engineering blog: rationale (context dilution, self-evaluation bias), design principles, separation of concerns, TDD at two levels, externalized state, model specialization, system internals (validation contract, runner, validators, fix loop).
3. `factory.ai/news/missions` — Introducing Missions: multi-day autonomy, droid types, stats (2hr median, 12x tokens), model roles per stage, controls/privacy/enterprise, open questions.
4. `docs.factory.ai/cli/user-guides/auto-run` — Autonomy levels: Off/Low/Medium/High, command allowlists/denylists, missions requiring High, enterprise controls.
5. `docs.factory.ai/cli/user-guides/specification-mode` — Spec Mode: acceptance criteria, implementation plan, approval options (including autonomy level selection for execution).
6. `docs.factory.ai/changelog/release-notes` — Changelog: Mission Control shortcuts, per-worker token breakdown, unified `/missions` menu, mission worker view, usage limits, access policy, skill validation, factory token usage in Mission Control.
7. `factory.ai/news/code-droid-technical-report` — Code Droid technical report: Droids philosophy, Crucible benchmark suite.
8. `factory.ai/news/factory-signals` — Signals framework: LLM-as-judge for session analysis, recursive self-improvement loop.
9. `factory.ai/news/factory-is-ga` — GA announcement: six Droid capabilities, context-first AI, local/remote, org/user memory.
10. `docs.factory.ai/cli/features/code-review` — Code Review feature: `/review` command, review presets, CI automated review.
11. `docs.factory.ai/cli/configuration/skills` — Skills: invocation control, frontmatter (`disable-model-invocation`, `user-invocable`), auto-loading.
12. `docs.factory.ai/cli/configuration/agents-md` — AGENTS.md: sections, agent compatibility, spec mode integration, autonomy.
13. `docs.factory.ai/cli/configuration/settings` — Settings: `sessionDefaultSettings.interactionMode`, `sessionDefaultSettings.autonomyLevel`, `commandAllowlist`, `commandDenylist`.
14. `docs.factory.ai/guides/droid-exec/code-review` — Automated code review: GitHub/GitLab setup, `automatic_review`, `automatic_security_review`, STRIDE-based security analysis.
15. `docs.factory.ai/cli/features/droid-control` — Droid Control: `/demo`, `/verify`, `/qa-test`, automation drivers (tuistory, true-input, agent-browser), video rendering.
16. `docs.factory.ai/onboarding/configuring-your-factory/review-droid-guidelines` — Review Droid Guidelines: `.droid.yaml` config, path-based guidelines, feedback mechanism.
17. `docs.factory.ai/cli/reference` — CLI reference: `/missions`, `/enter-mission`, `/exit-mission`, `--auto`, `--use-spec`, `--spec-model`.
18. `www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review` — Third-party review: coordinator-droid architecture, Knowledge Droid, 5 canonical droids, coordinator pattern in practice, agency fit.
19. `digialps.com/factory-ai-droid-agents-guide-building-army` — Droid types overview: Code Droid, Reliability Droid, Product Droid, Knowledge Droid roles.
20. `www.gradually.ai/en/changelogs/factory-ai` — Third-party changelog: mission feature timeline (v0.92–v0.124).
21. `medium.com/@silas_27632/how-to-make-droids-code-for-hours-using-test-driven-development-and-smart-orchestration-in-factory-a-40838d66e048` — TDD architecture: Spec/Test/Implement/Verify loop, Delegator pattern.
