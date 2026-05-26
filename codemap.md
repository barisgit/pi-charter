# Repository Atlas: pi-charter

## Project Responsibility

Pi extension for durable charter-bound agent work. Provides: objective/criteria/evidence lifecycle, macro feature plans with milestone gates, deterministic Ralph reprompting, and a terminal widget. Successor to pi-goals v1.

## System Entry Points

| File | Role |
|---|---|
| `src/index.ts` | Extension registration entry point. Wires tools, commands, flags, Ralph reprompting, and UI surfaces to the pi-coding-agent host. |
| `src/application/registration.ts` | Tool surface composition. No business logic — pure wiring of all service instances. |
| `package.json` | Dependency manifest, build scripts, `pi-package` config. |

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
|---|---|---|
| `src/application/` | Tool surface & orchestration: charter lifecycle state machine, evidence recording, plan CRUD, drift views, hooks, async bridge, Ralph, reminders bridge. | [View Map](src/application/codemap.md) |
| `src/domain/` | Pure business rules: `charter-md.ts` (charter/feature/criterion parsing), `feature-md.ts` (plan feature parsing), `trust-rank.ts` (4-level trust model), `types.ts` (all shared types/entities). Zero I/O, zero side effects. | [View Map](src/domain/codemap.md) |
| `src/infrastructure/` | Persistence & communication: `store.ts` (atomic tmp-rename writes, path mutex), `subagent-bridge.ts` (pi.events bus bridge to pi-subagents). No domain logic. | [View Map](src/infrastructure/codemap.md) |
| `src/ui/` | Pure string rendering for terminal TUI: charter picker, selection widget, multi-charter widget, widget host, widget state reducer, widget service. | [View Map](src/ui/codemap.md) |

## Key Design Patterns

1. **Atomic tmp-rename writes** — All store mutations write to a temp file then rename atomically. In-process path mutex prevents concurrent writes to the same path.
2. **Evidence sidecar** — Each feature's evidence goes into `work/<featureId>/evidence/<criterionId>__<timestamp>.json`; `criterion-state.json` is the runtime bitmap.
3. **Trust-ranked completion gate** — `service.ts` blocks completion unless the 4-level `trustRank` reaches required thresholds. Subagent-attributed evidence gets rank 0; manual non-review evidence gets rank 3.
4. **Veto hook bus** — `hooks.ts` exposes `before_lock_plan`, `before_complete`, `before_amend_charter`, `before_force_complete` for in-process extension customization.
5. **Milestone `ready_for_review` projection** — `record-service.ts` synthesizes this tri-state field from per-criterion `requireReviewSubagent` flags; propagates through feature state → charter state.
6. **Pi-subagents async bridge** — `async-bridge-service.ts` subscribes to `pi.events` for charter subagent completions and appends attributed events to `events.jsonl`.
7. **Session↔charter dual binding** — `binding-service.ts` maintains bidirectional pointers; reconciles after unexpected process restarts.
8. **Pure reducer → ViewModel** — UI layer is stateless string rendering: `loadCharterSnapshot` → reducer → `buildViewModel` → renderer.

## Layer Dependency Graph

```
pi-coding-agent host
  └─ src/index.ts (registration)
       ├─ application/registration.ts (wires tools/commands/hooks)
       │    ├─ application/service.ts (lifecycle FSM + completion gate)
       │    ├─ application/plan-service.ts (plan CRUD + lock)
       │    ├─ application/record-service.ts (evidence + verifiers + handoffs)
       │    ├─ application/drift-service.ts (stale/stuck/ready views)
       │    ├─ application/binding-service.ts (session binding)
       │    ├─ application/hooks.ts (veto event bus)
       │    ├─ application/async-bridge-service.ts (subagent events)
       │    └─ application/reminders-bridge.ts (reminder events)
       ├─ domain/ (pure, zero I/O)
       │    ├─ types.ts (entity types)
       │    ├─ charter-md.ts (charter/feature/criterion parsers)
       │    ├─ feature-md.ts (plan feature parsers)
       │    └─ trust-rank.ts (trust ranking function)
       ├─ infrastructure/
       │    ├─ store.ts (atomic persistence)
       │    └─ subagent-bridge.ts (pi.events bus)
       └─ ui/ (pure string rendering)
            ├─ charter-picker.ts
            ├─ charter-selection.ts
            ├─ multi-charter-widget.ts
            ├─ widget.ts
            ├─ widget-state.ts (reducer + buildViewModel)
            └─ widget-service.ts
```

## Root-level Non-code Files

| File | Purpose |
|---|---|
| `AGENTS.md` | Agent instructions and read order. |
| `CONTEXT.md` | Canonical domain language and boundaries. |
| `docs/adr/` | Architecture Decision Records (1–6). |
| `docs/implementation/` | Architecture, lifecycle, tool contracts, and verifier specs. |
| `docs/reference/v1-pi-goals/` | v1 reference implementation (read-only). |
| `agents/` | Bundled agent personas: `charter-planner-critic.md`, `charter-verifier.md`. |
| `skills/pi-charter/SKILL.md` | pi-charter skill for end-to-end workflow. |
| `scripts/dogfood-render.ts` | Self-check rendering script. |
| `.pi/` | Runtime charter state, events, evidence, handoffs (runtime artifacts, not source). |
