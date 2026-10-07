# pi-charter

`pi-charter` keeps a user-authorized Objective available when durable work needs to continue across idle turns, compaction, or handoff. It is a quiet, opt-in backstop: it adds no planning structure, progress tracking, or recurring reminders. The worker plans, verifies, and judges completion.

ADR-0018 and `CONTEXT.md` define the current model.

## Model

- One tool, `charter`, with `create`, `list`, `status`, `pause`, `resume`, `complete`, and `abandon`. Results carry legal `nextActions[]`.
- Lifecycle: `active`, `paused`, `completed`, `abandoned`. A session binds to at most one active or paused charter.
- One authored file, `.charters/<id>/charter.md`: the full `# Objective`, optional `## References` and `## Scope`, and any ordinary notes (for example under `## Notes`).
- When the root worker and async subagents are idle, Ralph restates the Objective and asks the worker to continue or finish, under a loop guard.
- Completion needs a concise note and approval from the `charter:before_complete` hook. `REPORT.md` is written only when the Objective asks for it; the runtime never generates or overwrites one.
- Old `file-interface` charters stay visible in the dashboard as read-only history.

```text
.charters/<YYYYMMDD-HHMMSS>-<slug>/
├── charter.md
├── state.json     # lifecycle, session binding, Ralph guard
├── events.jsonl   # append-only journal
├── work/          # optional artifacts
└── REPORT.md      # optional, only when requested
```

## Tool

```ts
charter({
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon",
  id?,
  objective?,
  note?,
})
```

`create` takes `objective`; `complete` and `abandon` take `note`. Omit `id` for the session-bound charter, or pass a full id, unique prefix, or unique slug fragment.

## Slash commands

- `/charter [id-fragment]` — show the bound or named charter.
- `/charter create <objective>`, `/charter list`, `/charter status`.
- `/charter pause [note]`, `/charter resume`, `/charter complete <note>`, `/charter abandon <note>`.
- `/charters` — read-only dashboard and picker.

After a Ralph guard pause, user `/charter resume` is the only reset path.

## Ralph guard

Within a rolling 15-minute window, the fifth actual Ralph send becomes a recovery prompt. If the next eligible activation arrives at or before the 5-minute warning boundary, the runtime pauses before sending. Quiet expiry never pauses; compaction and edits do not reset history; tool resume cannot clear a guard pause; unrelated jobs keep running.

## Documentation map

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Domain language. |
| `docs/adr/0018-quiet-objective-backstop.md` | Current design decision. |
| `docs/implementation/` | Runtime and API contracts. |
| `skills/pi-charter/SKILL.md` | Worker guidance. |
| `docs/adr/0016-…`, `docs/adr/0017-…` | History; binding, lifecycle, legacy, and guard rules survive. |

## Development

```bash
bun run check-types
bun test
```

The package is private (`"private": true`).
