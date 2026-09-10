# Lifecycle

## States

`active | paused | completed | abandoned`

`completed` and `abandoned` are terminal and disappear from the session widget. They remain visible in `/charters`. There is no archive action or flag, planning, question, review, or open-ended state. No-ID actions target the same active or paused session charter shown by the widget.

## Creation

`charter({ action: "create", objective })` creates a timestamp-sortable workspace, writes a comment-guided `charter.md`, initializes `schemaVersion: "phases"` state and the journal, and binds the current session when available. Only one charter may be active for a session.

The Objective must be substantial enough to carry the authorized completion contract. The scaffold begins with exact:

```md
## Phases

1. Explore phases
```

The agent can expand the Objective only with constraints, verification expectations, and reporting requirements the user authorized. It cannot change or narrow user intent.

## Active loop

1. Audit the Objective and References.
2. Explore the work and add lightweight phases only as they become useful.
3. Implement normally. Tactical tasks remain outside pi-charter.
4. Verify the real result. Capture screenshots or recordings during verification for user-visible behavior.
5. Link useful artifacts in an indented phase body and keep the phase narrative current.
6. Ask what move best advances the Objective when Ralph continues the loop.

Phase status communicates progress. It does not gate work or completion.

## Pause and resume

A worker pauses when work intentionally stops or needs a user decision. A normal pause can resume through the legal lifecycle action.

Ralph may also pause before a send when its loop guard trips. After that pause, only an explicit user `/charter resume` clears the warning and rolling activation history. `charter({ action: "resume" })` cannot bypass the guard. The pause does not kill unrelated jobs.

Old `file-interface` charters cannot resume. Start a new phases charter to continue their work.

## Ralph guard

- Count actual Ralph sends in a rolling 15-minute window.
- Replace the fifth send with recovery guidance.
- If the next eligible activation occurs at or before the 5-minute warning boundary, pause before sending.
- Do not schedule a pause when the system is quiet. Keep rolling history and evaluate only when a new activation becomes eligible.
- Compaction and charter edits do not reset the guard.

## Completion

An active or paused phases charter may complete with zero phases. Completion from a guard pause does not resume execution or clear guard history. The worker decides completion by auditing the full Objective and external References, then provides a concise completion note.

Completion:

- generates REPORT.md when needed without requiring a failed scaffold call;
- preserves an already curated REPORT.md;
- invokes the existing `charter:before_complete` hook;
- transitions to completed when the hook allows.

There is no all-phases-done gate, freshness sweep, evidence count, screenshot quota, or failed-first-call protocol.

## Abandonment

Abandon requires a note and terminally closes work that will not be delivered. A failed verification alone does not imply abandonment.
