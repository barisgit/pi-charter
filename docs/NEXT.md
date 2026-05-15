# NEXT — morning handoff

## What shipped this session

pi-charter is a fully tested standalone extension. 38 tests / 121 assertions green; `bun run check-types` clean; ~2488 LOC under `src/`.

### Tools (all four LLM-callable surfaces wired)

- `charter_manage` — `create | pause | resume | complete | force_complete | amend_charter`. Completion gate enforces every criterion has `pass` evidence; `requireFreshEvidence` and `requireReviewSubagent` flags read from `charter.md` Criteria.
- `charter_plan` — `view | add_feature | update_feature | lock_plan`. `lock_plan` runs the planner-critic checks (empty/uncovered/orphan/unknown-ref/precondition-cycle), computes a `planDigest` (sha256), transitions `planning → active`, appends `plan_locked` event.
- `charter_record` — `evidence | verify | handoff_apply`. `verify` runs command verifiers via `/bin/sh -c` with 120s default timeout and 64KB stdout/stderr capture. `handoff_apply` consumes returned subagent handoff envelopes (featureId + completedCriteria + subagentSessionId) and translates them into evidence + criterion-state updates.
- `charter_status` — drift views (uncovered, stuck, stale, readyNext) plus legal `nextActions[]`.

### Lifecycle infrastructure

- Per-project layout: `<project>/.pi/charters/<charterId>/{charter.md, state.json, events.jsonl, plan/<featureId>.md, plan.json, criterion-state.json, feature-state.json, work/<featureId>/evidence/}`. `index.json` per project registers all charters.
- Hook bus with four blocking events: `charter:before_lock_plan`, `charter:before_complete`, `charter:before_amend_charter`, `charter:before_force_complete`. Subscribers return `{decision: 'allow'}` or `{decision: 'block', reason}`. Block throws so the FSM never advances when a subscriber vetoes.
- Session binding (forward + reverse): `state.json.sessionId` + `~/.pi/agent/sessions/<sessionId>/charter.json`. `--charter-resume <id>` and `--charter-objective` CLI flags wire through `session_start`. Reconcile-on-start restores forward pointer from reverse if missing.
- Slash command: `/charter` (bare = status; `/charter <text>` = create shortcut).

### Evaluator (intent-sentinel fold)

- `evaluator-service.ts` runs post-turn via injected `EvaluatorModelFn`. Persists last 10 verdicts in `evaluator-log.jsonl`. Never gates completion — only surfaces a steer reminder via `pi.sendMessage({deliverAs: 'steer', triggerTurn: false})`.
- `registerCharterEvaluator(pi)` wired into `index.ts`. `turn_end` handler builds the live context (charter status + drift + recent user messages + recent tool names), invokes `complete()` from `@earendil-works/pi-ai`, parses the JSON verdict, appends to log, fires steer reminder on next turn.
- Default model: `anthropic/claude-haiku-4-5` (matches Claude Code's `/goal` Haiku pattern). Override via `PI_CHARTER_EVAL_PROVIDER` / `PI_CHARTER_EVAL_MODEL`.

### Bundled personas

- `agents/charter-verifier.md` — read-only contract-aware verifier. `scope: internal`. Tool allowlist: `read, grep, find, ls, bash, charter_record, charter_status`. Records exactly one `charter_record action=evidence` entry per run.
- `agents/charter-planner-critic.md` — read-only adversarial plan critic. `scope: internal`. Runs the same checks the in-process `lock_plan` runs plus milestone hygiene, order field sanity, verifier coverage, and scope/constraint violation checks. Emits a structured `PASS | BLOCK | ADVISORY` verdict.
- Both use `anthropic/claude-haiku-4-5` (cheap-fast tier).

## Known external gap: pi-subagents bridge (not blocking dogfood)

pi-subagents on `e35aed7` has only **1 of 4** required surfaces (`internal` scope). Still missing:

1. `SUBAGENT_EXPOSE_API_EVENT` — emit `{spawnRaw, list}` on extension startup + `session_start`.
2. `SUBAGENT_REGISTER_PERSONA_DIR_EVENT` / `SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT` — subscribe and store in private registry.
3. `metadata` passthrough on `subagent:async-started` / `subagent:async-complete` event payloads (additive field; opaque to pi-subagents).

Spec updated in `docs/research/2026-05-14-pi-charter-design/orchestration-layering.md §3.2` to the event-bus shape (matching `pi-prune-router` precedent at `pi-prune-swe-pruner-provider/src/types.ts`). Earlier draft incorrectly assumed `pi-coding-agent`'s `ExtensionAPI` exposes a cross-extension method registry — it does not.

What is dogfoodable today without the bridge:
- Manual evidence (`charter_record action=evidence` from the host agent itself).
- Command verifiers (`charter_record action=verify`).
- Drift views and evaluator steering.
- Planner-critic in-process during `lock_plan`.

What is blocked on the bridge:
- The agent delegating to `charter-verifier` / `charter-planner-critic` personas via `subagent({agent: ...})` (the bundled persona files exist on disk but pi-subagents can't load them yet without `subagent:register-persona-dir`).
- Handoff envelopes from delegated subagents auto-applying via `subagent:async-complete` + `metadata['pi-charter.featureId']` routing.

## Open ladder

- Wire pi-charter to emit `subagent:register-persona-dir` event on startup + `session_start` once the pi-subagents implementer ships the subscribe side. Single edit in `src/index.ts`; no-op when the event has no subscriber.
- Subscribe to `subagent:async-complete` in `src/application/registration.ts`; when `metadata['pi-charter.charterId']` matches the bound charter, route to `charter_record action=handoff_apply` with the envelope.
- Capture the `SubagentExposedAPI` bag on `SUBAGENT_EXPOSE_API_EVENT`; pass `subagentApi.spawnRaw` into `registerCharterEvaluator` so the evaluator can run as an isolated child instead of an in-process `complete()` call. Falls back to in-process when the API is absent.
- Optional bundled TUI approver subscribing to `charter:before_lock_plan` (default ON via `PI_CHARTER_TUI=on`; flipped OFF for Symphony-style orchestration).

## Known external gaps from earlier passes

- Manual USPTO/EUIPO search for `pi-charter` before public npm publish.
- Direct npm metadata check for `pi-missions`/`pi-quests` was blocked by 403 in research pass.
- Anthropic official Ralph plugin claim is single-source reported; verify before citing publicly.

## Dogfood scenario

Once installed as a pi extension, the simplest dogfood loop is:

```text
/charter Implement the pi-subagents event-bus bridge surfaces per orchestration-layering.md §3.2.
```

Expected charter criteria (authored during planning):
- VAL-EVENT-001 — `SUBAGENT_EXPOSE_API_EVENT` emitted at startup with `{spawnRaw, list}` callable bag.
- VAL-EVENT-002 — `SUBAGENT_REGISTER_PERSONA_DIR_EVENT` subscriber stores payloads in private `Map<extensionId, RegisterPersonaDirPayload>` and emits `subagent:register-persona-dir-error` on name collision.
- VAL-METADATA-001 — `metadata` field copied verbatim from spawn payload to `subagent:async-complete` event.
- VAL-CI-001 — CI grep guard rejects forbidden charter/mission/goal tokens in pi-subagents source.
