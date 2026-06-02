# Architecture

pi-charter is a headless-first Pi extension that keeps an agent aligned to a durable charter while leaving execution agency in the root session.

## Layers

```text
Pi extension entrypoint
  ├── Application layer
  │   ├── tools: charter / charter_record / charter_status
  │   ├── commands: /charter tree
  │   ├── event handlers: session binding, subagent attribution, Ralph, hooks, widget refresh
  │   └── nextActions FSM for active / paused / completed / abandoned
  ├── Domain layer
  │   ├── Charter / Mission state
  │   ├── CharterStatus FSM
  │   ├── Objective → Milestone → VAL criteria model and status views
  │   ├── Criteria and descriptive verifier annotations
  │   └── Flat evidence records
  └── Infrastructure layer
      ├── filesystem store under <project>/.pi/charters/<charterId>/
      ├── session binding files under ~/.pi/agent/sessions/<sid>/charter.json
      ├── append-only events and atomic file writes
      ├── subagent metadata passthrough
      └── deterministic Ralph reprompting
```

## Core primitives

1. **Charter authoring files** — `charter.md` holds Objective, Scope and constraints, Mission Boundaries, and optional Commands; `criteria.md` holds the VAL register grouped under milestone headings.
2. **Criterion register** — Objective → Milestone → VAL is the persisted decomposition. There is no feature DAG, `plan/<featureId>.md`, or computed `plan.json` sidecar in the live runtime.
3. **Evidence log** — append-only flat evidence JSON files under `work/<feature-or-_charter>/evidence/<stamp>/`, written by `charter_record action=evidence` after the agent or a user-owned subagent performs the check.
4. **State sidecars** — `state.json` stores lifecycle/session metadata and `criterion-state.json` stores latest VAL outcomes and evidence pointers. `feature-state.json` is vestigial only: it appears in comments/protected-file lists, not as a live reader/writer sidecar.
5. **REPORT.md gate** — scaffolded at the first completion attempt and required to have non-empty content under every heading before completion.
6. **Ralph reprompt** — status-driven continuation when the root and async children are idle.

## Control model

The root agent is the loop driver. pi-charter only surfaces the current charter, drift views, legal next actions, and descriptive verifier/command annotations. It does not run checks, dispatch verifier personas, or run a worker scheduler.

## Integration points

- **Pi tools**: three LLM-callable tools: `charter` (`create`, `pause`, `resume`, `complete`, `abandon`), `charter_record` (`evidence` only), and `charter_status`.
- **Slash command**: one `/charter` tree.
- **Flags**: `--charter-objective`, `--charter-resume` via `pi.registerFlag()`.
- **Hooks**: live transition hooks are `charter:before_complete` and `charter:before_abandon`. `charter:before_lock_plan` remains defined in the hook type surface but is vestigial and has no live emitter because the lock-plan flow is gone. There is no `before_amend_charter` or `before_force_complete` hook.
- **Subagents**: user-owned agents may be delegated by the root session; charter records their evidence provenance but ships no bundled personas or persona registration mechanism.
- **Reminders/status**: deterministic Ralph reprompting and compact status widget are live. Reminder-bus helpers exist as remnants but are not part of the active entrypoint registration path.

## Workspace layout

```text
<project>/.pi/charters/
├── index.json
└── <charterId>/
    ├── charter.md
    ├── criteria.md
    ├── state.json
    ├── criterion-state.json
    ├── REPORT.md
    ├── events.jsonl
    ├── architecture.md                    # optional
    ├── prompts/ralph/<case>.md            # optional override
    ├── qa-briefs/*.md                     # optional status display inputs
    └── work/<feature-or-_charter>/evidence/<stamp>/evidence.json

~/.pi/agent/sessions/<sid>/charter.json    # reverse session binding
```

The runtime does not create or consume `plan/`, `plan.json`, `feature-state.json`, `handoffs/`, `result.json`, or `notes.md`.

## Non-goals for v1 implementation

- No auto-spawn worker pool.
- No spec path parameter or spec auto-detection.
- No cross-project global mission dashboard.
- No rich TUI first; headless tools and status first.
- No AgentContract YAML interop in the first cut, but leave room for projection.
