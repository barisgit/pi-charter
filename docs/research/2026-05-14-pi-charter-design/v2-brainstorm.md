# pi-charter — most-powerful design brainstorm

> Written 2026-05-14 after the cross-system study (Codex `/goal` 5-PR stack, Claude `/goal` + Plan + Task DAG, Factory missions with live evidence from `mis_622b326b`).
>
> v1 was a 5-minute single-shot. v2 is being designed deliberately. The user explicitly asked for **most powerful, not minimal**; ergonomics is a constraint, but the goal is the strongest tracker we can build, taking the best ideas from each system.
>
> **2026-05-14 rename decision:** pi-charter is **not** a cosmetic rename of `pi-goals`. It is a new concept replacing v1 goals: a charter is a binding document (`charter.md`) that authorises and bounds an agent's work through Objective / Criteria / Scope, then connects that charter to a macro DAG, evidence records, verifier personas, and a smart-Ralph loop. v1 `pi-goals` remains the historical baseline only.
>
> ---
>
> **Reading order / what supersedes what (current as of 2026-05-14):**
>
> The early sections (§§0–17) capture the original brainstorm. Several decisions made later supersede pieces of them in place. **If §§18–22 disagree with §§0–17, the higher-numbered section is the locked truth.** Specifically:
>
> - **§18** establishes the three-tier model (Mission / Macro DAG / Contract durable in pi-charter; Tactical tasks ephemeral in pi-dag-tasks). Wherever §§0–2 call the macro DAG "work DAG" or place it in pi-dag-tasks, read §18 instead. **§18.8/18.10/18.12 themselves are partially superseded by §10 (per-mission directory layout) and §21 (smart-Ralph drops `workerSessionIds[]` / `skillName` / `currentWorkerSessionId` from Feature, drops auto-advance).**
> - **§19** adds bundled internal personas (`charter-verifier`, `charter-planner-critic`, `charter-evaluator`) on top of pi-subagents `spawn` / `spawnRaw` / `registerPersonaDir` / opaque `metadata` passthrough. Wherever earlier sections say "the subagent inherits the active `charterId` via spawn config", read §19.5 (metadata passthrough) instead. Wherever earlier sections imply pi-subagents knows about goals, read the layering hard rules.
> - **§20** locks the full rename to `pi-charter` / `Charter` / `charter_*` / `charter-*` personas / `charter:*` hooks. Any `Goal` or `Mission` typename, `goal_*` or `mission_*` tool, `goal-*` or `mission-*` persona, or `~/.pi/goals/` / `~/.pi/missions/` path in §§0–17 is old vocabulary; read §20.1's rename table. `"goal"` survives only as `Charter.objective` (the English noun, the field name).
> - **§21** locks the smart-Ralph loop. There is no auto-spawn worker scheduler. `preconditions[]` is advisory. `Feature` does NOT carry `skillName`, `workerSessionIds[]`, `currentWorkerSessionId`, `completedWorkerSessionId`. Wherever §18 still has those fields, treat them as removed.
> - **§21 + b9 decision** locks: pi-dag-tasks carries NO pointer field into pi-charter. No `featureId`, no `charterId`, no `fulfills`. Wherever §§0–3/7/18 say tasks declare `fulfills[]` or carry `featureId`, that is wrong — read §12 (rewritten) instead.
> - **§22** locks the session↔mission binding (forward `state.json.sessionId` + reverse `~/.pi/agent/sessions/<sid>/charter.json`, no transcript marker, agent never picks up an existing mission).
>
> Targeted fixes have been applied in place to §§0/1/2/3/7/8/15/17/18/19 to keep the early sections from teaching the wrong thing in isolation. The big self-contained reframes still live in §§10 (persistence layout), §12 (pi-dag-tasks coupling), and §§18–22 (addenda). When the addenda and early text both speak to a topic, the addenda win.

---

## 0. The thesis in one paragraph

> **§18 supersedes this section's framing.** This original two-extension thesis was incomplete — the macro DAG is a third durable primitive that lives in pi-charter, not in pi-dag-tasks. The locked three-tier model is in §18.2 (Mission / Macro DAG / Contract durable in pi-charter; tactical tasks ephemeral in pi-dag-tasks with **no** pointer field between them). Read §18 for the current shape; the paragraph below is preserved for the evolution trace.

A long-running coding agent needs four primitives across two extensions:

1. **Mission (goal)** — the durable *why*. A single sentence with a token/time budget and a status FSM. (Codex `/goal` shape.) `pi-charter`.
2. **Macro DAG** — the *what-work*. Features grouped into milestones, each declaring `fulfills[]` into the contract. (Factory `features.json` shape.) `pi-charter`.
3. **Contract** — the *done-means-what*. A finite, evidenced checklist of behavioral assertions, each with a runner and an evidence type. (Factory `validation-contract.md` shape.) `pi-charter`.
4. **Tactical task list** — the *next-step*. Turn-to-turn todos with blocked/ready semantics; ephemeral. `pi-dag-tasks`, fully separate, **no** pointer field into pi-charter.

The three durable primitives are linked by one join field: each macro feature declares which contract assertions it `fulfills[]`. Coverage and drift are then computable. Tactical tasks deliberately do NOT carry `fulfills` or any reference to features/charters — coupling between extensions lives entirely on the pi-charter side via hook subscription. Everything else — evaluator, verifier, planner, handoff envelope, hooks, persistence, CLI — sits on top of these primitives.

v2's power comes from the **contract layer**, which v1 lacks entirely, plus a **post-turn evaluator** that surfaces fresh drift signal each turn (folded with intent-sentinel, dual-mode — see §20.6), plus a **handoff envelope** that binds `{command, exitCode, observation}` triples to evidence, plus a **smart-Ralph loop** where the agent itself — not a scheduler — picks the next move from drift views each turn (§21). Everything else is shape-of-existing-tools.

---

## 1. Design principles

### 1.1 Principles
- **Three durable primitives in pi-charter, one ephemeral primitive in pi-dag-tasks.** Mission / Macro DAG / Contract live together (joined by `fulfills[]` between features and criteria); tactical tasks live separately with no pointer field either way. Refuse to mix concerns.
- **Drift over deadlines.** A mission is alive as long as the evaluator says drift is bounded. Don't time-box missions; budget them and re-evaluate them.
- **Evidence over assertion.** "Completed" requires a fresh evidence record. Self-report alone is never sufficient when a verifier is declared.
- **Asymmetric authority.** Model can `create`, `propose-complete`, and `report-evidence`; system reserves `pause`, `resume`, `budget-limit`, and `force-complete`. (Codex `/goal` insight.)
- **Adaptive surfacing.** Drop the static every-8-turns reminder. Replace with an evaluator-driven steering item whose content changes each turn.
- **Compaction-aware.** All durable state lives in `<project>/.pi/charters/<charterId>/`, never only in the transcript. PreCompact reinjects the *current* evaluator reason, not the original objective.
- **Compose, don't replace.** Missions, features, and tactical tasks cooperate; missions do not contain tactical tasks, tactical tasks do not point at missions.
- **Agent owns the path, contract owns done.** Smart-Ralph loop: no auto-spawn scheduler; the agent reads drift views from `charter_status` and picks the next move each turn (§21).
- **Back-compat for v1 reads, but v2 is a clean break.** v1 JSON files load via an adapter; on first v2 mutation, the mission is auto-migrated to the new per-mission directory layout.

### 1.2 Explicit non-goals
- **No mandatory planner.** Many sessions don't need preplanning. Mission-without-contract is a valid shape; contract-without-mission is not.
- **No mandatory verifier.** Verifiers are per-criterion opt-in. A mission can have purely prose criteria.
- **No autonomy loop in v2 core.** Auto-continuation (Codex `MaybeContinueIfIdle`) is interesting but couples to the host agent. Park it for v3.
- **No multi-agent orchestrator.** Factory's Mission Control is out of scope; pi-charter tracks missions, not orchestrators. Inter-mission orchestration belongs to upstream systems (Symphony, etc.) per §20.8.
- **No auto-spawn worker scheduler.** Factory's per-feature worker pool is rejected by design (§21.2); the agent is the loop.
- **No HITL inside pi-charter core.** pi-charter is headless; the TUI approver is bundled-but-optional, gated by `~/.pi/agent/charter.config.json: tuiApprover: on` (default on) and `PI_CHARTER_TUI=off` override. Upstream orchestrators that want their own gating leave the approver off.
- **No GUI.** TUI/intent-bus only, like the rest of pi-*.

---

## 2. The Goal / Contract / DAG split (the most important section)

> **§18 supersedes this section.** §2 originally placed the work DAG inside pi-dag-tasks and put `fulfills[]` on tactical tasks. The locked three-tier model splits work into a **durable Macro DAG inside pi-charter** (features grouped into milestones, fulfilling criteria) and **ephemeral Tactical tasks in pi-dag-tasks** (with NO pointer field of any kind back into pi-charter). The text below is preserved for the evolution trace; read §18 for current ownership.

This section was originally written to make v2 not-confusing. Some of the confusion-prevention here aged poorly — §12 (rewritten) and §18 are the current source.

### 2.1 What each owns

| Primitive | Owns | Does NOT own | Lives in |
|---|---|---|---|
| **Mission** | Objective, status FSM, budget, evaluator reason, evidence index | Work breakdown, task ordering, tactical task status | pi-charter |
| **Macro DAG** | Features, milestones, `fulfills[]` join, feature-state bitmap | Tactical decomposition, turn-to-turn todos | pi-charter |
| **Contract** | Behavioral assertions, runners, evidence types, per-assertion status | Mission lifecycle, work ordering | pi-charter |
| **Tactical task list** | Turn-to-turn todos, dependencies, ready/blocked, in-progress | "Done means what", evidence, mission scope | pi-dag-tasks |

### 2.2 The join field

`fulfills[]` lives on **macro features**, not on tactical tasks. Features declare `fulfills: ["VAL-A-001", "VAL-A-002"]`. The arrow goes one direction: **features point at criteria, never the reverse**. Criteria don't know about features.

Tactical tasks (pi-dag-tasks) carry **no** `fulfills`, no `featureId`, no `charterId`. The earlier sketch of `fulfills` on tasks was rejected once the macro DAG was elevated into pi-charter (§18) and again when pi-dag-tasks was confirmed as a fully separate extension with no pointer field (§12 rewrite, b9 image evidence).

This matches Factory's pattern: `features.json[*].fulfills[]` → `validation-contract.md` IDs. It works in practice — we observed it on disk in `mis_622b326b`.

### 2.3 Why this avoids confusion

Today the natural question "should I make a task or add a criterion?" is ambiguous because both lists feel similar. v2 resolves it:

- **Add a criterion** when you're declaring *what counts as done*. The criterion is verifiable evidence.
- **Add a task** when you're declaring *work the agent needs to do*. The task may have dependencies and a status; it doesn't have evidence.

In other words: **criteria are about the artifact; tasks are about the labor.** They map many-to-many through `fulfills[]`.

A single sanity check the agent runs whenever a task or criterion is created:
> "If a human stranger ran your verify command, could they confirm this on their own, without watching the agent work?" — if yes, it's a criterion. If no, it's a task.

### 2.4 Drift detection between the two views

Once `fulfills[]` exists, three coverage views are computable:

- **Uncovered scope:** assertions claimed by zero `fulfills[]` entries. Either spec drift or unowned work.
- **Unverified scope:** assertions where some claiming task is `completed` but the assertion's verifier hasn't passed.
- **Wasted work:** completed tasks whose `fulfills[]` is empty. Either undeclared coverage (fix the task) or scope creep (fix the plan).

These three are what makes the join field worth its weight. Without them, `fulfills[]` is just metadata.

---

## 3. Detailed schemas

### 3.1 Goal — `Mission`

> Status name `CharterStatus` per the §20.1 rename. The original `GoalStatus` symbol is gone; `Goal` survives only as the `objective` field below.

```ts
type CharterStatus = 'planning' | 'active' | 'paused' | 'budget_limited' | 'review' | 'completed' | 'abandoned';

interface Mission {
  // Identity
  id: string;                       // UUID, regenerated on every replace (Codex /goal pattern: stale-write protection)
  version: 2;                       // for migration
  objective: string;                // ≤4000 chars, the durable "why"

  // Lifecycle
  status: CharterStatus;
  statusReason?: string;            // structured pause reason, e.g. 'unrecoverable_usage_402', 'evaluator_drift', 'user_paused'
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;

  // Budget (Codex shape)
  budget: {
    tokens?: number;
    wallClockSeconds?: number;
    turns?: number;
  };
  used: {
    tokens: number;
    wallClockSeconds: number;
    turns: number;                  // increments on TurnStarted
  };

  // Adaptive surfacing
  evaluator: {
    enabled: boolean;
    model?: string;                 // separate from main agent model — Factory split insight
    reasoningEffort?: 'low'|'medium'|'high';
    lastReason?: string;            // injected into next-turn steering
    lastVerdict?: 'on_track' | 'drifting' | 'blocked' | 'done';
    lastEvaluatedAtMs?: number;
    cadence?: 'every_turn' | 'every_n_turns' | 'on_signal';   // default every_turn
    cadenceN?: number;
  };

  // Charter file reference (optional; charters can run criteria-less)
  // charterPath is intentionally NOT a tool parameter (§20.2). The path is always
  // <charterDir>/charter.md when present; Symphony writes it directly, or the agent
  // authors it during planning. The kernel just records the digest.
  charterDigest?: string;          // sha256 of <charterDir>/charter.md; bust evaluator cache when changed

  // Risks, constraints, decisions (prose, but structured)
  constraints: string[];            // hard "do not" rules
  risks: { id: string; description: string; mitigations: string[]; status: 'open'|'mitigated'|'accepted' }[];
  decisions: { id: string; timestampMs: number; choice: string; rationale: string; alternatives?: string[] }[];

  // Bookkeeping
  events: CharterEvent[];              // typed, append-only — see §5
  evidence: EvidenceRecord[];       // append-only, indexed by criterionId — see §6
}
```

Note the deliberate omissions: **no `tasks[]`**, **no `criteria[]` inline**, **no `nextAction` string**. Tasks live in pi-dag-tasks; criteria live in the contract file; nextAction is a transient thing the evaluator produces.

### 3.2 Contract — Markdown, machine-readable

The contract is a **markdown file**, not JSON, for the same reason Factory uses markdown: humans need to edit it during the planning phase. But it's machine-readable.

```
# Goal contract: <objective>

Goal: <charterId>
Status: planning | active | locked
Generated: <iso>

---

## VAL-AREA-001: <short title>

<1-4 sentences, normative>

**Verifier**:
  - kind: command | prompt | hook | manual
  - command: <shell, optional>
  - prompt: <judge prompt, optional>
  - hook: <hook name to gate, optional>
  - timeout: <seconds, default 60>
  - evidenceType: stdout | exit_code | file | screenshot | network_trace | judge_verdict

**Evidence required**: <one sentence describing what makes this pass>
```

Parsed shape:

```ts
interface Criterion {
  id: string;                       // 'VAL-AREA-NNN' Factory-style
  title: string;
  description: string;
  verifier: {
    kind: 'command' | 'prompt' | 'hook' | 'manual';
    command?: string;
    prompt?: string;
    hook?: string;
    timeoutSeconds?: number;
    evidenceType: 'stdout' | 'exit_code' | 'file' | 'screenshot' | 'network_trace' | 'judge_verdict';
  };
  evidenceRequired: string;
  // dynamic state — NOT in the markdown, computed separately:
  status: 'pending' | 'passing' | 'failing' | 'blocked' | 'skipped';
  lastEvidenceId?: string;
  lastCheckedAtMs?: number;
}
```

Why markdown + computed status:
- During the planning phase, the contract is being *authored*. Editing JSON sucks.
- During execution, the status changes on every verify run. Storing dynamic status in the markdown causes diffs the user doesn't care about.
- Factory hit exactly this; their `validation-state.json` is the side-car.

### 3.3 Validation state — side-car bitmap

> The file name and location below were superseded by §10 (per-mission directory layout). The bitmap now lives at `<project>/.pi/charters/<charterId>/criterion-state.json` (renamed from `state-<charterId>.json` to make the criterion-vs-feature split explicit; the `state.json` slot in the new layout is the mission kernel state). The shape and role are unchanged.

`<project>/.pi/charters/<charterId>/criterion-state.json`:

```json
{
  "charterId": "...",
  "contractDigest": "sha256:...",
  "criteria": {
    "VAL-BOOT-001": { "status": "passing", "lastEvidenceId": "ev_42", "lastCheckedAtMs": 17311... },
    "VAL-BOOT-002": { "status": "pending" }
  }
}
```

Factory does this; it lets validators write directly without rewriting the contract markdown. We copy it verbatim (renaming `assertions` → `criteria` to keep terminology consistent with `Criterion` in §3.2).

### 3.4 Evidence record

```ts
type EvidenceRecord =
  | CommandEvidence
  | PromptJudgeEvidence
  | HookEvidence
  | FileEvidence
  | ManualEvidence;

interface BaseEvidence {
  id: string;                       // 'ev_<n>'
  criterionId: string;              // foreign key
  capturedAtMs: number;
  source: 'agent' | 'user' | 'hook' | 'subagent';
  sourceSessionId?: string;         // for handoffs from subagents
  passed: boolean;
}

interface CommandEvidence extends BaseEvidence {
  kind: 'command';
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;                   // capped, e.g. 8 KiB; pointer to file otherwise
  stderr: string;
  observation: string;              // 1-3 sentence agent-written interpretation
}

interface PromptJudgeEvidence extends BaseEvidence {
  kind: 'prompt';
  judgeModel: string;
  promptDigest: string;             // sha256 of the prompt sent
  verdict: 'pass' | 'fail';
  reason: string;
}

interface HookEvidence extends BaseEvidence {
  kind: 'hook';
  hookName: string;
  payload: Record<string, unknown>;
}

interface FileEvidence extends BaseEvidence {
  kind: 'file';
  paths: string[];                  // screenshot, trace, etc.
  description: string;
}

interface ManualEvidence extends BaseEvidence {
  kind: 'manual';
  attestor: 'user' | 'agent';
  statement: string;                // free text; weakest evidence
}
```

**This is the handoff envelope from §13 of `factory-mission-fact.md`, generalized.** Note `CommandEvidence` carries the `{command, exitCode, observation}` triple Factory uses. The other shapes are needed because not every criterion has a shell command.

### 3.5 Mission events (typed, append-only)

> Renamed per §20.1; the event type alias is `CharterEvent`, not `GoalEvent`. §18.10 / §20 add more event variants on top of the list below (feature_*, milestone_*, plan_locked, session_bound, session_unbound, items_dismissed).

```ts
type CharterEvent =
  | { type: 'created'; ts: number; objective: string }
  | { type: 'planning_started'; ts: number }
  | { type: 'plan_approved'; ts: number; contractDigest: string; criterionCount: number }
  | { type: 'activated'; ts: number }
  | { type: 'paused'; ts: number; reason: string }
  | { type: 'resumed'; ts: number }
  | { type: 'budget_exceeded'; ts: number; dimension: 'tokens'|'wallclock'|'turns'; used: number; budget: number }
  | { type: 'evaluator_verdict'; ts: number; verdict: string; reason: string; turnsActive: number }
  | { type: 'evidence_captured'; ts: number; criterionId: string; evidenceId: string; passed: boolean }
  | { type: 'criterion_status_changed'; ts: number; criterionId: string; from: string; to: string }
  | { type: 'task_linked'; ts: number; taskId: string; criterionIds: string[] }    // mirror from pi-dag-tasks
  | { type: 'risk_added' | 'risk_mitigated'; ts: number; riskId: string }
  | { type: 'review_requested'; ts: number; reason: string }
  | { type: 'items_dismissed'; ts: number; items: { type: string; summary: string; justification: string }[] }
  | { type: 'completed'; ts: number; verdict: 'achieved'|'partial'|'abandoned'; note?: string }
  | { type: 'cleared'; ts: number };
```

This is `progress_log.jsonl` from Factory, narrowed to the goal scope. The `items_dismissed` event is the explicit "we considered this and rejected it" capture from `handoff_items_dismissed` — possibly the highest-leverage event type because it makes orchestrator decisions inspectable.

---

## 4. Lifecycle

### 4.1 Status FSM

```
                  ┌───────────┐
   create ───────▶│ planning  │── contract authored, plan_approved ──┐
                  └─────┬─────┘                                       │
                        │ skip-planning                               │
                        ▼                                             ▼
                  ┌───────────┐  user pause   ┌───────────┐    activate
                  │  active   │◀──────────────│  paused   │◀──────────┘
                  └─────┬─────┘  resume       └───────────┘
                        │
              ┌─────────┼──────────┬─────────┐
              ▼         ▼          ▼         ▼
        ┌────────┐  ┌──────┐  ┌────────┐  ┌────────────────┐
        │ review │  │ done │  │aban-   │  │budget_limited  │
        └────────┘  └──────┘  │doned   │  └────────────────┘
              │               └────────┘
        re-evaluate
```

Notes:
- `planning` is **distinct from `active`**. While planning, the agent can write the contract markdown but cannot record evidence. This is Factory's plan/build separation.
- `review` is new: when all contract criteria are passing, the goal transitions to `review` (not `completed`) so the agent gets one explicit turn to inspect evidence and decide. Prevents premature completion.
- `budget_limited` is terminal-ish: in-flight evidence is flushed, but no new work is done. User can extend budget to unfreeze.
- `abandoned` is for "we're giving up on purpose"; structured pause + explicit verdict.

### 4.2 Two big additions vs v1

- **Planning phase** with explicit `plan_approved` event. The plan can be reviewed before execution and the user can refuse.
- **Review phase** before completion. The evaluator + user can stop the agent from declaring done prematurely.

---

## 5. Post-turn evaluator (Tier-S1, the highest-leverage feature)

### 5.1 What it does

After every assistant turn (or every N turns, configurable), a cheap model gets:
- goalObjective
- contract criterion statuses (pass/fail/pending counts; full text if cheap enough)
- last 1–3 assistant turns
- recent evidence records
- list of currently `in_progress` tasks from pi-dag-tasks

…and returns a structured JSON:

```ts
{
  verdict: 'on_track' | 'drifting' | 'blocked' | 'done',
  reason: string,                   // 1-3 sentences; INJECTED into next turn as steering
  proposedNextAction?: string,      // optional
  suggestedTaskChanges?: { type: 'add'|'block'|'complete'; taskId?: string; reason: string }[],
  riskFlags?: string[]
}
```

`reason` is what becomes the next turn's `<system-reminder>` content. Static every-8-turns reminder dies.

### 5.2 Why this is the unlock

It's the single biggest delta between Claude `/goal` (which has it) and Codex `/goal` (which uses a static template) and pi-goals v1 (which uses a static block). Adaptive context is the difference between "the agent remembers the goal exists" and "the agent gets nudged about *the specific way it's drifting right now*".

### 5.3 Cost control

- Separate model + reasoning-effort knob (Factory split). Default a fast cheap model.
- Cadence knobs: `every_turn` (default), `every_n_turns`, `on_signal` (only when a hook fires or budget changes).
- Skip on plan-mode turns (Codex `TurnStarted` skips in plan mode).
- Cache: if contractDigest + lastTaskSnapshot are unchanged and evaluator already returned `on_track` this minute, reuse the verdict.

### 5.4 Open question: where the evaluator runs

Two options:
- A. **In-process** in pi-charter (extension owns model call).
- B. **As a Pi hook** that any handler can subscribe to (LLM, deterministic, or external).

B is more composable but couples to the Pi hook bus. A is simpler. **Recommendation: A in v2, expose B as an escape hatch.**

---

## 6. Verifier (Tier-S2)

### 6.1 Per-criterion verifier kinds

Already shown in §3.2. Recap:
- `command` — run a shell, exit-code 0 ⇒ pass (plus optional stdout pattern).
- `prompt` — send a prompt to a judge model, JSON verdict.
- `hook` — fire a named Pi hook, await its `passed` payload.
- `manual` — user-attested; weakest, but explicit.

### 6.2 When verifiers run

Three triggers:
1. **Agent-requested.** Agent calls `charter_verify(criterionId)` or `charter_verify_all`.
2. **On `complete` proposal.** `charter_complete()` blocks until all criteria with verifiers have fresh evidence (within a configurable freshness window).
3. **On hook.** A `criterion_check_requested` hook can fire on demand.

### 6.3 Critical invariant — fresh evidence required

A goal cannot transition `active → review → completed` unless every criterion with a verifier has an evidence record dated after the criterion's verifier definition. Reasoning: stale evidence from before a contract change is meaningless.

### 6.4 Force-complete

There's an escape hatch: `charter_complete({force:true, note:string})`. This sets the goal to `completed` with `verdict:'partial'` and records a `forced_complete` event. Useful for genuine "we're shipping it anyway" moments. Logs are kept for forensics.

---

## 7. Planning phase (the Factory-style preplanning the user explicitly wanted)

### 7.1 Phase shape

> Updated per §18 (macro DAG inside pi-charter, not pi-dag-tasks) and §21 (smart-Ralph; tactical tasks carry no `fulfills`).

`charter_plan()` opens planning mode. The agent produces three deliverables in order (full version in §18.7):

1. **Charter draft** — `charter.md` with Objective / Criteria / Scope sections; VAL-* criteria are authored *before* features.
2. **Macro DAG** — one `plan/<featureId>.md` per feature with YAML frontmatter (`id`, `milestone`, `order`, `fulfills[]`, `preconditions[]`); `plan.json` is generated from frontmatter.
3. **Adversarial pass** by bundled `charter-planner-critic` persona (Plan-stress-test mode):
   - "What VAL-* assertions are unowned (no feature `fulfills[]` them)?"
   - "What features have empty `fulfills[]` (work without contract)?"
   - "Is the feature precondition DAG acyclic and topologically sortable? (preconditions are advisory at runtime per §21.2, but cycles are still nonsense.)"
   - "Estimated tokens × #features < budget?"
4. **Plan-approval gate** (`charter:before_lock_plan` event). Headless by default; the bundled TUI approver subscribes when `tuiApprover: on` (§10 in `orchestration-layering.md`). Orchestrators that gate elsewhere set `PI_CHARTER_TUI=off`.
5. On approve, charter transitions `planning → active`; both `charter.md` and `plan/` lock-by-digest.
6. Charter Criteria can still be amended via `charter_manage({action: 'amend_contract'})`, which mints a new charter digest and forces re-verification of affected criteria; re-enters `planning` briefly before returning to `active`.

Tactical tasks (pi-dag-tasks) are NOT part of planning. The agent may use them at runtime to organize within a single feature; they carry no `fulfills`, no `featureId`, no `charterId`.

### 7.2 Plan-mode coupling

While `status: planning`, the host agent SHOULD also be in plan mode (Codex Shift-Tab / Claude `/plan`). This is a recommendation, not enforcement; pi-charter doesn't own the host's permission state. But it can emit a hint via the reminder bus: "Goal is in planning; consider entering plan mode."

### 7.3 Why this is worth the complexity

The strongest signal from Factory is that **the plan is the contract**. Workers don't decide what "done" means; the validation contract does, and it's authored before any feature work starts. The result is dramatically less mid-implementation scope drift.

pi-charter makes this optional (you can `skip-planning`) but encourages it for any non-trivial goal.

---

## 8. Subagent / handoff envelope

### 8.1 The envelope

When a subagent returns to its parent, it MAY emit a handoff envelope:

```ts
interface HandoffEnvelope {
  parentCharterId: string;          // renamed per §20.1; conceptually equivalent to the old `parentGoalId`
  subagentSessionId: string;
  salientSummary: string;
  whatWasImplemented: string;
  whatWasLeftUndone: string;
  verification: {
    commandsRun: { command: string; exitCode: number; observation: string }[];
  };
  evidenceProduced: EvidenceRecord[];
  proposedCriterionUpdates?: { criterionId: string; toStatus: 'passing'|'failing' }[];
  discoveredIssues?: { type: string; summary: string }[];
}
```

This is Factory's handoff JSON, mostly verbatim. The parent applies it:
- Append `evidenceProduced` to the goal's evidence array.
- Update criterion statuses per `proposedCriterionUpdates`.
- For each `discoveredIssues` entry: either accept (creates a new criterion or task) or dismiss with justification (`items_dismissed` event).

### 8.2 How this integrates with Pi's subagent system

> **Updated per §19.5 (metadata passthrough) + §22.5 (subagent children never bind).** The earlier "subagent inherits the active charterId via spawn config" was wrong — that would put goal vocabulary on the spawn surface. The correct mechanism is opaque metadata.

Pi already has subagents (`subagent` tool). v2 adds:
- A new tool `charter_handoff_apply` that accepts the envelope.
- Bundled internal personas (`charter-verifier`, `charter-planner-critic`) registered via `subagent.registerPersonaDir` and the system prompt for `charter-evaluator` built dynamically via `subagent.spawnRaw` (§19).
- When pi-charter code spawns a child, it stamps `metadata: { "pi-charter.charterId": ..., "pi-charter.criterionId": ..., "pi-charter.featureId": ... }` on the spawn payload. pi-subagents never reads `metadata`; it just stamps it onto every `subagent:*` hook event payload. pi-charter' hook subscriber reads it on `subagent:completed` and routes the handoff back into the mission's evidence log.
- The child does NOT get a `~/.pi/agent/sessions/<sid>/charter.json` reverse-binding written for it. The child sees the mission only via inherited metadata + explicit `charterId` args on tools it calls (§22.5).

### 8.3 Why this matters

Without a handoff envelope, subagent work either gets lost (parent forgets what happened) or pollutes the parent's context (parent re-derives). The envelope is the compression of a subagent run into the parent's contract space.

---

## 9. Hooks + gates

### 9.1 New gateable events

| Event | Fired when | Decision-control |
|---|---|---|
| `charter:before_create` | `charter_manage({action: 'create'})` | block / allow / modify |
| `charter:before_complete` | `charter_complete()` | block / allow |
| `charter:before_amend_contract` | contract about to change | block / allow |
| `charter:after_evaluator` | evaluator verdict produced | observe only |
| `charter:before_evidence` | evidence about to be recorded | block / allow / annotate |
| `charter:before_force_complete` | force-complete attempted | block / allow |

### 9.2 Why "before_complete" is the big one

Claude Code's `TaskCompleted` decision-control hook is the cleanest mechanism in the field: a hook can refuse to mark a task done. pi-charter adopts it for goals. Combined with the `review` phase, it gives users two independent vetoes (evaluator + hook) before a goal completes.

### 9.3 Hook handler shapes

Same as Pi's existing hook bus: shell, HTTP, prompt-based (LLM-judged), or agent-based. No new infrastructure.

---

## 10. Persistence layout

> **2026-05-14 revision (b).** Earlier drafts flat-packed every artifact at the top level (one file per mission ID). That mirrored Factory but didn't scale to the per-feature narrative scratch space the agent actually wants.
>
> **2026-05-14 revision (c) — "Option A" charter collapse.** Earlier drafts had two authoring documents: `mission.md` (objective + outcomes) and `contract.md` (VAL-* assertions). After the rename to **pi-charter**, the natural shape is a single `charter.md` with three sections — the charter literally IS the binding document. One file replaces two; `charter_amend` operates on sections (`objective` / `criteria` / `scope`) rather than on whole files. Symphony mitigation simplifies: "if `<charterDir>/charter.md` exists, reuse verbatim and skip authoring."

```
<project>/.pi/charters/                          per-project (mirrors v1's <cwd>/.pi/goals/)
├── index.json                             registry: [{id, status, sessionId?, objective, updatedAt}, ...]
├── <charterId>/
│   ├── charter.md                         the binding document — three sections:
│   │                                      ## Objective         (was mission.md)
│   │                                      ## Criteria          (was contract.md — VAL-* assertions)
│   │                                      ## Scope and constraints
│   ├── plan/                              one markdown file per feature
│   │   ├── m1-bootstrap.md                 frontmatter (id, milestone, fulfills[], preconditions[]) + spec body
│   │   ├── m1-types-schemas.md
│   │   └── ...                             25 features = 25 files
│   ├── work/                              mirrors plan/ for runtime artifacts
│   │   ├── m1-bootstrap/
│   │   │   ├── notes.md                    agent's narrative scratch (optional, append-friendly)
│   │   │   └── evidence/
│   │   │       ├── VAL-BOOT-001__2026-05-14T10-32-15Z.json
│   │   │       └── ...                      one JSON per evidence record
│   │   └── .../                            one dir per feature; created lazily on first artifact
│   ├── handoffs/                          only when agent delegates
│   │   └── <ts>__<featureId>__<sessionId>.json
│   ├── events.jsonl                       typed event log (append-only)
│   ├── state.json                         kernel: status, budget, timestamps, digests, sessionId binding
│   ├── plan.json                          indexed sidecar: parsed plan/*.md
│   ├── feature-state.json                 per-feature status bitmap (computed)
│   ├── criterion-state.json               per-criterion status bitmap (computed)
│   └── result.json                        written on terminal transition
└── archive/
    └── <charterId>/                       tar.gz on completion if configured; otherwise move
```

### 10.0 Scoping rule (per-project, not per-machine)

Missions live under the project root (`<project>/.pi/charters/`), matching v1's `<cwd>/.pi/goals/` scoping. Consequences:

- **Multiple missions can coexist in any state within one project.** No global "active" symlink — that was the v1.0 draft mistake. A project may have one mission running, one paused, two archived; all visible in `index.json`.
- **Worktrees are isolated automatically.** Different cwd → different `.pi/charters/` tree → no cross-contamination. Matches the pi-extensions worktree pattern.
- **"Active for this agent" is a session-level binding, not a filesystem flag.** `state.json` records the `sessionId` that claimed the mission on its last transition; `charter_status` with no `charterId` resolves to the mission bound to the current session.
- **No machine-wide registry.** Cross-project mission discovery ("what missions am I running across all projects") is out of scope; if the user wants it, it's a separate `pi missions ls --all` CLI that walks known project roots.

Resolution order for `charter_status({charterId?})` with no argument:
1. If exactly one mission has `state.json.sessionId == currentSessionId`, return it.
2. Else if exactly one mission has `status: active`, return it.
3. Else error with the list from `index.json` and ask for explicit `charterId`.

### 10.1 Two authoring tiers

| Tier | Files | Owner | Format |
|---|---|---|---|
| Source of truth | `charter.md` (three sections), `plan/*.md`, `work/<featureId>/notes.md` | human + agent | markdown with optional YAML frontmatter |
| Computed sidecar | `state.json`, `plan.json`, `feature-state.json`, `criterion-state.json`, `result.json`, `events.jsonl`, `evidence/*.json`, `handoffs/*.json` | runtime | JSON — never hand-edited; regenerated on demand |

Humans edit the markdown; agents read both. Sidecars exist so `charter_status` doesn't have to re-parse markdown on every call.

### 10.2 What does NOT live in the directory (rejected proposals)

- **`implementation.md` per feature** — git commits + `plan/<featureId>.md` spec already say what was built; free-text narrative duplicates the diff. The `work/<featureId>/notes.md` covers the "what was hard" narrative slot when the agent wants it.
- **`review.md` per feature** — when the agent delegates a review, `handoffs/<ts>__<featureId>__*.json` is the structured envelope. When it doesn't delegate, evaluator reasons land in `events.jsonl`. A separate review.md would be either empty or duplicate one of those two.
- **`validation.md` per feature** — `work/<featureId>/evidence/VAL-*__<ts>.json` records are queryable and tied to criterion IDs. A free-text validation.md loses the criterion link.

### 10.3 Per-feature directory creation policy

`work/<featureId>/` is created lazily on first artifact (first evidence record, first `notes.md` append, first handoff returned). Empty features don't leave empty dirs. After mission completion, the entire `<charterId>/` is either left in place or moved to `archive/` (configurable).

### 10.4 plan/<featureId>.md frontmatter

Each feature file:

```markdown
---
id: m1-types-schemas
milestone: m1-bootstrap
order: 2
fulfills: [VAL-MANIFEST-001, VAL-MANIFEST-002, VAL-SLUG-014]
preconditions: [m1-bootstrap-workspace]    # advisory, not gate (see §21.2)

# m1-types-schemas — Core types + Zod schemas + target registry

## Why
...

## Expected behavior
- ...
- ...

## Out of scope
- ...
```

The frontmatter is the **declarative part only** (id, milestone, order, fulfills, preconditions). Runtime fields — `status`, `startedAt`, `completedAt`, `lastWorkerSessionId` — live exclusively in `feature-state.json`. Two reasons: (1) markdown is human-edited and would drift; (2) status flips happen on hot paths (verifier returns, evaluator events) and rewriting frontmatter on every flip is fragile. `plan.json` is generated from the frontmatter on demand; `feature-state.json` is the single mutable progress bitmap. Same rule for criteria: `charter.md §Criteria` is declarative; `criterion-state.json` is mutable.

Compared to v1 (one flat JSON file), this is more files but each has a single concern and the markdown surfaces are diff-friendly. Migration writes the v1 JSON into `charter.md` (objective → §Objective; criteria → §Criteria with no verifier; constraints → §Scope and constraints); existing fields map directly.

---

## 11. CLI / tool surface

> Superseded across the board by §20.5 (entry points), §20.10 (final tool grouping, below); kept here as historical context. The original 12-tool sketch was rejected as too many. Four tools by cognitive shape is locked.

### 11.1 LLM-callable tools — four tools, four shapes

Four tools grouped by what the agent is doing, not by what's getting written:

| Tool | Cognitive shape | Actions | When |
|---|---|---|---|
| `charter_manage` | Lifecycle FSM | `create` · `pause` · `resume` · `complete` · `force_complete` · `amend_contract` | State transitions on the mission itself |
| `charter_plan` | Planning DAG editing | `add_feature` · `update_feature` · `view` | Planning phase + mid-flight amendments |
| `charter_record` | Execution-time writes | `evidence` · `verify` · `handoff_apply` | Active phase: writing evidence, running verifiers, applying subagent handoffs |
| `charter_status` | Read-only | (one read) | Every turn: drift views + last evaluator reason + `nextActions[]` |

**Key design rule — `nextActions[]` on every return.** Every tool return carries:

```ts
{
  ok: boolean,
  ...result,
  nextActions: [
    { tool: 'charter_record',  action: 'evidence',  hint: 'Record evidence for VAL-OAUTH-003 — verifier ran but no record exists.' },
    { tool: 'charter_plan',    action: 'view',      hint: 'Macro DAG has 4 ready features; pick one before delegating.' },
    { tool: 'charter_manage',  action: 'complete',  hint: 'All criteria pass; propose completion.' }
  ]
}
```

`nextActions[]` is filtered by current state (planning / active / review / paused) so the agent never sees illegal moves. The lifecycle FSM lives in tool returns, not in docs the agent has to memorize. Skill content stays thin: when to use missions, the three phases, the two guideline rules, the escape rules.

`charter_status` returns a structured payload:

```ts
{
  charterId: string,
  status: 'planning' | 'active' | 'review' | 'paused' | 'completed' | 'budget_limited' | 'abandoned',
  phase: 'planning' | 'active' | 'review',
  objective: string,
  budget: { tokens: { used, limit }, turns: { used, limit }, wallclockMs: { used, limit } },
  evaluator: { lastVerdict: 'aligned' | 'drifting' | 'stuck' | 'off-track' | 'complete', lastReason: string, lastTs: number },
  drift: {
    uncovered: string[],        // criterion ids with no fulfilling feature
    stuck: string[],            // feature ids in_progress > N turns
    stale: string[],            // criterion ids with evidence older than contractDigestUpdatedAt
    readyNext: string[]         // feature ids whose preconditions cleared (advisory)
  },
  guidelines: string[],         // 3 always-present guideline reminders (decision / loop / escape)
  nextActions: NextAction[]
}
```

### 11.2 Slash commands — single `/charter` tree (Droid-style)

One slash, all subcommands. Bare opens the TUI; positional shortcut creates a mission.

```
/charter                        open widget / TUI (current mission status, drift views, evaluator reason)
/charter <objective>            shortcut: create new mission with that objective (planning phase)
/charter new                    explicit: create new mission (prompts for objective)
/charter ls                     list missions in this project (active, paused, completed)
/charter resume <id>            rebind current session to an existing mission (user authority)
/charter clear                  unbind current session from its mission (mission keeps running)
/charter status [verbose]       same as `charter_status` tool, but for the human
/charter pause                  pause current mission with reason prompt
/charter resume                 resume the currently bound paused mission
/charter force-complete         human escape hatch; fires charter:before_force_complete hook
/charter untrust-evaluator      M2 polish: stop showing evaluator steers for this mission
```

No plural `/charters`. The bare `/charter` is the TUI entry point.

### 11.3 CLI flags (`pi.registerFlag()`)

Two flags, both consumed by pi-charter' `session_start` handler before turn 1:

```
pi --charter-objective "<text>"   create + bind mission before turn 1
pi --charter-resume <id>          rebind session to existing mission before turn 1
```

No `--charter-spec`. Spec handling is a plain English instruction in the spawn prompt; the agent reads the file with its standard file tools. See §20.5 for the rationale.

### 11.4 Status indicator

Persistent status-bar widget: `◎ mission · 12 / 47 criteria · 3450 / 10000 tokens · last verdict: drifting (3m ago)`. Click/keypress opens the bare `/charter` TUI.

---

## 12. Combining with pi-dag-tasks — the explicit confusion-avoidance plan

This is the section the user flagged. Worth being precise.

> **2026-05-14 correction.** Earlier drafts of this section proposed adding two bridge fields (`fulfills?`, `goalId?`) to pi-dag-tasks. **That was wrong** and has been removed. pi-dag-tasks stays fully separate with **no pointer field of any kind into pi-charter**. Coupling is hook-events-only, lives entirely on the pi-charter side, and arrows point up only. The same layering rule that forbids `goalId` on pi-subagents spawn surfaces applies here: no missions vocabulary downstack.

### 12.1 The user-visible contract

> **Tasks are *work*. Criteria are *checks*. They live in separate extensions and do not point at each other.**

That sentence becomes the canonical disambiguation prompt the agent sees in both extensions' reminders.

### 12.2 What changes in pi-dag-tasks

**Nothing.** No `fulfills?`, no `charterId?`, no schema additions, no new hook payload fields. pi-dag-tasks keeps its ownership of decomposition, ready/blocked, status FSM, archive log, widget — unchanged.

The one thing pi-dag-tasks already does that pi-charter consumes: it emits `tasks:after_complete` / `tasks:after_create` / `tasks:after_update` hook events with the standard payload `{taskId, title, status, blockedBy, ...}`. pi-charter subscribes; pi-dag-tasks does not know it has a subscriber.

### 12.3 What changes in pi-charter

- pi-charter optionally subscribes to `tasks:*` hook events to enrich its evaluator snapshot ("the agent just completed task X").
- `charter_status` MAY include a coarse computed view ("N tasks open right now") if a hook subscriber has aggregated it.
- pi-charter never queries pi-dag-tasks state by API; it sees only what the hook bus delivers.
- The macro DAG (features inside the mission plan) is pi-charter-owned and uses its own IDs (`feature.id`), entirely independent of pi-dag-tasks' `taskId`.

### 12.4 What does NOT change

- pi-dag-tasks does not learn about evidence, verifiers, evaluators, or missions.
- pi-charter does not learn about task dependencies, ready/blocked, or activeForm.
- Neither extension calls the other's tool from its tool surface; they communicate only via the hook bus and the shared user files.

### 12.5 The decision tree the agent uses

When the agent is about to record something:

```
Is this an artifact / observable behavior?
├── Yes → criterion (in mission contract)
│         Does it need a verifier?
│         ├── Yes → command / prompt / hook / manual
│         └── No  → criterion without verifier (manual completion)
└── No → is it a durable plan-step (hours–days, survives compression)?
          ├── Yes → mission plan feature (pi-charter, with fulfills[] into contract)
          └── No  → tactical task (pi-dag-tasks, ephemeral)
```

This decision tree goes into both extensions' system prompts.

### 12.6 The risk we explicitly accept

There will be borderline cases. Example: "run the test suite" — is that a tactical task or a criterion? The answer is: **the criterion owns the truth, the task is the work toward it, and the two are not linked by field**. The criterion says "test suite passes" with a `command` verifier; the criterion lives in the mission contract. A tactical task in pi-dag-tasks may say "make test suite pass" — it carries no `fulfills` field, no `charterId`. The agent re-derives the relationship from the conversation, the active mission, and the contract markdown. Duplicate-ish information is acceptable; coupled extensions are not.

When the agent gets it wrong (it will), the drift views from §2.4 catch it within a few turns.

---

## 13. Migration from v1

### 13.1 Schema lift

```
v1 GoalState                       → v2 Mission
─────────────────────────────────────────────────────
id                                 → id (unchanged)
objective                          → objective
status: active|paused|completed    → status: active|paused|completed (3 of 7 — others added)
criteria: string[]                 → contract criteria with kind:'manual' verifier
constraints: string[]              → constraints (unchanged)
nextAction?: string                → evaluator.lastReason (transient)
evidence: string[]                 → evidence[] of kind:'manual' with statement = item
risks: string[]                    → risks[] with structured shape; description=item; mitigations=[]
turnsActive                        → used.turns
completionNote                     → events: last 'completed' event note
```

`version: 2` flag distinguishes them. v1 files load via a one-shot adapter, get rewritten on first mutation.

### 13.2 Two-week soft period

Keep v1 tool surface working for two weeks; emit deprecation warnings; auto-upgrade files on first touch.

---

## 14. Risk ladder

Ranked by how much pain they'd cause if we ship them wrong.

### 14.1 Top risks
1. **Evaluator-on-every-turn cost.** If we run a cheap model on every turn, latency and tokens add up. **Mitigations:** cache by contractDigest+taskSnapshot; default cadence `every_turn` but auto-degrade to `every_3_turns` if tokens > 50% of budget.
2. **Contract authoring friction.** Markdown is more typing than v1's string-list. **Mitigations:** `skipPlanning:true` for trivial goals; LLM-assisted contract drafting via `/goal plan`.
3. **Cross-extension confusion.** Despite §12 effort, tasks ↔ criteria will still collide. **Mitigations:** decision tree in system prompt; drift views surface miscategorization within a few turns; widget shows both side by side.
4. **Force-complete abuse.** Users will reach for `force:true` to escape stuck verifiers. **Mitigations:** record a structured `forced_complete` event; widget shows `partial verdict` badge; deny `force` if `criterionPassingRatio < 0.5` unless `--allow-deeply-incomplete`.
5. **Stale evidence on mission_id replacement.** Codex's bug fix here is FACT-level (`expected_mission_id` mismatch silently dropped). **Mitigation:** copy it verbatim — every replace mints a new UUID, evidence carrying mismatching `charterId` is dropped.
6. **Subagent envelope drift.** If subagents diverge in what they emit, the parent's apply logic breaks. **Mitigation:** strict zod schema; envelope generation is a Pi-side library helper, not freeform.

### 14.2 Medium risks
- File layout proliferation (one dir per goal). Solved by archiving on complete.
- Hook bus stalls if a `before_complete` handler hangs. Default 10s timeout; auto-skip.
- Token blow-up if contract gets huge. Cap at 32 KiB (Codex AGENTS.md precedent).

### 14.3 Low risks
- Migration from v1 (lift is mostly trivial).
- Widget rendering (re-use pi-dag-tasks widget infra).

---

## 15. Implementation phases

> Updated per §19.8 (M0 prereq in pi-subagents) and §20.10 (intent-sentinel deprecation phasing). The pi-dag-tasks `fulfills?` field is REMOVED — pi-dag-tasks carries no pointer field into pi-charter (§12 rewrite, b9 image evidence).

Four milestones, with the assumption v1 stays running until M2 ships and intent-sentinel uninstalls in M3.

### M0 — pi-subagents API additions (1–2 days)
- `scope: "internal"` in role topology (subagent.json).
- `subagent.spawnRaw({ systemPrompt, prompt, ... })` TypeScript API.
- `subagent.registerPersonaDir({ extensionId, path, scope: "internal" })` startup hook.
- `metadata: Record<string, unknown>` opaque passthrough on `subagent:*` hook events.
- CI grep guard: no `goal_*`, `Goal` typename, or `pi-charter.*` keys hardcoded inside pi-subagents source.

### M1 — Core lift + back-compat (1–2 days)
- `Mission` schema + Zod parsers.
- v1-to-v2 adapter on read (auto-migrates `<cwd>/.pi/goals/goal-*.json` to `<project>/.pi/charters/<charterId>/` layout).
- New CLI/tools (`charter_manage({action: 'create'})`, `charter_status`, etc.) functioning, but no evaluator, no verifier, no contract — pure shape upgrade.
- Status FSM (without `planning` / `review`; both elide to `active` until M2).
- Session↔mission binding (§22): forward `state.json.sessionId` + reverse `~/.pi/agent/sessions/<sid>/charter.json`.
- **Smart-Ralph loop foundations**: drift views in `charter_status` return; three always-present guideline reminders (decision / loop / escape, §21.5) injected when `mission.status == active`.

### M2 — The contract + verifier (2–3 days)
- Contract markdown parser.
- `criterion-state.json` bitmap (renamed from earlier draft's `state-<charterId>.json`).
- `feature-state.json` bitmap (per-feature status, separate from criterion bitmap).
- `charter_amend`, `charter_record_evidence`, `charter_verify` tools.
- Verifier runners: command + manual at minimum; prompt + hook follow.
- `planning` and `review` phases enabled.
- Bundled `charter-verifier` + `charter-planner-critic` personas (registered via M0's `registerPersonaDir`).
- Per-criterion `requireFreshEvidence` / `requireReviewSubagent` flags (§21.4).
- Plan-approval gate fires `charter:before_lock_plan` event. Bundled TUI approver subscribes; `tuiApprover: on` default, `PI_CHARTER_TUI=off` override.

### M3 — Evaluator + handoff + intent-sentinel fold (2–3 days)
- `charter-evaluator` via `spawnRaw` with dynamic system prompt (§19.3, §20.6 dual-mode).
- Intent-sentinel marked deprecated; 2-week soft period; then uninstall.
- Steering reason injection via reminder bus.
- Handoff envelope schema + `charter_handoff_apply`; auto-apply when the agent invokes `charter-verifier`.
- Hook events with decision-control.
- Widget shows evaluator verdict + contract coverage.

### Stretch (post-M3)
- Auto-continuation (Codex `/goal` MaybeContinueIfIdle): only if pi-bar / host integration is solid.
- Multi-goal stacking (parent + child goals): probably v3.
- TUI contract editor with criterion templates.

Total estimate: ~5–8 focused days for a single experienced implementor. Much more if you want polish + tests.

---

## 16. What v2 deliberately leaves out (for v3+)

- **Auto-continuation loop.** Codex has it; it couples to the host agent.
- **Multi-agent orchestration / Mission Control.** Factory's strength; out of scope for a single-session tracker.
- **Goal hierarchy.** Parent goals containing child goals. Tempting but doubles the FSM complexity.
- **Cross-session goal aggregation.** A user-level dashboard across all goals across all projects.
- **Cloud sync of goals.**
- **Goal templates / a goal "marketplace".**

These are the obvious follow-ons. Calling them out so we don't accidentally accept scope creep for v2.

---

## 17. The strongest single sentence about v2

> v2 makes "done" inspectable: every mission carries a contract of evidenced behavioral assertions, a macro DAG of features that `fulfills[]` those criteria, a post-turn `charter-evaluator` (folded with intent-sentinel, dual-mode) that surfaces drift each turn, and a handoff envelope that binds command → exit-code → observation triples to evidence — all owned by `pi-charter`, with the agent itself as the loop (smart-Ralph, §21); tactical tasks live in `pi-dag-tasks` as a fully separate extension that carries no pointer field back.

If a future agent reads only this paragraph, they have enough to reconstruct the architecture.

---

## 18. Revision — The three-tier model (supersedes §2 framing)

> Added after user feedback: *"pi-dag-tasks is more short-term — but we could have some sort of higher-level DAG, no?"*
>
> The two-primitive model (Goal + Contract, with pi-dag-tasks as a sibling) was incomplete. The macro DAG is a third primitive, durable like the goal, distinct from both the contract (which says *what must be true*) and tactical tasks (which say *what am I doing this minute*). This section is the correct framing; §2 is preserved for the evolution trace.

### 18.1 Why the macro DAG is its own primitive

It's tempting to think "the macro DAG is just criteria grouped by milestone" — but inspecting Factory's `features.json` shows it isn't. A *feature* is a unit of WORK; a *criterion* is a CHECK. They're related but distinct concepts.

**Feature shape — smart-Ralph version (§21.2 locked in; supersedes the earlier Factory-shaped struct):**

```ts
interface Feature {                  // the work unit (durable, lives in plan/<featureId>.md frontmatter)
  id: string;                        // 'm1-bootstrap-workspace'
  milestone: string;                 // 'm1-bootstrap'
  order: number;                     // sortable position inside milestone
  description: string;               // what work to do (markdown body, not frontmatter)
  preconditions: string[];           // other featureIds; ADVISORY at runtime, not gates (§21.2)
  fulfills: string[];                // ← join key to VAL-* criteria
  // Runtime fields are NOT in the markdown frontmatter — they live in feature-state.json:
  //   status:      'pending' | 'in_progress' | 'completed' | 'blocked'
  //   startedAtMs, completedAtMs
  //   lastWorkerSessionId? (only set when the agent itself delegated to a subagent for this feature)
}
```

What changed from the earlier draft (and from Factory):
- **`skillName` removed.** No auto-spawn scheduler picks workers; the agent itself decides whether to delegate.
- **`workerSessionIds[]` / `currentWorkerSessionId` / `completedWorkerSessionId` removed.** No worker pool; at most one optional `lastWorkerSessionId` recorded in `feature-state.json` when the agent itself chose to delegate.
- **`expectedBehavior` removed from struct.** Prose lives in the markdown body of `plan/<featureId>.md`, not in a string array.
- **`status` moved to sidecar.** `feature-state.json` is the single mutable progress bitmap; `plan/<featureId>.md` frontmatter is declarative-only (§10.4).

Features still map many-to-many to criteria via `fulfills[]`. The same criterion could be touched by multiple features (regression surface); a single feature usually fulfills many criteria.

### 18.2 The three-tier model

| Tier | Primitive | Owner | Lifetime | Granularity | Survives compression | Example |
|---|---|---|---|---|---|---|
| 1 | **Goal** | pi-charter | session(s) → many days | 1 per session | yes | "Ship the new auth flow" |
| 2a | **Macro DAG** (features + milestones) | pi-charter | hours → days | 5–50 per goal | yes | "m2-oauth-callback" |
| 2b | **Contract** (criteria) | pi-charter | as long as goal | 10–500 per goal | yes | "VAL-AUTH-014" |
| 3 | **Tactical tasks** | pi-dag-tasks | turn → turn | 3–15 alive at once | usually yes (durable widget) but content churns rapidly | "edit auth.ts handler" |

Three durable primitives (Goal, Macro, Contract) live in pi-charter. One ephemeral primitive (Tactical) lives in pi-dag-tasks. **pi-charter owns the *plan*; pi-dag-tasks owns the *to-do list*.**

### 18.3 The bridges (one direction each)

```
              ┌──────────┐
              │   Goal   │
              └────┬─────┘
                   │ "the plan for this goal is:"
                   ▼
   ┌──────────────────────────────┐         ┌─────────────────┐
   │  Macro DAG (features + ms)   │──fulfills──▶│   Contract     │
   │  - durable work units        │             │  (VAL-* checks)│
   └─────────────┬────────────────┘             └─────────────────┘
                 │ optional
                 │ "tasks helping this feature:"
                 ▼
   ┌──────────────────────────────┐
   │  Tactical tasks (pi-dag-tasks)│
   │  - turn-to-turn todos        │
   └──────────────────────────────┘
```

- A **macro feature** declares `fulfills: ["VAL-AUTH-014", "VAL-AUTH-015"]`.
- A **tactical task** may declare `featureId: "m2-oauth-callback"`.
- The arrow always points up. The contract doesn't know about features; features don't know about tasks; the layer above never has to know about the layer below.

### 18.4 Updated decision tree

Now the agent's "what kind of thing is this?" question has three levels:

```
What am I trying to capture?

├── A durable objective with a budget?                  → Goal
│
├── A unit of work that produces evidence?              → Macro feature
│   (durable, multi-hour or multi-day, survives compression,
│    will be assigned to a worker / handoff envelope)
│       └── declare fulfills[] for the criteria it covers
│
├── A behavioral check / "done means what"?             → Contract criterion
│   (artifact-shaped, has a verifier, evidence schema)
│
└── A short-term todo I need to remember this hour?     → Tactical task
    (ephemeral, may carry featureId, no evidence schema)
```

Worth memorizing: **goal = why, contract = done, feature = work, task = next step.**

### 18.5 Why the macro DAG belongs inside pi-charter (not a third extension)

We considered splitting it into a sibling `pi-plan` extension. Rejected:

- Three extensions amplifies the confusion the user was already worried about.
- The macro DAG and the contract are co-edited during planning; they share a digest and a lock.
- A goal without a macro DAG is fine (single-feature implicit). A macro DAG without a goal is nonsensical.
- Internal modularity is what we actually want: a `plan/` module inside pi-charter can later be split if it grows large, without breaking the LLM tool surface.

### 18.6 Why pi-dag-tasks stays separate

> Updated per b9 image evidence + §12 rewrite: there is **no `featureId` bridge** on pi-dag-tasks. Coupling lives entirely on the pi-charter side via hook subscription.

- Tactical tasks are useful **outside any mission context** — quick "remember to do X" scratchpad work.
- The persistent widget UX (status icons, compact mode, reminder cadence) is non-trivial and worth keeping in one place.
- Forcing every quick todo through pi-charter would be heavy.
- No bridge field needed: pi-charter subscribes to `tasks:*` hook events (`{taskId, title, status, blockedBy, ...}`) if it wants context; pi-dag-tasks doesn't know it has a subscriber. The agent re-derives the relationship from the active mission + the contract, not from a struct field.

### 18.7 Concrete shape: how the planning phase produces the macro DAG

> Path/filename details below were superseded by §10 per-mission directory layout. Updated names:
>
> - `contract-<charterId>.md` → `<project>/.pi/charters/<charterId>/charter.md §Criteria`
> - `plan-<charterId>.json` → one `<project>/.pi/charters/<charterId>/plan/<featureId>.md` per feature (frontmatter is the declarative part); `plan.json` is the computed sidecar generated from frontmatter.
>
> The adversarial pass is performed by the bundled `charter-planner-critic` persona (§19.1).

During `charter_plan`, the agent produces three deliverables in order:

1. **Charter draft** (`charter.md`) — Objective / Criteria / Scope sections; VAL-* criteria are written before any features.
2. **Macro DAG** (`plan/<featureId>.md` files, one per feature, each with YAML frontmatter `id`/`milestone`/`order`/`fulfills`/`preconditions`).
3. **Plan-stress-test report** — adversarial pass by `charter-planner-critic`:
   - Every VAL-* assertion is claimed by at least one feature? (uncovered scope check)
   - Every feature `fulfills[]` is non-empty? (orphan-feature check)
   - Feature precondition DAG is acyclic and topologically sortable? (planning sanity; preconditions are advisory at runtime, but cycles are still nonsense)
   - Estimated tokens × #features < budget? (budget sanity)

Then the `charter:before_lock_plan` event fires (TUI approver subscribes if `tuiApprover: on`); mission transitions `planning → active`; both the contract markdown and the `plan/` tree lock-by-digest.

### 18.8 Updated persistence layout

> **Superseded by §10** — the flat layout below was an intermediate draft. The locked per-mission directory layout (one folder per mission with `plan/`, `work/`, `handoffs/`, computed sidecars) is in §10. Read §10 for the current structure; the sketch below is preserved only because §18's numbering otherwise breaks.

Key corrections vs. the original §18.8 sketch:
- `goal-<charterId>.json` → `state.json` (mission kernel state) inside `<charterId>/`
- `contract-<charterId>.md` → `charter.md §Criteria` inside `<charterId>/`
- `plan-<charterId>.json` → `plan/<featureId>.md` files (declarative source of truth) + `plan.json` (computed sidecar) inside `<charterId>/`
- `state-<charterId>.json` → `criterion-state.json` inside `<charterId>/`
- `feature-state-<charterId>.json` → `feature-state.json` inside `<charterId>/`
- `events-<charterId>.jsonl` → `events.jsonl` inside `<charterId>/`
- `evidence/<charterId>/*.json` → `work/<featureId>/evidence/VAL-*__<ts>.json` (per-feature)
- `handoffs/<charterId>/*.json` → `handoffs/<ts>__<featureId>__<sessionId>.json` inside `<charterId>/`
- `active.json` REMOVED — multiple missions coexist per project; binding is per-session via `state.json.sessionId` (§22.1).

**Feature record in `plan.json` (computed from `plan/<featureId>.md` frontmatter):**

```json
{
  "charterId": "...",
  "planDigest": "sha256:...",
  "milestones": [
    { "id": "m1-bootstrap", "title": "Workspace bootstrap", "order": 1 },
    { "id": "m2-oauth-callback", "title": "OAuth callback flow", "order": 2 }
  ],
  "features": [
    {
      "id": "f1-pin-deps",
      "milestone": "m1-bootstrap",
      "order": 1,
      "preconditions": [],
      "fulfills": ["VAL-BOOT-001", "VAL-BOOT-002"]
      // no skillName, no status, no workerSessionIds[] — see §18.1 + §10.4
    }
  ]
}
```

**`feature-state.json` (single mutable progress bitmap):**

```json
{
  "charterId": "...",
  "planDigest": "sha256:...",
  "features": {
    "f1-pin-deps": {
      "status": "completed",
      "lastWorkerSessionId": null,        // only set when the agent itself delegated
      "lastHandoffId": "ho_42",
      "completedAtMs": 17311...
    }
  }
}
```

No `workerSessionIds[]` array — there's no worker pool to track. If the agent chose to delegate this feature to a subagent, the most recent session id lands in `lastWorkerSessionId`; that's it.

### 18.9 Updated tool surface (delta vs §11.1)

Add three feature-level tools:

| Tool | Purpose |
|---|---|
| `charter_plan_add_feature` | Append a feature to the macro DAG during planning (or via amend) |
| `charter_plan_update_feature` | Status / preconditions / fulfills mutations |
| `charter_plan_view` | Read plan with computed status (next-ready features, blocked features, uncovered VAL-*) |

Keep `charter_manage({action: 'create'|'complete'|...}) / charter_record({action: 'evidence'|'verify'|...})` etc. unchanged — v2 already uses the four-tool surface (§11).

### 18.10 Updated event types (delta vs §3.5)

> Updated per §21.2 (no auto-spawn scheduler). The original list had `worker_*` events; those are gone because there's no scheduler emitting them. `lastWorkerSessionId` is only carried on the optional delegation event the agent itself fires through `subagent:completed`.

Add to `CharterEvent`:

```ts
| { type: 'plan_locked'; ts: number; planDigest: string; featureCount: number }
| { type: 'feature_added'; ts: number; featureId: string; fulfills: string[] }
| { type: 'feature_started'; ts: number; featureId: string }              // agent moved to status: in_progress
| { type: 'feature_completed'; ts: number; featureId: string; handoffId?: string }
| { type: 'feature_failed'; ts: number; featureId: string; reason: string }
| { type: 'milestone_gate_passed'; ts: number; milestoneId: string }
| { type: 'milestone_gate_failed'; ts: number; milestoneId: string; failingCriteria: string[] }
| { type: 'session_bound' | 'session_unbound'; ts: number; sessionId: string }  // per §22
```

No `worker_selected_feature` / `worker_started` / `worker_completed` / `worker_failed` events — the agent is the loop (§21). Subagent delegations the agent itself initiates emit `subagent:*` hook events with `metadata["pi-charter.featureId"]` (§19.5); pi-charter transforms relevant ones into `feature_started` / `feature_completed` `CharterEvent` entries via its hook subscriber.

### 18.11 Updated drift views (delta vs §2.4)

The original three views remain. Add two:

- **Stuck features:** features whose `preconditions` are all complete but status is `pending` for > N turns. Either the worker missed it or the precondition arrow is wrong.
- **Milestone debt:** features `completed` for a milestone, but the milestone gate hasn't been run. Surfaces forgotten validation passes.

### 18.12 What v2's "most powerful" stance buys with this revision

| Capability axis | v1 | v2 (two-tier) | v2 (three-tier, locked) |
|---|---|---|---|
| Representation | objective + flat lists | + contract + verifier kinds | + macro DAG (features + milestones) |
| Decomposition | none | none (lived in pi-dag-tasks) | **macro DAG with `fulfills[]` join, owned by pi-charter** |
| Persistence | one JSON | JSON + contract state | per-charter directory: `charter.md` (three sections) + `plan/<featureId>.md` + `work/<featureId>/` + computed sidecars (§10) |
| Surfacing | static every-8-turns | post-turn evaluator | + plan-aware evaluator + drift views in `charter_status` (stuck features, milestone debt, stale evidence, ready-next advisory) |
| Verification | none | per-criterion verifier | + per-criterion `requireFreshEvidence` / `requireReviewSubagent` flags + bundled `charter-verifier` persona |
| Loop driver | host agent | host agent | host agent (smart-Ralph; no auto-spawn scheduler, §21) |
| Sub-agents | none | handoff envelope | + agent-initiated `subagent({agent: "charter-verifier", ...})` delegation with `metadata` passthrough (§19.5) |
| Hooks | log only | gateable goal events | + `charter:before_lock_plan`, `charter:before_complete`, `charter:before_amend_contract`, `charter:before_force_complete` (decision-control) |

The three-tier shape is what makes us **competitive with Factory missions** (not just better than v1) while keeping the runtime single-session.

---

## 19. Addendum — Bundled internal personas + spawn substrate

> Added 2026-05-14 after the orchestration-layering discussion. Supersedes any
> implicit assumption in §§1–18 that pi-charter uses only user-provided personas.
> See `orchestration-layering.md` for the full pi-subagents API additions.

### 19.1 What changes

pi-charter ships **three bundled personas** inside the extension package, registered at startup with pi-subagents' `internal` scope. These are the contract-aware verifier and planner-critic; they're not visible in root's persona menu and not LLM-spawnable from chat. Only pi-charter' own code invokes them.

| Persona | Surface used | Why |
|---|---|---|
| `charter-verifier` | `subagent.spawn({agent: "charter-verifier", ...})` | Stable contract-aware prompt; structures output as evidence records; calls back into pi-charter via `charter_record_evidence` and `charter_handoff_apply` |
| `charter-planner-critic` | `subagent.spawn({agent: "charter-planner-critic", ...})` | Adversarial pass during planning phase: flags uncovered scope, orphan features, cyclic preconditions, budget sanity |
| `charter-evaluator` | `subagent.spawnRaw({systemPrompt: buildEvaluatorPrompt(goal, recentEvents, contractDigest), prompt: ..., ...})` | System prompt MUST be built fresh each turn (embeds live criteria status + last 3 verdicts + drift signals); cannot be a static file |

### 19.2 Why the verifier ships bundled, not user-authored

A generic `reviewer.md` persona doesn't know about:
- the goal's contract markdown structure (VAL-* assertion IDs, evidence types)
- which `fulfills[]` claims the just-finished feature made
- the handoff envelope shape (`{salientSummary, whatWasImplemented, verification:{commandsRun:[...]}}`)
- how to return structured evidence (`charter_record_evidence` tool call shape)

That's pi-charter-specific knowledge. Asking the user to write a contract-aware reviewer from scratch is a sharp adoption cliff. Bundling the verifier earns its rent because of the specialization, not because we're hoarding personas. **Users can still override** by dropping `~/.pi/agent/agents/charter-verifier.md` (global) or `<project>/.pi/charters/<charterId>/agents/charter-verifier.md` (per-mission, per §10 per-project layout) — the resolver checks those paths first.

### 19.3 Why charter-evaluator stays raw (not bundled)

The evaluator system prompt embeds:
- the goal's current objective text
- the contract digest (hash of contract markdown)
- live criteria status counts (`{passing: 3, pending: 5, failing: 1}`)
- the last 3 evaluator verdicts and their `reason` strings
- drift signals from the turn (token budget burn rate, time-budget burn rate)
- the recent event stream (last 5 events)

None of this is static. A static persona file with `{liveCriteriaStatus}` placeholder substitution is just `spawnRaw` with extra steps. So pi-charter builds the system prompt inline at spawn time and calls `subagent.spawnRaw({systemPrompt, prompt, model: "haiku-tier", ...})`.

### 19.4 Persona resolver search path (recap from orchestration-layering)

When pi-charter does `subagent.spawn({agent: "charter-verifier", ...})`, pi-subagents resolves the name in this order:

1. `<project>/.pi/charters/<charterId>/agents/charter-verifier.md` (per-mission override)
2. `~/.pi/agent/agents/charter-verifier.md` (user's library)
3. Extension-registered directory: `<pi-charter>/agents/charter-verifier.md` (bundled)

First match wins. Users can shadow any bundled persona by file convention.

### 19.5 Metadata passthrough — not callerGoalId

An earlier draft of this section had pi-subagents accept a `callerGoalId: string` named parameter on the spawn surface. That's wrong — it leaks pi-charter' vocabulary into pi-subagents.

The correct mechanism is opaque metadata:

```ts
subagent.spawn({
  agent: "charter-verifier",
  task: `Verify criterion ${criterion.id}`,
  metadata: {
    "pi-charter.charterId": goal.id,
    "pi-charter.criterionId": criterion.id,
    "pi-charter.featureId": feature.id,
  },
});
```

pi-subagents never reads `metadata`. It stamps it onto every `subagent:*` hook event payload. pi-charter' hook subscriber reads `metadata["pi-charter.charterId"]` on `subagent:completed` and routes the handoff back into the goal's evidence log.

Key convention: flat strings prefixed with `<extensionId>.`. Prevents collisions when multiple extensions tag the same spawn.

### 19.6 Bundled persona tool allowlist

Each bundled persona's frontmatter declares its `tools` allowlist explicitly. `charter-verifier` needs `charter_record_evidence` and `charter_handoff_apply` — pi-charter' own tools — in addition to standard read tools. pi-subagents enforces the allowlist when spawning. If pi-charter isn't installed (and therefore its tools aren't registered), the spawn fails with a clear error. That's correct: there's no reason for the persona to run if its dependencies aren't there.

### 19.7 Updated tier-S/A recommendation list

Add to the recommendations from §15:

- **S4 — Bundled internal personas as the contract-aware verifier mechanism.** Ship `charter-verifier` and `charter-planner-critic` with pi-charter. Use the persona resolver's search path to allow user override. Don't make adoption depend on users authoring contract-aware prompts from scratch.

- **A5 — `subagent.spawnRaw` for the dynamic evaluator.** Don't try to express the post-turn evaluator as a static persona file. Build the system prompt inline at spawn time with live state embedded; use pi-subagents' raw spawn surface.

- **A6 — Opaque `metadata` passthrough on spawn events.** Tag spawns with `metadata["pi-charter.charterId"]` etc.; never leak goal vocabulary into the spawn surface; route handoffs back via hook subscribers reading metadata.

- **B12 — `internal` role scope in pi-subagents.** Allow extensions to ship personas that are spawnable by extension code but not advertised to root LLM. Reusable substrate for pi-qa, pi-docs, etc.

### 19.8 Updated implementation phase ordering

Insert before existing M1:

- **M0 — pi-subagents API additions (1–2 days):**
  - `scope: "internal"` in role topology
  - `subagent.spawnRaw({...})` TypeScript API
  - `subagent.registerPersonaDir({...})` startup hook
  - `metadata` passthrough on `subagent:*` hook events
  - CI grep guard: no goal vocabulary in pi-subagents source

Then existing M1 (schema + planning + contract + verifier) → M2 (triggers + handoff envelope) → M3 (evaluator). Total ~1 week.

### 19.9 The substrate payoff

This design makes pi-subagents a **universal spawn substrate** for every future pi extension. pi-qa can ship a bundled `qa-validator`. pi-docs can ship a bundled `docs-drift-detector`. pi-deep-research can ship `research-evaluator`. All use the same three mechanisms — `internal` scope, `registerPersonaDir`, `metadata` passthrough — and pi-subagents stays unaware of any specific extension's vocabulary. The pattern proves itself once with pi-charter and pays compounding dividends.

---

## 20. Addendum — Autonomous-first, full rename to `pi-charter`, intent-sentinel fold, external boundary

> Added 2026-05-14 after four user pivots in sequence (1) make missions autonomous, (2) confirm the approach, (3) plan-approval gating + external orchestration boundary, (4) full Option-B rename. This addendum supersedes any earlier framing in §§1–19 where it disagrees; the rest of the document has been re-written to the Mission vocabulary in place.

### 20.1 Full rename rationale (Option B)

Half-rename (extension=pi-charter, kernel=Goal, tool=`goal_create`) was a smell. The kernel object IS a mission once it owns the contract + macro DAG + planning + evaluator + verifier + handoff envelope. The word `goal` survives **only** as the `objective` field inside a Mission.

| Was | Now |
|---|---|
| `pi-goals` (extension) | `pi-charter` |
| `GoalV2` (kernel type) | `Mission` |
| `GoalState`, `GoalEvent`, `GoalRuntime` | `MissionState`, `CharterEvent`, `MissionRuntime` |
| `goal_create`, `goal_status`, ... | `charter_manage({action:'create'})`, `charter_status`, ... |
| `goal-verifier`, `goal-planner-critic`, `goal-evaluator` (bundled personas) | `charter-verifier`, `charter-planner-critic`, `charter-evaluator` |
| `goal:before_create`, `goal:before_complete`, ... (hooks) | `charter:before_create`, `charter:before_complete`, ... |
| `~/.pi/goals/goal-<id>.json` | `~/.pi/charters/charter-<id>.json` |
| `/goal` slash command | `/charter` |
| `metadata["pi-goals.goalId"]` | `metadata["pi-charter.charterId"]` |

CI grep guard in `pi-charter` source forbids `goal_` tool prefix, `Goal` kernel typename, and `pi-goals.` metadata key. (`goal` as the user-facing English noun is allowed.)

### 20.2 The new `charter_manage({action: 'create'})` signature

Keep it minimal. Only inputs the agent could plausibly know:

```ts
charter_manage({
  action: 'create',
  objective: string,            // required — the one thing only the agent / spawner knows
  budget?: { tokens?, wallclockMs?, turns? },
                                // optional — escape hatch; defaults from config
  idempotencyKey?: string,      // optional — stable id when CLI retries
})
```

Dropped fields (do **not** re-add):

- ~~`contractPath` / `charterPath`~~ — there is no automatic spec handling at the tool layer. If the spawn prompt or human instruction says *"use ./design/oauth.md as the spec"*, the agent reads the file with its own file tools and authors `charter.md` during the planning phase. One code path, no heuristics, no auto-detect. (Earlier drafts had an auto-copy mode that copied pi-charter-shaped specs to `charter.md` verbatim and other specs to a separate `mission.md`. Rejected: format-detection is brittle, the copy path is a tiny minority, and Symphony can write `charter.md` directly when it already has a real charter. Note the layout was also collapsed in revision (c) — see §10 — so there's no separate `mission.md` to copy to anymore.)
- ~~`contractDraft`~~ — inline drafts go through the planning phase + `charter_manage({action: 'amend_contract'})`; redundant with the `charter.md` source-of-truth rule.
- ~~`planDraft`~~ — planning produces the macro DAG; pre-populating defeats `charter-planner-critic`.
- ~~`autoApprovePlan`~~ — superseded by the headless-core + TUI approver model (§20.4); knob lives in config + env, not per-call.
- ~~`completionMode`~~ — completion strictness lives per-criterion as `requireFreshEvidence` / `requireReviewSubagent` flags inside `charter.md §Criteria`, not as a per-charter toggle.

Three improvements over v1's `goal_manage({action:'create', objective})`:

1. **Explicit `objective` field** — the kernel concept is the Mission, not an overloaded goal string.
2. **Minimal surface** — three optional fields total. The Symphony case (upstream already authored a real charter) is handled by Symphony writing `<charterDir>/charter.md` directly before spawn; the agent's `charter_manage({action: 'create'})` then notices the file and the planning phase skips authoring. No magic in the tool.
3. **English instruction beats schema** — "use ./spec.md as the source of truth" is a plain-text directive the agent already handles with read + file tools; it doesn't need a tool parameter.

### 20.3 Autonomous-first lifecycle

The previous framing implicitly assumed a human at the keyboard approving each phase. The corrected framing:

```
Upstream (Symphony / external planner / direct prompt)
   │  spawns agent with English instruction:
   │  "Use ./design/oauth.md as the spec; create a mission and execute."
   ▼
Agent ── reads spec with file tools ── calls charter_manage({action: 'create', objective}) ───┐
   │                                                                       │
   │  planning phase                                                       │
   │   ├── if Symphony pre-wrote <charterDir>/charter.md, skip authoring    │
   │   │   else: agent reads spec, authors contract + plan/*.md            │
   │   ├── charter-planner-critic adversarial pass                        │
   │   ├── charter:before_lock_plan (TUI approver subscriber if enabled)   │
   │   └── transition planning → active                                    │
   │                                                                       │
   ▼                                                                       │
Active execution (evaluator each turn, verifier on demand)                  │
   │                                                                       │
   ▼                                                                       │
[review] phase: verifier over all criteria + charter:before_complete        │
   │                                                                       │
   ▼                                                                       │
completed / abandoned / budget_limited                                      │
                                                                            │
                                         metadata + handoff envelope ◄─────┘
```

The mission is the **alignment rail**, not the approval gate. Approval is a configurable layer on top. **There is no built-in spec-handling code path**: "use this file" is a plain English instruction the agent executes with its standard file tools.

### 20.4 Plan-approval gating — headless core + bundled TUI approver

Ship gate-on by default. Override stack, lowest to highest (no per-call layer):

```
1. Built-in default:        tuiApprover = on    (Factory-safe, human gates the plan)
2. Global config:           ~/.pi/agent/charter.config.json { tuiApprover: off }
3. Env var (per-session):   PI_CHARTER_TUI=off
```

pi-charter core is headless: it fires `charter:before_lock_plan` and `charter:before_complete` hook events; the bundled TUI approver subscriber prompts the human if enabled. No per-call override on `charter_manage({action: 'create'})` — if an autonomous spawn needs gate-off, the spawner sets `PI_CHARTER_TUI=off` in the child env. No `completionMode` per-call either; completion strictness is per-criterion (`requireFreshEvidence` / `requireReviewSubagent` flags inside `charter.md §Criteria`).

### 20.5 Invocation policy — explicit only, three first-class entry points

Missions are **always explicitly invoked**. The substrate never silently wraps a session in a mission based on inferred user intent. There is no auto-detect, no heuristic creation, no implicit wrap. "Agent calls its own tool" is *not* substrate magic — that's an agent decision.

Three first-class entry points, all converging on the same `charter_manage({action: 'create'})` core:

| Entry point | Who triggers it | When |
|---|---|---|
| **Agent tool** — `charter_manage({action:'create', objective})` | Agent itself, mid-session | Autonomous path: agent decides current work is mission-shaped (after reading a spec the spawn prompt pointed at, or after deciding ad-hoc work has scaled up) |
| **Slash command** — `/charter <objective>` (shortcut) or `/charter new` | Human | Interactive path: user explicitly turns the current session into a mission |
| **CLI flag** — `pi --charter-objective "..."` | Orchestrator / shell user | Spawn path: mission gets pre-created before turn 1; agent finds an active mission already bound on first `charter_status` call |

**CLI flags (registered via `pi.registerFlag()`):**

```
pi --charter-objective "<text>"   pi-charter session_start handler: charter_manage({action: 'create'}) + bind session before turn 1
pi --charter-resume <id>          pi-charter session_start handler: rebind session to existing mission
```

No `--charter-spec`. Specs are handled by plain English in the prompt ("Use ./design/oauth.md as the source of truth") plus the agent's normal file tools; pi-charter doesn't parse, copy, or detect spec files.

The spawn prompt MAY hint to the agent ("you are tasked with completing the charter described in ./design/oauth.md"); the agent reads the file and decides whether to call `charter_manage({action: 'create'})` itself. If `--charter-objective` was passed, the charter is already created and the agent just sees it in `charter_status`.

### 20.6 Intent-sentinel fold into `charter-evaluator` (dual-mode)

`intent-sentinel` is deprecated and folded into pi-charter' bundled `charter-evaluator` persona. Reasons captured in §19's bundled-persona discussion + the orchestration-layering doc: same primitive (cheap separate-model trajectory supervisor), same memory model, same warnings UI.

The folded evaluator runs in **two prompt modes**:

| Mode | Active when | Inputs | Drift definition |
|---|---|---|---|
| **mission-scoped** | A mission is `active` | objective, active feature, criteria status, last 3 verdicts, evidence ledger, contract digest | Drift against the typed contract; every steer must cite `criterionId` or `featureId` or be dropped |
| **free-form** | No active mission | Latest user msg, workflow files, task_manage context | Drift against inferred intent (verbatim intent-sentinel behavior) |

Both modes share the same machinery (cooldown, confidence threshold, repair-on-validation-error, memories with stable IDs, mute, per-session persistence, subagent-skip guard, debug log).

Wrong-steer mitigations (cited-evidence requirement, steers logged to mission event log, `/charter untrust-evaluator` escape hatch) ship as M2 polish, not M1.

### 20.7 Evaluator must NOT gate completion

The trajectory supervisor and the completion gate are different concerns and must be different code paths:

| Concern | Primitive | Model | Failure mode |
|---|---|---|---|
| **"Is the agent doing the right work?"** | `charter-evaluator` | soft, cheap, can be wrong without disaster | nudge / `<system-reminder>` |
| **"Is the work actually done?"** | verifier + `charter:before_complete` hooks | hard, deterministic | block `charter_complete` |

This preserves Codex's asymmetric-authority pattern: the model can propose-complete, but verifier and hooks must agree before the state transitions to `completed`. The evaluator's verdicts feed steering reminders, never the completion gate.

### 20.8 External orchestration boundary — three nested grains

The clash with upstream orchestrators (Symphony, agentic loops, mission-stack managers) is real but addressable by granularity, not by feature exclusion:

```
Symphony (or other upstream)         — inter-mission orchestration
  └── pi-charter (per spawn)        — intra-mission alignment + verification
        └── pi-dag-tasks (per exec)  — tactical turn-to-turn todos
```

Three integration rules:
1. **Mission scope is intra-spawn only.** A mission lives inside one agent spawn; it never crosses spawns. Multi-mission workflows are upstream's problem.
2. **Upstream spec is authoritative when supplied.** If `<charterDir>/charter.md` already exists when planning starts (Symphony wrote it before spawn, or the spawn prompt instructed the agent to copy it there), planning treats it as the charter and only fills in macro DAG + verifier hookups. No `charterPath` tool parameter; the file's presence is the signal.
3. **pi-charter emits events, never drives external systems.** Hooks (`charter:after_evaluator`, `charter_completed`, ...) are observable; upstream systems subscribe if they care. pi-charter does not call back into Symphony or any other orchestrator.

Biggest real risk: **duplicate-contract drift** (upstream spec says one thing, pi-charter contract says another). Mitigation tiers:
- When upstream has a real charter, write it to `<charterDir>/charter.md` *before* the agent enters planning; inline drafting otherwise happens during planning + `charter_manage({action: 'amend_contract'})`, never at create time.
- pi-charter reads the upstream contract verbatim; planning fills only verifier hookups + macro DAG, never authors a competing contract.
- Mission event log records the digest of the upstream contract at `plan_locked` time; later drift is detectable.

### 20.9 Tier-S/A additions from this addendum

- **S5 — charter-evaluator dual-mode.** Replaces intent-sentinel verbatim in free-form mode; gains mission-scoped mode for typed drift. Single source of truth for "what the agent should do next."
- **S6 — Upstream spec via filesystem.** Symphony writes `<charterDir>/charter.md` before spawn; planning notices and skips authoring. No tool parameter, no auto-detect. Eliminates duplicate-charter drift in the orchestrated-spawn case.
- **A7 — env-var override stack for autonomy gates.** Same agent code runs in CI (auto-approved) and at a human TUI (gated), differing only by env.
- **B13 — no substrate-injected wrap policy.** Codifies that pi-charter only starts charters through an explicit caller (agent tool / user slash / CLI). "Agent calls `charter_manage({action: 'create'})`" is agent-initiated and fine; what's ruled out is the substrate silently wrapping a session on inferred intent.
- **B14 — full Option-B rename including kernel type, tool surface, hook events, file layout, slash command, metadata keys, bundled persona names. The word `goal` survives only as `Mission.objective`.

### 20.10 Migration phasing impact

Inserts a deprecation step for `intent-sentinel`:

- **M0**: pi-subagents API additions (unchanged from §19 / orchestration-layering.md).
- **M1**: pi-charter M1+M2 (schema, planning, contract, manual-verifier, bundled personas, v1 auto-migration). Intent-sentinel still installed alongside.
- **M2**: command + prompt + hook verifiers; charter-verifier persona functional.
- **M3**: `charter-evaluator` with `spawnRaw` lands in dual-mode; intent-sentinel marked deprecated; 2-week soft period; then uninstall intent-sentinel.

Total: ~1 week of focused build for M0+M1; M2 + M3 are incremental.

---

## 21. Addendum — Smart-Ralph loop reframe + per-criterion gating + per-feature directory

> Added 2026-05-14 after the user observed Factory's sequential auto-spawn loop in production and concluded the **contract structure is brilliant; the per-feature worker scheduler is bureaucratic**. v2 keeps the contract, strips the scheduler, and lets the agent be the loop. Calls this a "smart-ish Ralph loop": persistent and dumb on the outside, smart guidelines on the inside.
>
> Supersedes the execution-loop framing in §§4, 8, 15 wherever it conflicts. §10 in this document has been rewritten in place to the new per-mission directory layout.

### 21.1 Core reframe in one sentence

> **The contract describes *done*; the agent owns *the path*.**

Factory says the orchestrator owns the path (which feature, which worker, when). pi-charter v2 says the agent owns the path; pi-charter owns done.

### 21.2 The four architectural shifts (locking in)

| Concern | Factory shape (rejected) | pi-charter v2 shape (locked) |
|---|---|---|
| Loop driver | Deterministic TS orchestrator picks ready feature → spawns worker → waits for envelope → picks next | Main agent IS the loop; each turn it sees `{contract status, active feature(s), last evaluator verdict, recent evidence, drift views}` and decides the next move |
| Macro DAG role | Scheduler — `preconditions[]` gate worker spawn | Map — `preconditions[]` are advisory, surfaced in drift view; agent can interleave, parallelize, revisit |
| Parallelism | Worker pool managed by orchestrator | Agent calls `subagent({parallel: [...]})` itself when it judges parallel work valuable; pi-charter runs no pool |
| Bundled personas | Auto-spawned per feature (worker droids) | Delegation targets: agent invokes `charter-verifier`, `charter-planner-critic` on its own judgment |

What disappears from earlier drafts:
- `worker_selected_feature`, `worker_started`, `worker_completed`, `worker_failed` events (no auto-spawn loop → no events)
- `executor: 'main' | 'worker-per-feature'` knob (no scheduler to swap)
- `skillName` / `workerSessionIds[]` / `currentWorkerSessionId` / `completedWorkerSessionId` on Feature (no per-feature worker)

What survives:
- Contract layer (VAL-* + verifier kinds + fresh-evidence invariant)
- Macro DAG with `fulfills[]` (demoted from gates to map)
- Planning phase + `charter-planner-critic` adversarial pass
- `charter-evaluator` running every turn (intent-sentinel fold, dual-mode)
- Bundled `charter-verifier` persona (now agent-invoked, not auto-spawned)
- Autonomous-first entry (`pi --charter-objective` / `pi --charter-resume` flags + `idempotencyKey` + `result.json` + TUI approver knob; spec handling via plain English instruction, not a tool parameter)

### 21.3 The loop, as pi-charter injects it

Each turn while `mission.status == active`, the agent's context contains a short decision frame (from system prompt + `charter_status` return + evaluator reminder):

```
You are inside an active mission. Read:
  · charter.md §Criteria / criterion-state.json  (what's done means what)
  · plan/  / feature-state.json         (what work is intended)
  · last evaluator reason               (where you might be drifting)
  · drift views (stuck / uncovered / wasted)

Pick ONE action this turn:
  [implement]  edit code, run commands toward a feature
  [verify]     charter_verify <criterionId>           ← fresh evidence
  [review]     subagent({agent: 'charter-verifier', task: ...})  for a feature
  [delegate]   subagent({parallel: [...]}) for independent work
  [plan]       charter_amend  (only when truly needed)
  [complete]   charter_complete  (gated by verifier + hook + per-criterion flags)
  [pause]      charter_pause
```

The system prompt's decision tree + the evaluator's per-turn reason are the entire "smart" part. No new mechanism, no scheduler.

### 21.4 Per-criterion gating (suggested by default, enforceable per-criterion)

The implement → review → verify discipline is **suggested by default** (evaluator nags, drift views surface, `charter_complete` warns) and **hard-gated per criterion** when the contract author opts in:

```yaml
# inside charter.md §Criteria, frontmatter on each VAL-* criterion
- id: VAL-AUTH-007
  description: Login flow returns 200 with valid token
  verifier:
    kind: command
    command: pnpm test auth/login
  requireFreshEvidence: true       # complete blocks until evidence post-dates verifier change
  requireReviewSubagent: false     # if true, also requires a charter-verifier handoff envelope
```

Resolution at `charter_complete`:

| Flag | Behavior |
|---|---|
| Both `false` (default) | Suggested: warns "criterion X lacks evidence" but allows complete |
| `requireFreshEvidence: true` | Hard block until `evidence.capturedAtMs > criterion.lastModifiedMs` |
| `requireReviewSubagent: true` | Hard block until a `charter-verifier` handoff envelope exists for an enclosing feature |
| Both `true` | Both gates must pass |

Force-complete escape hatch (`charter_complete({force: true, note})`) still works; records `forced_complete` event, sets `verdict: partial`, denies if `criterionPassingRatio < 0.5` without `--allow-deeply-incomplete`.

Sensible contract-author heuristic: tag 10-20% of criteria as hard-gated (security, payment, schema migration, data-loss-adjacent); leave the rest in suggested mode. This captures Factory's per-criterion control without Factory's "every feature must verify before next" rigidity.

### 21.5 The three guideline reminders pi-charter injects when active

Always present in the agent's system prompt when `mission.status == active`:

1. **Decision rule.** *"Tasks are work. Criteria are checks. Don't claim done without evidence. Evidence beats opinion."*
2. **Loop rule.** *"Implement → verify → move on. Don't batch 5 features then verify all. The verifier is cheap; use it."*
3. **Escape rule.** *"If you can't make progress on a feature after 3 turns, pause or delegate. Don't thrash."*

These are short, static, always present. The evaluator's `reason` field is the dynamic part stacked on top (cites specific criterionId / featureId / drift class).

### 21.6 Drift views surfaced in `charter_status` return

The agent reads these every turn; they replace the orchestrator's scheduling logic with awareness:

| View | Computed from | Purpose |
|---|---|---|
| Uncovered criteria | `criterion-state.json` where no evidence exists | "what work hasn't been verified" |
| Stuck features | `feature-state.json` where `status == active` for >N turns without evidence change | "agent thrashing on X" |
| Wasted work | Recent file edits outside any active feature's `fulfills[]` chain | "drift outside contract" |
| Stale evidence | Evidence dated before last verifier edit on its criterion | "needs re-verify" |
| Ready next | Features where `status == pending` and `preconditions[]` are met | "where to go next (advisory)" |
| Milestone debt | Milestone where all features `completed` but no milestone-gate verifier ran | "you forgot the gate" |

`Ready next` replaces the auto-scheduler — it's a suggestion the agent reads, not a queue the orchestrator pops.

### 21.7 Per-feature artifacts (the directory question the user raised)

For each feature in the macro DAG, the agent has access to (when it wants):
- `plan/<featureId>.md` — the spec (authored during planning, read-mostly)
- `work/<featureId>/notes.md` — the agent's narrative scratch (optional, append-friendly: "this approach didn't work because...", "left undone: error handling for case Y")
- `work/<featureId>/evidence/VAL-*__<ts>.json` — structured evidence records for criteria this feature `fulfills`

What we explicitly REJECTED (per §10.2):
- `implementation.md` per feature — git + spec already cover it
- `review.md` per feature — handoff envelope or evaluator events.jsonl already covers it
- `validation.md` per feature — structured evidence records already cover it, with criterion linkage that markdown would lose

The principle: **markdown for narrative humans want to read; JSON for structure agents want to query**. Don't duplicate.

### 21.8 Tier-S/A additions from this addendum

- **S7 — smart-Ralph loop (no auto-spawn scheduler).** Removes ~200 LOC of feature/worker scheduling; agent is the loop. Decisive simplification.
- **S8 — per-criterion `requireFreshEvidence` + `requireReviewSubagent` flags.** Captures Factory's per-criterion verification authority without forcing it on every criterion.
- **A8 — per-feature `work/<featureId>/` directory mirroring `plan/<featureId>.md`.** Gives the agent narrative scratch space and a structured evidence home without the three-doc-per-feature bloat.
- **A9 — drift views in `charter_status` return.** Replaces orchestrator scheduling with agent-readable awareness.
- **B15 — three always-present guideline reminders** (decision / loop / escape rules) injected when mission is active.

### 21.9 What this means for the lifecycle diagram

Showcase §09 lifecycle diagram's "Execution loop" subgraph collapses dramatically:

**Was:**
```
Pick ready feature → Worker subagent runs → Handoff envelope returned → Apply envelope
```

**Now:**
```
Read charter_status (drift views + evaluator reason) →
Agent picks ONE: [implement | verify | review-delegate | parallel-delegate | amend | complete | pause] →
Repeat
```

The lifecycle stays four-phase (Spawn → Planning → Execution → Review). The middle phase just stopped being a scheduler.

---

## 22. Addendum — Session ↔ mission binding

> Added 2026-05-14. Resolves the question "how does a pi session know which mission it's in?" without polluting the transcript and without inventing complex authority models for forks.

### 22.1 Two-file binding (no transcript message)

**Forward — mission knows its session:**
```
<project>/.pi/charters/<charterId>/state.json
  { ..., "sessionId": "ses_xyz789", "boundAtMs": 1736... }
```

**Reverse — session knows its mission:**
```
~/.pi/agent/sessions/<sessionId>/charter.json
  { "charterId": "mis_abc123", "projectRoot": "/Users/blaz/Programming_local/Projects/foo" }
```

Both files are atomic JSON writes; updated together on bind/unbind. Reconciliation: if they disagree on `charter_status` read, forward (state.json) wins and reverse is rewritten.

**Why two files and not one:**
- Forward alone: scanning all missions in a project to find "what mission am I in" is O(N).
- Reverse alone: orphan if session dir is gone but mission still exists.
- Both: O(1) lookup either direction, self-healing on access.

**No custom transcript message.** Charter identity is mutable state (pause/resume rebinds, /charter resume rebinds); transcripts are append-only narrative. The transcript already gets binding via system-prompt injection on bound sessions ("You are in charter chr_abc123 — read charter.md, follow the decision/loop/escape rules").

### 22.2 Who can bind

| Surface | Action | Authority |
|---|---|---|
| `charter_manage({action: 'create', ...})` (LLM tool) | Creates new charter, auto-binds calling session to it | Agent |
| `/charter resume <id>` (slash command) | Rebinds current session to existing mission `<id>`; unbinds first if currently bound to a different one | User only |
| `/charter clear` (slash command) | Drops current session's binding (mission keeps existing) | User only |
| `pi --charter-objective "<text>"` (CLI flag) | Spawns a fresh pi session, creates + binds a mission before turn 1 | User / orchestrator (via `pi.registerFlag()`) |
| `pi --charter-resume <id>` (CLI flag) | Spawns a fresh pi session, rebinds it to an existing mission before turn 1 | User / orchestrator (via `pi.registerFlag()`) |
| `pi mission resume <id>` (CLI) | Spawns a fresh pi session pre-bound to existing `<id>` | User (via CLI flag) |

**The agent can create charters freely. The agent cannot switch the session between existing charters.** There is no `charter_claim` LLM tool. Switching between pre-existing charters is a user decision (drift evaluator/control argument: agent silently rebinding while evaluator nags about the previous charter would be confusing).

### 22.3 Resolution order (LLM tool calls with no `charterId` argument)

```
1. explicit charterId in tool args                                → use it
2. ~/.pi/agent/sessions/<currentSessionId>/charter.json exists    → use that charterId
3. <project>/.pi/charters/index.json has exactly one active       → error (do not auto-bind; explicit > clever)
4. otherwise                                                       → error with list, ask for /charter resume <id>
```

Step 3 deliberately errors instead of auto-binding. One keystroke difference (`/charter resume <id>`) buys explicit beats magic.

### 22.4 What happens on `/fork`

`/fork` is the user-facing slash command that branches the current main session at its current leaf. Same primitive as `subagent({context: "fork"})` — calls `createBranchedSession(leafId)` → produces a **new session id** with inherited conversation history up to the leaf.

| Question | Answer |
|---|---|
| Does the fork get a new sessionId? | Yes. `createBranchedSession` always returns a new session file. |
| Does the fork inherit the mission binding automatically? | **No.** The session metadata directory (`~/.pi/agent/sessions/<sid>/`) is per-session-id; the fork has a new id, so its metadata dir starts empty. No `mission.json` reverse-index file exists for the fork. |
| Can the fork read the mission state? | Yes — through inherited context (the parent had `charter_status` results in its transcript) and through any explicit `charter_status({charterId})` call passing the id. |
| Can the fork write mission state (record evidence, complete)? | Only after `/charter resume <id>`. Until then, `mission_*` tool calls error with "no mission bound; run /charter resume <id> or pass charterId explicitly". |
| What if the user wants the fork to be the new owner? | Run `/charter resume <id>` in the fork. This unbinds the parent (rewrites `state.json.sessionId` to the fork's id, deletes parent's `~/.pi/agent/sessions/<parentSid>/charter.json`, writes the fork's `mission.json`). One owner at a time. |

This is the simplest model that works: ownership follows whoever last ran `/charter resume`. No claim tool, no transfer ceremony, no concurrent-write resolution.

### 22.5 Subagent spawns don't bind

When pi-charter code spawns a subagent (e.g. `charter-verifier`), it does NOT write a `mission.json` for the child session. The child gets mission scope through:

- `metadata["pi-charter.charterId"]` on the spawn payload (pi-subagents stamps this on hook events)
- Explicit `charterId` arg when the child calls `charter_record_evidence` / `charter_handoff_apply`

The child can read but does not own the mission. Only one session ever has its `sessions/<sid>/charter.json` written for a given mission at a time.

### 22.6 Cross-project isolation

Missions live under `<project>/.pi/charters/` (not `~/.pi/charters/`). Two projects, two sets of missions, zero overlap. Worktrees inherit naturally: different cwd → different `.pi/charters/` tree → different mission namespace.

Cross-project mission discovery ("what missions am I running globally?") is **out of scope** for pi-charter. If wanted later, ships as separate `pi missions ls --all` CLI walking known project roots — never as an in-extension feature.

### 22.7 Concrete TS sketch

```ts
// pi-charter/src/binding.ts
import { homedir } from "node:os";
import { resolve } from "node:path";

export function bindSessionToMission(
  sessionId: string, charterId: string, projectRoot: string
): void {
  // forward: mission → session
  updateStateJson(projectRoot, charterId, { sessionId, boundAtMs: Date.now() });
  // reverse: session → mission
  writeFileAtomic(
    `${homedir()}/.pi/agent/sessions/${sessionId}/charter.json`,
    { charterId, projectRoot }
  );
  // event log
  appendEvent(projectRoot, charterId, { type: "session_bound", sessionId });
}

export function unbindSession(sessionId: string, charterId: string, projectRoot: string): void {
  updateStateJson(projectRoot, charterId, { sessionId: null });
  rmIfExists(`${homedir()}/.pi/agent/sessions/${sessionId}/charter.json`);
  appendEvent(projectRoot, charterId, { type: "session_unbound", sessionId });
}

export function resolveBoundMission(
  sessionId: string
): { charterId: string; projectRoot: string } | null {
  return readJsonIfExists(`${homedir()}/.pi/agent/sessions/${sessionId}/charter.json`);
}
```
