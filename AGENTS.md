# AGENTS.md — pi-charter

Reference for coding agents working in this repository.

## Project stance

`pi-charter` is a quiet, opt-in backstop that keeps a user-authorized Objective available when durable work needs to continue. It is not a planning, checklist, or progress system. ADR-0018 is the current decision; it supersedes the phase, periodic-reminder, and mandatory-report decisions of ADR-0016 and ADR-0017, whose session-binding, lifecycle, legacy-history, and Ralph-guard rules survive. Treat earlier ADRs and `pi-goals` v1 as history where they conflict.

## Read order

1. `CONTEXT.md` — canonical domain language.
2. `docs/adr/0018-quiet-objective-backstop.md` — current cross-cutting decision.
3. `docs/implementation/` — implementation contracts.
4. ADR-0016, ADR-0017, and earlier ADRs — decision history and surviving constraints.
5. `docs/research/` and `docs/reference/v1-pi-goals/` — historical design and plumbing patterns only.

## Invariants

- `charter.md` is the single authored file: the full authorized `# Objective`, optional `## References` and `## Scope`, and optional ordinary Markdown notes (`## Notes`). There is no phase grammar, status, scaffold, progress projection, or instruction to maintain one. Existing `## Phases` text stays on disk unchanged as ordinary notes.
- One LLM tool remains: `charter({ action, id?, objective?, note? })` with `create | list | status | pause | resume | complete | abandon`. Every return carries legal `nextActions[]`.
- Lifecycle remains `active | paused | completed | abandoned`. A session binds to at most one active or paused charter; complete or abandon it before opening another. Mutations target only that binding, except explicit resume may bind a paused charter to an unbound session.
- Charter adds no recurring Objective prompt while work is underway. The only model-facing continuation is guarded idle-only Ralph.
- Completion is worker judgment after auditing the Objective and its References. It needs a concise completion note and approval from `charter:before_complete`. It never generates or overwrites `REPORT.md`; no report, artifact, or runtime-proof gate exists.
- pi-charter never runs verification. Verification and any user-requested deliverables, including a report, are part of satisfying the Objective. `work/` and `REPORT.md` are optional conveniences; existing ones are preserved.
- The agent is the loop driver. Do not add an auto worker scheduler or another evaluator.
- Ralph's guard semantics are exact: the fifth actual send in a rolling 15 minutes is recovery; the next eligible activation at or before the 5-minute warning boundary pauses before send; quiet expiry does not pause; compaction and edits do not reset; only explicit user `/charter resume` clears a guard pause and history; tool resume cannot bypass; unrelated jobs continue.
- No hot-path Charter I/O (ADR-0018 amendment 2026-10-08): ordinary `tool_result`, `turn_end`, and streaming events read, scan, lock, and write nothing. Status, dashboard and Ralph read the current `charter.md` on demand without the mutation lock or any write. The widget reads the binding only on session start, lifecycle changes, and Ralph warnings; countdown ticks render from its cached view. Ralph hooks only schedule; file I/O waits until the worker is idle.
- Writable state keeps the historical storage label `schemaVersion: "phases"` with lifecycle/session fields and optional Ralph guard state. A `snapshotHash` in older `state.json` is ignored and dropped by the next lifecycle write; older `charter_file_changed` events stay in history. The label is a compatibility discriminator, not a surviving phase feature. Existing writable charters resume without rewriting `charter.md`.
- `schemaVersion: "file-interface"` charters are dashboard-visible, read-only history. Never mutate, resume, or migrate them. Continued work starts in a new charter.
- Charter ids remain `<YYYYMMDD-HHMMSS>-<slug>` under `.charters/`. Sidecars remain `state.json`, `events.jsonl`, and optional `work/` and `REPORT.md`.
- Tactical turn-to-turn todos stay in pi-dag-tasks.
- No `contractPath`, `--charter-spec`, spec auto-detect, budgets, question/planning states, reminder options, artifact or report gates, or OpenSpec framework.

## Implementation guidance

- Before runtime edits, inspect ADR-0018, the matching implementation spec, and v1 only for proven extension plumbing.
- Keep the parser tolerant: unknown Markdown is inert and malformed known grammar produces warnings rather than blocking work.
- The Objective may gain only user-authorized constraints, verification detail, and deliverable requirements. Never change or narrow user intent.
- Keep model-facing text short. Do not replace removed ceremony with new reminders, checklists, or report instructions.
- Use Pi extension APIs from `docs/reference/pi-docs/extensions.md` and live installed docs if needed.
- Make changes through failing behavior tests and small vertical slices. Preserve unrelated shared-tree work.

## Verification

Run the narrowest behavior tests while iterating. Before handoff, the project minimum remains:

```bash
bun run check-types
bun test
```

Do not claim known baseline failures passed without checking them.
