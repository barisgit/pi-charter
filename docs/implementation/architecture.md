# Architecture

pi-charter is a headless-first Pi extension that keeps an agent aligned to a durable charter while leaving execution agency in the root session.

## Layers

```text
Pi extension entrypoint
  ├── Application layer
  │   ├── tools: charter_manage / charter_plan / charter_record / charter_status
  │   ├── commands: /charter tree
  │   ├── event handlers: session binding, reminders, Ralph, hooks
  │   └── nextActions FSM
  ├── Domain layer
  │   ├── Charter / Mission state
  │   ├── CharterStatus FSM
  │   ├── Feature DAG and drift views
  │   ├── Criteria and verifier rules
  │   └── Evidence records
  └── Infrastructure layer
      ├── filesystem store under <project>/.pi/charters/<charterId>/
      ├── session binding files under ~/.pi/agent/sessions/<sid>/charter.json
      ├── reminder bus integration
      ├── subagent metadata passthrough
      └── deterministic Ralph reprompting
```

## Core primitives

1. **Charter document** — `charter.md`, authored source of truth with Objective, Criteria, Scope and constraints.
2. **Macro DAG** — `plan/<featureId>.md` files plus computed `plan.json` sidecar.
3. **Evidence log** — append-only evidence JSON files under `work/<featureId>/evidence/`.
4. **State bitmaps** — `feature-state.json` and `criterion-state.json`, mutable and computed.
5. **Ralph reprompt** — status-driven continuation when the root and async children are idle.

## Control model

The root agent is the loop driver. pi-charter only surfaces the current charter, drift views, legal next actions, and optional verifier/planner persona calls. It does not run a worker scheduler.

## Integration points

- **Pi tools**: four LLM-callable tools.
- **Slash command**: one `/charter` tree.
- **Flags**: `--charter-objective`, `--charter-resume` via `pi.registerFlag()`.
- **Hooks**: `charter:before_lock_plan`, `charter:before_complete`, `charter:before_amend_charter`, `charter:before_force_complete`.
- **Subagents**: internal personas and metadata passthrough; children never bind sessions themselves.
- **Reminders/status**: deterministic Ralph reprompting and compact status widget.

## Non-goals for v1 implementation

- No auto-spawn worker pool.
- No spec path parameter or spec auto-detection.
- No cross-project global mission dashboard.
- No rich TUI first; headless tools and status first.
- No AgentContract YAML interop in the first cut, but leave room for projection.
