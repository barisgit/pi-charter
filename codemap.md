# Repository Atlas: pi-charter

## Project Responsibility

`pi-charter` is a Pi extension for durable, charter-bound agent work. A charter's authored interface is `.charters/<id>/charter.md`; runtime sidecars preserve lifecycle state, snapshots, and an append-only event journal while the extension exposes one lifecycle tool with compact transcript rendering, slash commands, Ralph steering, a dashboard, and a status widget.

## System Entry Points

- `package.json` — package metadata, Pi extension/skill declarations, dependencies, and the `check-types`, `test`, and `ci` scripts.
- `src/index.ts` — default Pi extension entry point; registers flags, the `charter` tool, slash commands, staleness hooks, widget, Ralph loop, and Ralph message renderer.
- `src/codemap.md` — source-level architecture and control-flow map.

## Design Patterns

- **Layered architecture:** `domain` defines the file grammar and state vocabulary; `application` orchestrates lifecycle use cases; `infrastructure` owns persistence and host bridges; `ui` projects status into TUI views.
- **File-as-interface:** agents edit `charter.md` directly; tool-result hooks snapshot-diff it instead of providing criterion mutation APIs.
- **Event journal plus snapshot:** current lifecycle/snapshot state is stored in `state.json`, while changes are appended to `events.jsonl`.
- **Host adapter:** `src/index.ts` composes Pi API registrations without containing business logic.

## Data and Control Flow

1. Pi loads `src/index.ts` from the `pi.extensions` declaration in `package.json`.
2. Tool or slash-command input enters `src/application/registration.ts`, which validates/parses it and dispatches a lifecycle use case in `src/application/service.ts`.
3. Services use `src/domain/` parsing, identifiers, templates, and types, then persist `.charters/<id>/` through `src/infrastructure/store.ts`.
4. Tool-result/session hooks refresh charter snapshots, append change events, advance staleness sequence counters, and schedule Ralph continuation when appropriate.
5. `src/ui/` loads application status projections and renders the picker and above-editor widget through Pi TUI and `pi-extension-utils`.

## Integration Points

- Pi host APIs: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`.
- `typebox` defines the single `charter({ action, id?, objective?, note? })` tool schema.
- `pi-extension-utils` supplies host connection, widgets, pane overlay, and file logging.
- The shared `pi.events` bus receives pi-subagents lifecycle events and carries Ralph widget warning events.
- Persistent project data is rooted at `.charters/`; diagnostic logs are written under the Pi agent log directory (or `PI_CHARTER_LOG_PATH`).

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
| --- | --- | --- |
| `src/` | Extension composition and layered runtime implementation. | [`src/codemap.md`](src/codemap.md) |
| `src/application/` | Lifecycle use cases, Pi registrations, hooks, staleness, and Ralph orchestration. | [`src/application/codemap.md`](src/application/codemap.md) |
| `src/domain/` | Charter grammar, identifiers, scaffold generation, and core state/event types. | [`src/domain/codemap.md`](src/domain/codemap.md) |
| `src/infrastructure/` | Filesystem persistence, atomic serialization, logging, and subagent event constants. | [`src/infrastructure/codemap.md`](src/infrastructure/codemap.md) |
| `src/ui/` | Read-only charter dashboard, status projections, selection state, and widget rendering. | [`src/ui/codemap.md`](src/ui/codemap.md) |
