# pi-charter

`pi-charter` is a Pi extension design for durable, charter-bound agent work: the agent starts from an objective, authors or reuses a `charter.md`, decomposes the work into feature files, records evidence against criteria, and uses evaluator feedback as smart-Ralph steering.

This repo is intentionally scaffold-first. The current source of truth is the documentation; implementation starts from `src/index.ts` after the domain language and ADRs stabilize.

## Current status

**Standalone extension: feature-complete and tested.** 38 tests / 121 assertions green, types clean, ~2488 LOC of `src/`.

- Four LLM-callable tools wired: `charter_manage`, `charter_plan`, `charter_record`, `charter_status`.
- Lifecycle FSM with completion gate, hook bus, drift views, session binding, planner-critic, command verifiers.
- Post-turn `charter-evaluator` modeled on Claude Code's `/goal` (default model `anthropic/claude-haiku-4-5`).
- Bundled internal personas: `charter-verifier`, `charter-planner-critic` (both `scope: internal`, haiku model).
- Per-project layout: `<project>/.pi/charters/<charterId>/{charter.md, state.json, plan/, work/, events.jsonl, ...}`.
- v1 `pi-goals` preserved at `docs/reference/v1-pi-goals/pi-goals/`.
- Research and ADRs in `docs/research/2026-05-14-pi-charter-design/` and `docs/adr/`.

**External dependency not blocking dogfood:** pi-subagents needs three event-bus surfaces before the agent can delegate to bundled personas; see `docs/NEXT.md` for the exact handoff.

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

The package is private until naming, tool contracts, and the pi-subagents event-bus bridge land.
