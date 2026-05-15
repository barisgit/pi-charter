# Factory Droid Missions — FACT-level (live mission directory)

> Observed from a real, in-progress mission on disk on 2026-05-14:
> `/Users/blaz/.factory/missions/4f9502f7-16ae-4156-8e8a-1cdab6d873d2`
> (mission ID `mis_622b326b`, state `paused`, reason `unrecoverable_usage_402`).
>
> This file supersedes the earlier `factory-digest.md` for anything the live
> directory directly contradicts. Blog-derived statements still stand for
> claims the directory doesn't disprove.

---

## 1. Mission directory layout (file inventory)

```
~/.factory/missions/<missionUuid>/
├── state.json                       294 B   {missionId, state, workingDirectory, createdAt, updatedAt, lastReviewedHandoffCount}
├── mission.md                      9.4 KB   human-authored mission spec (overview, stack, layout, milestones, gates)
├── AGENTS.md                       9.1 KB   operational guidance for workers + validators (boundaries, conventions, escalation)
├── validation-contract.md        193.9 KB   authoritative behavioral contract: ~427 VAL-* assertions across 8 areas
├── features.json                  39.1 KB   {features: [{id, description, skillName, preconditions, expectedBehavior, verificationSteps, fulfills, milestone, status, workerSessionIds, currentWorkerSessionId, completedWorkerSessionId}]}
├── validation-state.json          23.5 KB   {assertions: {ID: {status}}} — flat per-assertion progress bitmap
├── services.yaml                    270 B   {commands: {install, typecheck, build, test, lint, format, caplet}, services: {}}
├── model-settings.json              201 B   {workerModel, workerReasoningEffort, validationWorkerModel, validationWorkerReasoningEffort, skipScrutiny, skipUserTesting}
├── runtime-custom-models.json        24 B   {customModels: []}
├── init.sh                          633 B   idempotent per-session env setup (cd, bun install if package.json, version check)
├── working_directory.txt             95 B   single-line absolute path to the worktree the mission edits
├── progress_log.jsonl               7.0 KB  line-delimited typed mission event log
├── worker-transcripts.jsonl        37.6 KB  per-worker startup skeleton (assigned feature serialized as JSON prompt)
├── handoffs/                                one JSON per worker handoff to orchestrator
│   └── <iso-timestamp>__<featureId>__<workerSessionId>.json
├── skills/                                  per-role skill packs (used by worker spawns)
│   ├── core-worker/SKILL.md
│   └── adapter-worker/SKILL.md
├── library/                                 shared mission knowledge base
│   ├── architecture.md
│   ├── environment.md
│   └── user-testing.md
└── contract-work/                           validation-contract authoring/review materials
    ├── 01-bootstrap.md  ...  08-cross-area.md   (one file per area of validation-contract.md)
    ├── all-ids.txt                              flat list of all VAL-* IDs
    └── review-pass-1.md                         review notes
```

---

## 2. `state.json` — mission control surface

```json
{
  "missionId": "mis_622b326b",
  "state": "paused",
  "workingDirectory": "/Users/blaz/.../feature-implementer-a",
  "createdAt": "2026-05-14T08:50:31.957Z",
  "updatedAt": "2026-05-14T09:05:06.948Z",
  "lastReviewedHandoffCount": 1
}
```

- `state` observed values include `paused`. Other states inferred from
  `progress_log.jsonl` event types: `active` (running), `complete`. Cannot
  enumerate the full enum from this single mission.
- `lastReviewedHandoffCount` is the orchestrator's pointer into `handoffs/`
  for re-entry — i.e. on resume, only files past this index are unread.
- `workingDirectory` is the live edit target (a git worktree on a feature
  branch). The mission writes to this directory; mission-control state lives
  separately under `~/.factory/missions/`.

---

## 3. `features.json` — the work-unit DAG

Top-level: `{ features: [...] }`. **13 features** in this mission, **6 milestones**
(`m1-bootstrap`, `m2-core`, `m3-resolver`, `m4-adapters`, `m5-full-cli`, `m6-deliver`),
**2 skill roles** (`core-worker`, `adapter-worker`).

### Feature shape (FACT)

```json
{
  "id": "m1-types-schemas-registry",
  "description": "Implement core type definitions ...",
  "skillName": "core-worker",
  "preconditions": ["m1-bootstrap-workspace completed (workspace exists with pinned deps)"],
  "expectedBehavior": [
    "Zod schemas parse valid manifests and all valid facet frontmatter",
    "Zod schemas reject unknown top-level manifest fields with info diagnostic",
    "Target registry lists exactly 5 targets with no duplicate ids",
    "..."
  ],
  "verificationSteps": [
    "bun test packages/core/test/schemas/ --bail=0",
    "bun test packages/runtime-taxonomy/test/ --bail=0",
    "bunx tsc --noEmit"
  ],
  "fulfills": ["VAL-MANIFEST-001", "VAL-MANIFEST-002", "VAL-BOOT-013", "..."],
  "milestone": "m1-bootstrap",
  "status": "pending | in_progress | completed",
  "workerSessionIds": ["8295de1b-..."],
  "currentWorkerSessionId": null,
  "completedWorkerSessionId": null
}
```

### Three non-obvious invariants

1. **`fulfills[]` is the join key into `validation-contract.md`.** Each feature explicitly
   *claims* which `VAL-*` assertions it covers. Coverage is computable by
   `union over features where status==completed of fulfills[]`. Assertions claimed by
   no feature are *uncovered scope*; assertions claimed by a feature whose status
   isn't `completed` are *unverified scope*.
2. **`skillName` is mission-local routing**, not Code Droid vs. Test Droid. The orchestrator
   spawns a worker, the worker loads the skill identified by `skillName` from the mission's
   `skills/` directory. This mission has only two roles (`core-worker`, `adapter-worker`).
3. **`workerSessionIds[]` is append-only.** Failed-then-retried features carry both the
   failed and successful spawn IDs. `currentWorkerSessionId` and `completedWorkerSessionId`
   are pointers, not lifecycle gates.

---

## 4. `validation-contract.md` — the behavioral contract

193.9 KB, hand-authored markdown. Per-assertion shape:

```
### VAL-BOOT-001: `bun install` succeeds from a clean clone
From $REPO with node_modules/ and any Bun lockfile artifacts removed,
running `bun install` exits with code 0 and creates a populated top-level
$REPO/node_modules/ directory (non-empty, contains at least one
workspace-resolved package).
Tool: direct shell
Evidence: `bun install` stdout/stderr captured; `echo $?` prints `0`;
`test -d node_modules && test -n "$(ls -A node_modules)"` exits 0.
```

Each assertion has **four parts** in fixed order:
1. **ID + title** (`### VAL-AREA-NNN: short title`)
2. **Behavioral description** (1–4 sentences, normative)
3. **Tool** (`direct shell` | `claude headless` | `cli` | etc. — the means by which a validator checks it)
4. **Evidence** (the *artifact* that proves the assertion: exact commands + expected stdout patterns + `echo $?` checks)

Areas observed in this mission: `BOOT`, `MANIFEST`, `SLUG`, `TARGETEXT`, plus areas
named after facet families and adapters. Total assertions in this mission's contract: ~427.

`contract-work/` mirrors these areas one-to-one (`01-bootstrap.md` ... `08-cross-area.md`)
and is the authoring/review staging surface — it is NOT consulted at runtime.

---

## 5. `validation-state.json` — assertion progress bitmap

```json
{
  "assertions": {
    "VAL-BOOT-001": {"status": "pending"},
    "VAL-BOOT-002": {"status": "pending"},
    "...": "..."
  }
}
```

- Flat dict keyed by assertion ID. No metadata beyond `status` (other fields like
  evidence pointers may appear as assertions transition — not observed yet in this paused mission).
- Decoupled from `features.json`. Features don't write into `validation-state.json` directly;
  validators do, on per-milestone validation passes.
- This is the **single source of truth for "what's actually done"**, not feature.status.
  A feature can be `completed` while its fulfills assertions remain `pending` until
  a validator confirms them. The two views compose to detect drift.

---

## 6. `progress_log.jsonl` — typed mission event log

Line-delimited JSON. Event `type` enum (8 observed in this run):

| Event type | When | Payload keys |
|---|---|---|
| `mission_accepted` | mission created | `title` |
| `mission_run_started` | first orchestrator turn | `message` (summary of plan) |
| `worker_selected_feature` | orchestrator picks next feature | `workerSessionId`, `featureId` |
| `worker_started` | spawn created | `workerSessionId`, `spawnId`, `featureId` |
| `worker_completed` | worker handoff received | `workerSessionId`, `featureId`, `successState`, `returnToOrchestrator`, `commitId`, `repoPath`, `exitCode`, `validatorsPassed`, `handoff` |
| `worker_failed` | spawn errored or hit a hard limit | `workerSessionId`, `spawnId`, `reason` |
| `mission_paused` | orchestrator pauses | `pauseReason` (e.g. `unrecoverable_usage_402`) |
| `handoff_items_dismissed` | orchestrator triages handoff `discoveredIssues`/items | `dismissals: [{type, sourceFeatureId, summary, justification}]` |

All event objects include `timestamp` (ISO-8601). Append-only.

Implications:
- This stream is sufficient to **reconstruct the mission FSM** without reading worker transcripts.
- `handoff_items_dismissed` is a real orchestrator decision — handoffs surface things the
  worker discovered (e.g. a Bun ecosystem bug); the orchestrator can dismiss with a justification.
- `mission_paused.pauseReason` is structured (here, an upstream HTTP 402 credit-limit response).

---

## 7. `handoffs/` — the verification-evidence envelope

One file per worker handoff:
`<iso-timestamp>__<featureId>__<workerSessionId>.json`

Shape (FACT):

```json
{
  "timestamp": "2026-05-14T08:59:36.753Z",
  "workerSessionId": "85f5cba5-...",
  "featureId": "m1-bootstrap-workspace",
  "milestone": "m1-bootstrap",
  "commitId": "4cd4364",
  "repoPath": "/Users/blaz/.../feature-implementer-a",
  "successState": "success",
  "returnToOrchestrator": true,
  "handoff": {
    "salientSummary": "Bootstrapped the Bun workspace with all four packages ...",
    "whatWasImplemented": "Root package.json with workspaces ... All deps pinned ...",
    "whatWasLeftUndone": "",
    "verification": {
      "commandsRun": [
        {"command": "bun install",        "exitCode": 0, "observation": "42 packages installed, ..."},
        {"command": "bunx tsc --noEmit",  "exitCode": 0, "observation": "No type errors ..."},
        {"command": "bunx biome check .", "exitCode": 0, "observation": "Checked 28 files, ..."},
        {"command": "bun test",           "exitCode": 0, "observation": "2 pass, 0 fail ..."},
        {"command": "bun run apps/caplet/src/bin/caplet.ts --help", "exitCode": 0, "observation": "..."}
      ]
    }
  }
}
```

**This is the strongest verification envelope of any system in this comparison.** Codex's
`completionBudgetReport` is a sentence; Claude's `TaskCompleted` hook handler is whatever
the user writes; Factory's handoff binds **exact command → exact exit code → observation**.
And the orchestrator can dismiss/triage items from `discoveredIssues` rather than
silently merging them.

---

## 8. `model-settings.json` — per-mission, per-role model selection

```json
{
  "workerModel": "glm-5.1",
  "workerReasoningEffort": "high",
  "validationWorkerModel": "glm-5.1",
  "validationWorkerReasoningEffort": "high",
  "skipScrutiny": false,
  "skipUserTesting": false
}
```

- **Worker and validator models are independently configurable.** Default is the same model
  for both, but they're separate keys. You can run a cheap worker with a strong validator
  (asymmetric quality budget) — the inverse of Claude's `/goal` evaluator pattern but the
  same architectural shift.
- `skipScrutiny` / `skipUserTesting` are per-mission feature flags for the two validator passes.
  Confirms blog claim that scrutiny + user-testing are the two black-box validator stages.

---

## 9. `services.yaml` — mission-local command vocabulary

```yaml
commands:
  install:   bun install
  typecheck: bunx tsc --noEmit
  build:     echo "no build step (bun runs TS natively)"
  test:      bun test --bail=0
  lint:      bunx biome check .
  format:    bunx biome format --write .
  caplet:    bun run apps/caplet/src/bin/caplet.ts

services: {}
```

- Named command aliases used by `verificationSteps` in `features.json` and by validators
  in `validation-contract.md`. Lets the contract say "the test command" without binding
  to a specific runner.
- `services: {}` is the (empty here) registry for long-running side services the mission
  may need (e.g. a dev server, a database container).

---

## 10. `skills/` — mission-local skill packs

Per-role skill packs loaded by spawned workers. Standard SKILL.md format:

```yaml
---
name: core-worker
description: Builds core packages (types, schemas, registry, validator, resolver, hash, diagnostics, CLI) and test fixtures
---
```

Plus prose detailing when to use the skill and the work procedure. Validates that
**skills are scoped to the mission**, not pulled from a global registry — they ship inside
the mission directory and can therefore be versioned with the mission.

---

## 11. `library/` — shared mission knowledge base

- `architecture.md` — high-level dataflow / package layout. Authored once, referenced by all workers.
- `environment.md` — verified tool versions, env vars, install paths. Single source of truth so
  workers don't re-derive.
- `user-testing.md` — validation surface, available tools, prerequisites, concurrency limits
  for the user-testing validator.

Distinct from `AGENTS.md` (operational rules) and `mission.md` (the plan). `library/` is
**reference**, not directive. This separation is something pi-goals' single-objective
shape cannot replicate without growing a file layout.

---

## 12. Comparison: what changes vs. blog-derived `factory-digest.md`

| Claim | Blog/digest version | Live evidence |
|---|---|---|
| Mission has features + assertions | ✔ confirmed | `features.json` (13 features) + `validation-contract.md` (~427 assertions) |
| Features claim assertions via `fulfills[]` | ✔ inferred | ✔ confirmed (exact field name) |
| Scrutiny + user-testing validators | ✔ described | ✔ confirmed (`skipScrutiny` / `skipUserTesting` toggles) |
| Externalized state files | ✔ described | ✔ richer than described: `state.json`, `validation-state.json`, `progress_log.jsonl`, `handoffs/` — all separable |
| Mission FSM is `Plan → MC → workers → validators → Fix → repeat` | ✔ described | ✔ confirmed; progress_log enumerates the actual event types |
| Verification is evidenced | ✔ described | ✔ MUCH stronger: handoff envelope binds `{command, exitCode, observation}` triples per worker handoff |
| Per-mission model selection | not in digest | NEW: `model-settings.json` decouples worker model from validator model |
| Mission-local skills | implied | ✔ confirmed: `skills/<role>/SKILL.md` lives inside mission dir |
| Mission-local library | not in digest | NEW: `library/{architecture,environment,user-testing}.md` is a reference layer separate from AGENTS.md |
| `services.yaml` command vocabulary | not in digest | NEW: named commands for portable verification |
| Pause is structured | implied | ✔ confirmed: `mission_paused.pauseReason` is enum-like (`unrecoverable_usage_402` observed) |
| Orchestrator triages handoff items | not in digest | NEW: `handoff_items_dismissed` event with per-item `{type, sourceFeatureId, summary, justification}` |

---

## 13. Implications for `pi-goals v2`

Each of these is now a FACT-backed, free-to-steal pattern (was REPORTED before):

- **F-LIVE-1. Handoff envelope.** `{salientSummary, whatWasImplemented, whatWasLeftUndone, verification:{commandsRun:[{command, exitCode, observation}]}}`. pi-goals' `evidence: string[]` is the weakest cell in the v1 schema; this is the shape it should grow into.
- **F-LIVE-2. Validation-state bitmap.** A flat `{assertions: {ID: {status}}}` JSON beside the goal file, decoupled from the goal's own criteria, lets validators (or external test runs) write directly without touching the goal record. Trivial to add.
- **F-LIVE-3. Typed event log with orchestrator decisions.** pi-goals already has an event log; the gap is *typed* events with payloads, and an analogue of `handoff_items_dismissed` for explicit "we considered this and rejected it" capture.
- **F-LIVE-4. `fulfills[]` join key.** If pi-goals adds a sub-task DAG (Tier A1 in the report), each subtask should declare which `criteria[]` IDs it fulfills. Coverage computability is free thereafter.
- **F-LIVE-5. Named command vocabulary.** A `services.yaml`-equivalent in `.pi/` would let GOAL.md / criteria reference "the test command" portably across repos.
- **F-LIVE-6. Per-role model selection.** If pi-goals grows a post-turn evaluator (Tier S1), `evaluatorModel` should be a separate config knob from the main agent model — Factory's `workerModel` vs. `validationWorkerModel` split is the same architectural beat.
- **F-LIVE-7. `library/` as reference vs. `AGENTS.md` as rules.** Separating reference (`architecture.md`, `environment.md`) from directive (`AGENTS.md`) makes both easier to keep current. pi-goals' v1 has no notion of this split.

---

## 14. Citation

[F-LIVE] Local Factory Droid mission directory observed 2026-05-14:
`/Users/blaz/.factory/missions/4f9502f7-16ae-4156-8e8a-1cdab6d873d2`
(mission ID `mis_622b326b`, state `paused`, 13 features across 6 milestones,
~427 validation assertions, 1 completed handoff, paused on `unrecoverable_usage_402`).
Non-public, one-time confidential local observation. Reliability: HIGH for this
mission's shape; MEDIUM for generalizing to all Factory missions until a second
mission is observed.
