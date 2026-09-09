# src/infrastructure/

## Responsibility

Provides durable charter storage, serialized writes, diagnostic logging, and cross-extension event names. It isolates filesystem and external utility details from lifecycle and guard policy.

## Design patterns

- **Repository/data mapper:** `store.ts` maps `.charters/<id>/` files to `CharterState`, parsed Markdown, list rows, and events.
- **Project mutation lock:** a project-wide lock serializes lifecycle, snapshot, and Ralph guard changes.
- **Atomic write:** text and JSON are written to same-directory random temporary files and renamed into place.
- **Append-only journal:** `events.jsonl` records lifecycle, `ralph_activated`, guard-pause, and whole-file change events; current runtime state stays in `state.json`.
- **Read-only legacy adapter:** `file-interface` state can load for display, but write paths reject it.
- **Shared-event bridge:** `subagent-bridge.ts` redeclares pi-subagents event constants without a runtime package dependency.

## Data and control flow

1. `createCharterWorkspace()` renders the phases scaffold and writes `charter.md`, phases `state.json`, and `events.jsonl`.
2. Load functions normalize phases or legacy state, parse charter.md, list timestamp-sorted directories, and omit malformed list entries.
3. `snapshots.ts` uses `hashText()` and store writes to persist optional whole-file hashes and append change events.
4. Lifecycle and Ralph operations use `withCharterLock()`; lower-level writes and journal appends use path/file locks.
5. `ensureWorkDir()` and `reportPath()` expose artifact/report locations without deciding verification quality.

## Integration points

- Depends on Node filesystem, path, crypto, OS, and timer APIs.
- Depends on `src/domain/template.ts`, `charter-file.ts`, and `types.ts` for content and state shapes.
- Consumed by `src/application/service.ts`, `snapshots.ts`, `ralph.ts`, and UI read projections.
- `logger.ts` integrates with `pi-extension-utils`; environment overrides remain local to logging.
