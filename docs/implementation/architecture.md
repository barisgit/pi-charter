# Architecture

## Boundary

pi-charter is a Pi extension that keeps an authorized Objective available during durable work. The worker is the loop driver and completion judge. The extension persists lifecycle and the authored file, journals meaningful file changes, renders status, sends guarded Ralph continuation when idle, and runs the completion hook.

It does not plan tasks, track progress, run verification, enforce evidence, generate reports, add recurring prompts, or dispatch workers.

## Layers

1. **Authored charter** — `.charters/<id>/charter.md`: the full Objective, optional References and Scope, and ordinary notes.
2. **Domain parser** — `src/domain/charter-file.ts` extracts the Objective, References, and Scope tolerantly. `## Notes` and the historical `## Phases` heading end the Objective; their content, like any other Markdown, is inert.
3. **Application service** — lifecycle actions, status projection, whole-file change journaling, and completion-hook coordination.
4. **Infrastructure** — atomic file writes, timestamp-sortable ids, state/event persistence, and read-only legacy loading.
5. **Registration** — tool and slash-command wiring, Ralph idle continuation, and the rolling guard.
6. **UI** — a compact current-charter widget and a dashboard that also renders legacy charters read-only.

## Runtime flow

Writable charters keep the storage label `schemaVersion: "phases"`; the name is historical and implies no phase feature. At a relevant boundary, the runtime re-reads `charter.md`. An optional whole-file `snapshotHash` identifies meaningful authored changes for the journal.

When the root worker and async subagents are idle, Ralph may send a continuation. Registration owns the rolling activation guard shared by normal and recovery sends. It never starts a worker and never kills unrelated jobs. Nothing else sends model-facing prompts while work is underway.

On completion, the worker supplies a concise note; the service invokes `charter:before_complete` and completes if the hook allows. It neither reads nor writes `REPORT.md`.

## Boundaries that should stay deep

- `charter.md` owns the authorized outcome and any notes the worker keeps.
- `state.json` owns lifecycle/session mechanics and optional whole-file/Ralph guard state, never a progress model.
- `events.jsonl` owns append-only history.
- pi-dag-tasks owns tactical steps.
- Legacy `file-interface` charters are display inputs only. No write path accepts them.

See ADR-0018.
