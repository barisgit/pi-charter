# A quiet Objective backstop

Status: accepted. Supersedes the phase, periodic-reminder, and mandatory-report decisions in ADR-0016 and ADR-0017. Their session-binding, lifecycle, legacy-history, and Ralph-guard rules survive.

Charter should keep an authorized outcome available when work needs to continue, not impose another planning system while the agent is already working. The September–October session audit found substantial task-list use in main sessions, rare recent Charter creation, and very little tracker use in child sessions. Coupled with the repeated-Objective rendering failure and excess model-facing ceremony, this favors a smaller opt-in backstop rather than another reminder cadence or wholesale deletion.

## Decision

- Keep one durable `charter.md`: the full authorized `# Objective`, optional `## References` and `## Scope`, and optional ordinary Markdown notes. Preserve wording and user intent; do not summarize or narrow the Objective for convenience.
- Remove structured phases entirely: no parser, statuses, projections, progress bar, phase-count hook field, scaffold, or instructions to maintain them. Existing phase sections remain untouched on disk as ordinary notes, visible through the authored Markdown rather than a structured phase model.
- Remove periodic Objective reminders, their counters and threshold options. Charter adds no recurring Objective prompt while work is underway.
- Keep `charter({ action, id?, objective?, note? })`, legal next actions, session binding, and `active | paused | completed | abandoned`.
- Keep guarded idle continuation when the root worker and async subagents are idle. Its prompt restates the Objective and optional References/Scope, with a short instruction to continue or finish. Do not add an instruction-hierarchy disclaimer or a repeated workflow lecture.
- Completion requires the worker's concise note and approval from `charter:before_complete`, not a generated report or runtime proof system. Verification and any user-requested deliverables remain part of satisfying the Objective. `REPORT.md` and `work/` are optional conveniences; preserve existing reports and artifacts, never generate or overwrite a report as a completion side effect, and do not add a flag or heuristic report gate.
- Keep the exact existing guard: fifth actual send in a rolling fifteen minutes is recovery; the next eligible activation at or before five minutes pauses before sending; quiet expiry never pauses; compaction and edits do not reset it; only explicit user `/charter resume` clears a guard pause and history; unrelated jobs continue.

## Compatibility and boundaries

Existing writable charters must remain resumable without rewriting their authored file. Retain the historical `schemaVersion: "phases"` storage discriminator: the persisted lifecycle/guard shape is unchanged, and the old name does not imply a surviving phase feature. Existing `file-interface` charters remain read-only history. Do not migrate, delete, or rewrite stored charters to implement this simplification.

The phase-related status fields, public types, and completion-hook field are deliberately removed rather than retained as empty compatibility shims. The shared reminder host remains available to other extensions. The task tracker, Fo, and shared rendering fixes are outside this change.

## Amendment 2026-10-08: no hot-path Charter I/O

Status: accepted. Sessions still hung after the widget became event-driven because every tool result and turn end scanned all charters, then took the project mutation lock to hash `charter.md`, and every countdown tick repeated a lookup that locked. A read-only status could therefore wait behind any writer.

- Remove automatic file tracking: no tool-result or turn-end hook, no `snapshotHash` computation or update, no `charter_file_changed` events. The authored file is read and parsed on demand by status, the dashboard and before each Ralph continuation, so edits are visible immediately and the Objective, References and Scope stay fresh. Notes remain inert.
- Status, list and bound lookups take no lock and write nothing. `complete` uses the state it loaded under the mutation lock.
- The widget reads the session binding only on session start, lifecycle changes (including Ralph guard pause and recovery sends) and Ralph warnings, and renders countdown ticks from that cached view. Ralph hooks only schedule; its file reads start once the worker is idle.
- Compatibility needs no migration: a `snapshotHash` in existing `state.json` is ignored and disappears at the next lifecycle write, and existing `charter_file_changed` history stays unchanged. Lifecycle, binding, write locking, approval hooks, and the exact Ralph guard are unchanged.
