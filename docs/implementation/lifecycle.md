# Lifecycle

## States

`active | paused | completed | abandoned`

`completed` and `abandoned` are terminal and disappear from the session widget. They remain visible in `/charters`. There is no archive action or flag, planning, question, review, or open-ended state. No-ID actions target the same active or paused session charter shown by the widget.

## Creation

`charter({ action: "create", objective })` creates a timestamp-sortable workspace, writes `charter.md` with the Objective and commented, optional References and Scope sections, initializes state and the journal, and binds the current session when available. A session may have only one active or paused charter. Complete or abandon it before creating another.

The Objective carries the full authorized outcome. The worker may add only constraints, verification expectations, and deliverable requirements the user authorized, and never changes or narrows user intent.

## While active

The worker works normally; tactical steps stay outside pi-charter. Charter sends nothing while work is underway. When the root worker and async subagents are idle, Ralph restates the Objective with any References and Scope and asks the worker to continue or finish.

## Pause and resume

A worker pauses when work intentionally stops or needs a user decision. A normal pause can resume through the legal lifecycle action. Pause, resume, complete, and abandon target only the session-bound charter. An explicit resume id may bind a paused charter from another session only when the current session has no active or paused charter. Resuming never rewrites `charter.md`.

Ralph may also pause before a send when its loop guard trips. After that pause, only an explicit user `/charter resume` clears the warning and rolling activation history. `charter({ action: "resume" })` cannot bypass the guard. The pause does not kill unrelated jobs.

Old `file-interface` charters cannot resume. Start a new charter to continue their work.

## Ralph guard

- Count actual Ralph sends in a rolling 15-minute window.
- Replace the fifth send with recovery guidance.
- If the next eligible activation occurs at or before the 5-minute warning boundary, pause before sending.
- Do not schedule a pause when the system is quiet. Keep rolling history and evaluate only when a new activation becomes eligible.
- Compaction and charter edits do not reset the guard.

## Completion

An active or paused charter completes when the worker judges the Objective met after auditing it and its References, supplies a concise completion note, and `charter:before_complete` allows the transition. Completion from a guard pause does not resume execution or clear guard history.

Completion does not generate, require, or modify `REPORT.md`. Verification and any requested report are part of meeting the Objective, done by the worker beforehand.

## Abandonment

Abandon requires a note and terminally closes work that will not be delivered. A failed verification alone does not imply abandonment.
