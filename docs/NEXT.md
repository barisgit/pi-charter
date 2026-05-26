# NEXT — morning handoff

## What shipped this session

pi-charter is a fully tested standalone extension wired to pi-subagents. 53 tests / 162 assertions green; `bun run check-types` clean; ~2640 LOC under `src/`.

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

### Bundled personas

- `agents/charter-verifier.md` — read-only contract-aware verifier. `scope: internal`. Tool allowlist: `read, grep, find, ls, bash, charter_record, charter_status`. Records exactly one `charter_record action=evidence` entry per run.
- `agents/charter-planner-critic.md` — read-only adversarial plan critic. `scope: internal`. Runs the same checks the in-process `lock_plan` runs plus milestone hygiene, order field sanity, verifier coverage, and scope/constraint violation checks. Emits a structured `PASS | BLOCK | ADVISORY` verdict.
- Both use `anthropic/claude-sonnet-4-6`.

## pi-subagents bridge — wired

All four required surfaces ship on the pi-subagents side, and the three pi-charter consumer surfaces are wired in `src/index.ts`:

- pi-subagents commits (in order): `e35aed7` (internal scope), `fff442c` (metadata passthrough), `dd54225` (expose API), `5beb3d4` (register-persona-dir), `b3a03f8` (CI vocabulary guard).
- pi-charter side:
  - `registerCharterPersonas` — emits `SUBAGENT_REGISTER_PERSONA_DIR_EVENT` at startup, re-emits on `session_start`, and emits `SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT` on `session_shutdown`. Subscribes to `SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT` and surfaces collisions via the pi-charter file logger (pi-coding-agent has no `ctx.ui` in `pi.events.on` handlers, and stdout/stderr are off limits).
  - `registerCharterSubagentBridge` — subscribes to `SUBAGENT_EXPOSE_API_EVENT` and caches the `SubagentExposedAPI` bag in module state. `getSubagentApi()` returns the handle (or `undefined` when pi-subagents is absent).
  - `registerCharterAsyncBridge` — subscribes to `SUBAGENT_ASYNC_STARTED_EVENT` and `SUBAGENT_ASYNC_COMPLETE_EVENT`. When payload `metadata` carries `pi-charter.projectDir` + `pi-charter.charterId` (and optionally `pi-charter.featureId` / `pi-charter.criterionId`), appends `feature_started` / `feature_completed` / `feature_failed` to the charter's `events.jsonl`. `exitCode !== 0` maps to `feature_failed`.

Spec lives in `docs/research/2026-05-14-pi-charter-design/orchestration-layering.md §3.2`. Local event constants and payload types are redeclared in `src/infrastructure/subagent-bridge.ts` so pi-charter does NOT import from pi-subagents (matches the `pi-prune-router` / `pi-prune-swe-pruner-provider` pattern).

### Metadata convention (host-agent contract)

When the host LLM delegates via `subagent({agent: 'charter-verifier' | 'charter-planner-critic', ..., metadata: {...}})`, it must pass the canonical keys:

- `pi-charter.projectDir` — absolute project path (required for the async bridge to locate the charter; no `ctx.cwd` reachable in `pi.events.on` handlers).
- `pi-charter.charterId` — required.
- `pi-charter.featureId` — optional, recommended.
- `pi-charter.criterionId` — optional.

## Open ladder

- Auto-apply handoff envelopes: extend the async-complete handler to read a `pi-charter.handoff` blob from the subagent summary/details and route to `charter_record action=handoff_apply`. Today the bridge only writes attribution events; handoff envelopes still need `charter_record action=handoff_apply` invoked explicitly by the host agent.
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
