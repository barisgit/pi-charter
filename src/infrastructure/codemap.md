# src/infrastructure/

## Responsibility
Infrastructure support for the runtime: filesystem persistence for charter workspaces, centralized file logging, and local type/constant redeclarations for the `pi-subagents` event bus. This folder does not implement registered tool actions, status transitions, evidence scoring, verification execution, or planning logic.

Files:

| File | Current responsibility |
|---|---|
| `store.ts` | Creates/loads charter workspaces under `.pi/charters/`, performs atomic JSON/text writes, appends events, normalizes legacy state, and maintains `.pi/charters/index.json`. |
| `logger.ts` | Singleton logger that writes formatted diagnostics to a file without touching stdout/stderr. |
| `subagent-bridge.ts` | Pure declarations for `pi-subagents` event names, metadata keys, and payload/API shapes; no runtime listeners or emitters live here. |

## Design
`store.ts` is the disk boundary for charter runtime state:
- `chartersRoot(projectDir)` and `charterDir(projectDir, charterId)` are path helpers for `<projectDir>/.pi/charters` and a per-charter directory.
- `withCharterLock(charterDir, fn)` serializes broader per-charter mutations in-process by resolved charter directory.
- `writeTextAtomic` / `writeJsonAtomic` wrap `writeTextAtomicUnsafe`, which writes `<path>.<pid>.<timestamp>.<random6hex>.tmp` and renames it into place.
- `withPathLock(path, fn)` serializes in-process writes by path; `appendEvent` and `updateIndex` do read-modify-write work inside this lock.
- `loadCharterState` parses `state.json` through `normalizeCharterState`, accepting current statuses plus legacy statuses for back-compat mapping: `planning`, `review`, and `awaiting-clarification` become `active`; `budget_limited` becomes `abandoned`.
- `loadParsedCharter` reads `charter.md` and optionally `criteria.md`; a default `VAL-EXAMPLE` criteria scaffold is ignored so authored inline criteria in `charter.md` remain effective.

`logger.ts` is a process-local logging singleton:
- `logger` starts at `info` level, switches to `debug` when `PI_CHARTER_DEBUG` is `1` or `true`, and can be reconfigured with `setLevel`, `setDefaultContext`, `addHandler`, and `clearHandlers`.
- The log destination is `PI_CHARTER_LOG_PATH` if set, otherwise `~/.pi/logs/extensions/pi-charter.log`.
- `appendEntryToFile` uses synchronous `mkdirSync`/`appendFileSync` and swallows all failures so diagnostics cannot break the Pi TUI/runtime.
- `child(context)` returns a `ChildLogger` that merges contextual fields into subsequent messages.

`subagent-bridge.ts` intentionally contains no imports from the rest of pi-charter and no direct import from pi-subagents. It redeclares the shared bus contract: event constants, `PI_CHARTER_EXTENSION_ID`, `PI_CHARTER_METADATA_PREFIX`, `PI_CHARTER_METADATA_KEYS`, spawn/API shapes, async lifecycle payloads, lineage payloads, and all-idle payloads.

## Flow
Charter creation through `createCharterWorkspace(projectDir, input)` currently writes exactly this layout:

```text
.pi/charters/
├── index.json                       # global registry, upserted by updateIndex
└── <charterId>/
    ├── charter.md                   # renderInitialCharterMarkdown(objective, name)
    ├── criteria.md                  # renderInitialCriteriaMarkdown(name)
    ├── state.json                   # CharterState with status: "active", schemaVersion: "v2"
    ├── criterion-state.json         # { charterId, criteria: {}, lastToolWriteAt }
    ├── events.jsonl                 # first line is charter_created event
    └── work/                        # empty working directory scaffold
```

There is no `plan.json`, no `feature-state.json`, and no `plan/` directory created by `store.ts`.

Creation sequence:
1. Build `CharterState` with trimmed objective, optional `name`/`budget`/`sessionId`, timestamps from `input.now`, `status: "active"`, and `lastToolWriteAt`.
2. `mkdir(join(dir, "work"), { recursive: true })`.
3. Atomically write `charter.md`, `criteria.md`, `state.json`, and `criterion-state.json`.
4. Append `{ type: "charter_created", ts, charterId, objective }` to `events.jsonl` via path-locked read + atomic rewrite.
5. `updateIndex(root, state)` path-locks `.pi/charters/index.json`, reads existing rows if present, replaces any row for the same charter id, and writes `{ charters: [...others, row] }`.

Read/write paths:
- `loadCharterState(dirOrProject, charterId?)` resolves the charter dir, reads `state.json`, normalizes status/schema fields, and tags old inline-criteria charters as `schemaVersion: "v1-needs-replan"` when applicable.
- `writeCharterState(dir, state, toolWriteAt?)` updates `state.lastToolWriteAt` and atomically writes `state.json`.
- `loadCharterIndex(projectDir)` returns `[]` on missing/malformed index and filters entries with `isIndexRow`.
- `loadParsedCharter(dirOrProject, charterId?)` reads markdown sources and delegates parsing to `domain/charter-md`.

Subagent bridge flow:
- Other modules import constants such as `SUBAGENT_EXPOSE_API_EVENT`, `SUBAGENT_ASYNC_STARTED_EVENT`, `SUBAGENT_ASYNC_COMPLETE_EVENT`, `SUBAGENT_LINEAGE_EVENT`, and `SUBAGENT_ALL_IDLE_EVENT` when wiring `pi.events` listeners/emitters.
- Metadata keys (`pi-charter.projectDir`, `.charterId`, `.featureId`, `.criterionId`) are used to attribute async subagent events back to a charter context.
- Persona-dir registration constants and payload interfaces are still declared, but this folder does not register any bundled personas; there are zero bundled persona implementations in `src/infrastructure/`.

## Integration
Imports used by this folder:
- `store.ts` imports `parseCharterMarkdown`, `renderInitialCharterMarkdown`, and `renderInitialCriteriaMarkdown` from `../domain/charter-md` plus `Budget`, `CharterEvent`, `CharterState`, `LegacyCharterStatus`, and `ParsedCharterMarkdown` types from `../domain/types`.
- `store.ts` uses Node `fs/promises`, `crypto.randomBytes`, and `path` helpers for persistence.
- `logger.ts` uses Node `fs`, `os.homedir`, and `path` to format and append extension logs.
- `subagent-bridge.ts` has no imports; it is consumed by application code that wires `pi.events` and async-subagent attribution.

Exported API surface:
- `store.ts`: `CreateCharterWorkspaceInput`, `CreatedCharterWorkspace`, `CharterIndexRow`, `loadParsedCharter`, `withCharterLock`, `chartersRoot`, `charterDir`, `createCharterWorkspace`, `loadCharterState`, `isV1Charter`, `writeCharterState`, `loadCharterIndex`, `appendEvent`, `writeJsonAtomic`, `writeTextAtomic`.
- `logger.ts`: `LogLevel`, `LogContext`, `LogEntry`, `logger`.
- `subagent-bridge.ts`: event constants, charter metadata constants, and payload/API interfaces for registration, spawn, async lifecycle, lineage, and idle events.

## Vestigial / tech-debt
- `store.ts:34` defines private `charterHasInlineCriteria`, but this local helper is not called anywhere in `store.ts`; an equivalent helper exists in UI code.
- `store.ts:161` comment still mentions `charter_plan` calls, but the registered tool surface has no `charter_plan`; the lock itself is still live and generic.
- `subagent-bridge.ts:19-21` still declares persona-dir registration/unregistration/error event constants and payload shapes. They are bridge-contract remnants only here; current registered tools do not expose persona registration and this repo has zero bundled charter personas.
- `subagent-bridge.ts:48` still includes a `featureId` metadata key for async attribution. In the current v3 runtime, Objective -> Milestone -> VAL is the live model and feature DAG planning primitives are gone; this key is a compatibility residue unless consumers still populate it.
- `feature-state.json`, `plan.json`, and `plan/` are not current workspace sidecars created by `store.ts`; any older codemap language describing them as live creation artifacts was stale.
