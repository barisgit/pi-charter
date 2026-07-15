# src/infrastructure/

## Responsibility

Provides adapters for durable charter storage, serialized writes, diagnostic logging, and cross-extension event names. It isolates filesystem and external utility details from application lifecycle rules.

## Design Patterns

- **Repository/data mapper:** `store.ts` maps `.charters/<id>/` files to `CharterState`, parsed charter, list-row, and event objects.
- **Unit-of-work locking:** per-charter promise queues serialize lifecycle operations; per-path queues serialize writes and journal appends within the process.
- **Atomic write:** text and JSON are written to same-directory random temporary files and renamed into place.
- **Append-only journal:** events are newline-delimited JSON in `events.jsonl`; current state remains in `state.json`.
- **Adapter/facade:** `logger.ts` wraps `pi-extension-utils.createLogger` with levels, contextual child loggers, optional handlers, and failure isolation.
- **Shared-event bridge:** `subagent-bridge.ts` locally redeclares pi-subagents event constants to avoid a runtime package dependency.

## Data and Control Flow

1. `createCharterWorkspace()` renders and parses the domain scaffold, creates `.charters/<id>/`, atomically writes `charter.md`, `state.json`, and `events.jsonl`, then appends `charter_created`.
2. Load functions read and normalize state, parse `charter.md`, list timestamp-sorted charter directories, and tolerate malformed list entries by omitting them.
3. Application snapshot refreshes hash charter text with SHA-256, convert parsed criteria through `snapshotFromParsed()`, write normalized state, and append change/source events.
4. Lifecycle operations use `withCharterLock()` while lower-level writes use path locks; `ensureWorkDir()` and `reportPath()` expose evidence/report locations without creating application policy.
5. Logging calls are level-filtered, enriched with default/child context, forwarded to a rotating file logger, and optionally delivered to in-memory handlers; logger failures never reach the Pi TUI.

## Integration Points

- Depends on Node `fs/promises`, `path`, and `crypto` for storage, atomic rename, path resolution, and hashes.
- Depends on `src/domain/template.ts`, `src/domain/charter-file.ts`, and `src/domain/types.ts` for persisted content and shapes.
- Consumed primarily by `src/application/service.ts` and `src/application/staleness.ts`; `src/ui/picker-snapshot.ts` and `src/ui/widget-service.ts` use read/list/report APIs.
- `logger.ts` integrates with `getAgentDir()` and `pi-extension-utils`; `PI_CHARTER_LOG_PATH` overrides the log directory and `PI_CHARTER_DEBUG` lowers the level.
- `subagent-bridge.ts` constants are consumed by the Ralph loop through the shared Pi event bus.
