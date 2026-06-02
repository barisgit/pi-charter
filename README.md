# pi-charter

`pi-charter` is a Pi extension for durable, charter-bound agent work. An agent starts from an objective, authors a charter workspace with `charter.md` and `criteria.md`, tracks Objective → Milestone → VAL criteria, and records evidence against those criteria.

The implementation is live. `src/index.ts` is the extension composition root; code is the source of truth, with `CONTEXT.md` and ADRs documenting the model and boundaries.

## Current status

**Implemented, tested, bridged.** Test suite status: 275 pass / 0 fail; package scripts are `bun test` and `bun run check-types`.

- Three LLM-callable tools wired: `charter`, `charter_record`, `charter_status`.
- Lifecycle FSM: `active` | `paused` | `completed` | `abandoned`, with completion gated by recorded criterion evidence.
- Hook bus, drift views, session binding, widget, slash commands, CLI flags, and deterministic Ralph reprompt loop are registered from the live extension entrypoint.
- `charter_record` records evidence only; pi-charter does not run verification commands.
- pi-charter ships zero bundled personas. Bring your own review, QA, or planning subagents and record their outputs as evidence.
- Per-project workspace: `<project>/.pi/charters/<charterId>/{charter.md, criteria.md, state.json, criterion-state.json, REPORT.md, events.jsonl, work/}`.
- pi-subagents bridge wired: `expose-api` subscriber plus `async-started`/`async-complete` attribution to legacy-named `feature_started`/`feature_completed`/`feature_failed` events.
- v1 `pi-goals` preserved at `docs/reference/v1-pi-goals/pi-goals/` for reference only.
- Research and ADRs in `docs/research/2026-05-14-pi-charter-design/` and `docs/adr/`.

## Documentation map

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Domain language and boundaries for pi-charter. Read first. |
| `docs/adr/` | Accepted architectural decisions and tradeoffs. |
| `docs/implementation/` | Implementation-oriented specs: filesystem layout, tools, lifecycle, and evidence handling. |
| `docs/research/2026-05-14-pi-charter-design/` | Full research and brainstorming archive. |
| `docs/reference/v1-pi-goals/` | Old v1 implementation preserved for reference only. |
| `docs/reference/pi-docs/extensions.md` | Pi extension API reference copied from local Pi docs. |
| `src/index.ts` | Live extension composition root: registers flags, tools, commands, bridges, widget, and Ralph loop. |

## Extension surface

Three LLM-callable tools:

- `charter` — lifecycle FSM: create, pause, resume, complete, abandon.
- `charter_record` — evidence writes against VAL criteria.
- `charter_status` — read-only status, drift views, and legal `nextActions[]`.

Single slash tree:

- `/charter` prints the usage hint; use `/charters` to inspect or manage active charters.
- `/charter <objective>` hands the objective to the agent and tells it to run the charter workflow end-to-end. **Users describe intent; agents own charter creation** with `charter action=create`.
- `/charters status|pause|resume|select|list` manages existing charters.

CLI flags:

- `pi --charter-objective "<text>"` hands the objective to the agent on turn 1; the agent calls `charter action=create`.
- `pi --charter-resume <id>` rebinds before turn 1.

No spec auto-detect, no `--charter-spec`, and no path parameter on creation. If a prompt says "use `docs/spec.md`", the agent reads it with normal file tools and authors `charter.md` plus `criteria.md` during planning.

## Development

```bash
bun run check-types
bun test
```

The package is private (`"private": true`).
