# src/infrastructure/

## Responsibility

Provides durable charter storage, serialized writes, diagnostic logging, and cross-extension event names. It isolates filesystem and external utility details from lifecycle and guard policy.

## Design patterns

- **Repository/data mapper:** `store.ts` maps `.charters/<id>/` files to `CharterState`, parsed Markdown, list rows, and events.
- **Project mutation lock:** a project-wide lock serializes lifecycle and Ralph guard changes; reads never take it.
- **Atomic write:** text and JSON are written to same-directory random temporary files and renamed into place.
- **Append-only journal:** `events.jsonl` records lifecycle, `ralph_activated`, and guard-pause events (older journals may also hold `charter_file_changed`); current runtime state stays in `state.json`.
- **Read-only legacy adapter:** `file-interface` state can load for display, but write paths reject it.
- **Shared-event bridge:** `subagent-bridge.ts` redeclares pi-subagents event constants without a runtime package dependency.

## Data and control flow

1. `createCharterWorkspace()` renders the Objective template and writes `charter.md`, a writable `state.json` (historical `schemaVersion: "phases"`), and `events.jsonl`.
2. Load functions normalize writable or legacy state, parse charter.md, list timestamp-sorted directories, and omit malformed list entries.
3. Lifecycle and Ralph operations use `withCharterLock()`; lower-level writes and journal appends use path/file locks.
5. `reportPath()` locates an optional worker-authored REPORT.md for display; the store never creates one.

## Integration points

- Depends on Node filesystem, path, crypto, OS, and timer APIs.
- Depends on `src/domain/template.ts`, `charter-file.ts`, and `types.ts` for content and state shapes.
- Consumed by `src/application/service.ts`, `ralph.ts`, and UI read projections.
- `logger.ts` integrates with `pi-extension-utils`; environment overrides remain local to logging.
