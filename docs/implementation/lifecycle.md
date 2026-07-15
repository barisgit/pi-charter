# Lifecycle

## States

`active | paused | completed | abandoned`

`completed` and `abandoned` are terminal. There is no planning or review state.

## Creation

`charter({ action: "create", objective })` creates a timestamp-sortable workspace, writes the comment-guided `charter.md` scaffold, initializes state and journal files, and binds the current session when available. Only one charter may be active for a session.

A new scaffold has no live criteria because examples are inside HTML comments. It is therefore open-ended until criteria are authored.

## Active loop

1. The agent authors or refines Objective, optional References/Scope, and substantive criteria.
2. The agent changes a criterion Status from `pending` to `in-progress` or `blocked` as work changes.
3. The agent implements and verifies through the real system.
4. The same Status line becomes `pass` or `fail` with an observation and any artifact path.
5. Tool-result hooks re-read and diff `charter.md`; Ralph can steer the agent toward unresolved criteria.

`Depends:` influences ready-next advice only. It never gates work or completion.

## Pause and resume

Pause when work intentionally stops or requires a user decision; include a useful note. Resume returns a paused charter to active and can bind it to the current session.

## Completion

An open-ended charter cannot complete. For a charter with criteria, completion requires:

- every criterion Status is `pass`;
- every pass has a non-empty evidence note;
- no pass is stale relative to the latest global source-change sequence;
- `REPORT.md` exists and is non-empty.

The first complete attempt scaffolds `REPORT.md` and returns a curation action instead of completing. Non-pass states, including `blocked`, remain visible but all block completion.

## Abandonment

Abandon requires a note and terminally closes work that will not be delivered. A failed verification alone is not a reason to abandon.
