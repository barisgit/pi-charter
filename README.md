# pi-charter

`pi-charter` is a Pi extension design for durable, charter-bound agent work: the agent starts from an objective, authors or reuses a `charter.md`, decomposes the work into feature files, records evidence against criteria, and uses evaluator feedback as smart-Ralph steering.

This repo is intentionally scaffold-first. The current source of truth is the documentation; implementation starts from `src/index.ts` after the domain language and ADRs stabilize.

## Current status

- Repo scaffold created.
- v1 `pi-goals` moved into `docs/reference/v1-pi-goals/pi-goals/` for reference.
- Full research snapshot copied into `docs/research/2026-05-14-pi-charter-design/`.
- Root `CONTEXT.md` defines the project language.
- ADRs in `docs/adr/` capture hard-to-reverse decisions.
- `docs/NEXT.md` tracks unresolved ends for the morning session.

## Documentation map

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Domain language and boundaries for pi-charter. Read first. |
| `docs/adr/` | Accepted architectural decisions and tradeoffs. |
| `docs/implementation/` | Implementation-oriented specs: filesystem layout, tools, lifecycle, verifier/evaluator. |
| `docs/research/2026-05-14-pi-charter-design/` | Full research and brainstorming archive. |
| `docs/reference/v1-pi-goals/` | Old v1 implementation preserved for reference only. |
| `docs/reference/pi-docs/extensions.md` | Pi extension API reference copied from local Pi docs. |
| `src/index.ts` | Empty runtime entrypoint stub. |

## Planned extension surface

Four LLM-callable tools:

- `charter_manage` — lifecycle FSM: create, pause, resume, complete, force-complete, amend charter.
- `charter_plan` — macro-DAG editing and viewing.
- `charter_record` — evidence, verification, and handoff writes.
- `charter_status` — read-only drift views, evaluator reason, and legal `nextActions[]`.

Single slash tree:

- `/charter` opens the widget/TUI/status surface.
- `/charter <objective>` creates a new charter shortcut.
- `/charter status|ls|resume|pause|force-complete|untrust-evaluator` are subcommands.

CLI flags:

- `pi --charter-objective "<text>"` creates and binds before turn 1.
- `pi --charter-resume <id>` rebinds before turn 1.

No spec auto-detect, no `--charter-spec`, and no path parameter on creation. If a prompt says "use `docs/spec.md`", the agent reads it with normal file tools and authors `charter.md` during planning.

## Development

```bash
bun run check-types
bun test
```

The package is private until naming, tool contracts, and implementation scope are ratified.
