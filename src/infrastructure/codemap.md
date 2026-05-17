# Infrastructure — Codemap

**Source dir:** `src/infrastructure/`
**Layer role:** Persistence, serialization, and cross-extension communication. No domain logic lives here.

---

## Files

| File | Responsibility |
|---|---|
| `store.ts` | Atomic filesystem I/O for charter workspaces: create, load, write, event append, index management. |
| `subagent-bridge.ts` | Typed constants and payload shapes for bidirectional `pi.events` bus communication with `pi-subagents`. No logic; pure redeclaration layer. |

---

## `store.ts`

### Responsibility

Manages all charter workspace state on disk under `<projectDir>/.pi/charters/<charterId>/`. Handles atomic writes, path-locked serialization for concurrent access, event append, and the charter index.

### Design Patterns

**1. Atomic tmp-rename writes (POSIX-safe)**
Every mutating file write uses `writeTextAtomicUnsafe`: write to `<path>.<pid>.<timestamp>.<random6hex>.tmp`, then `rename` (atomic on POSIX filesystems). This prevents torn writes and corrupted state files from interrupted agents.

**2. Per-path write queue (path mutex)**
`writeQueues: Map<string, Promise<unknown>>` is a lightweight in-process lock. Every `withPathLock(path, fn)` chains `fn` onto the existing promise for that path, guaranteeing ordered execution even when multiple async calls target the same file in the same agent turn (e.g., concurrent `charter_plan add_feature` calls). Failed writes use `.catch(() => undefined)` to prevent poison-pill propagation.

**3. Lazy index initialization**
`updateIndex` and `loadCharterIndex` both treat a missing or malformed `index.json` as `{ charters: [] }` rather than throwing. The index is eventually consistent: updated on each charter mutation but never the source of truth.

**4. Schema normalization at load time**
`normalizeCharterState` coerces unknown JSON shapes into the canonical `CharterState` interface, supplying defaults for missing optional fields (e.g., `createdAt`, `updatedAt`) and throwing on missing required fields (`charterId`, `objective`, `status`). This is the defensive boundary between disk and in-memory state.

### Data / Control Flow

```
createCharterWorkspace(input)
  │
  ├── mkdir(join(dir, "plan"), { recursive: true })
  │       → creates .pi/charters/<id>/plan/
  │
  ├── writeTextAtomic("charter.md", renderInitialCharterMarkdown(objective))
  │       → charter.md skeleton (worked example, not parsed back)
  │
  ├── writeJsonAtomic("state.json", state)
  │       → initial CharterState (status: "planning")
  │
  ├── writeJsonAtomic("plan.json", { milestones: [], features: [] })
  │       → empty milestone/feature DAG
  │
  ├── writeJsonAtomic("feature-state.json", { features: {} })
  │       → per-feature completion bitmap
  │
  ├── writeJsonAtomic("criterion-state.json", { criteria: {} })
  │       → per-criterion evidence records
  │
  ├── appendEvent("events.jsonl", { type: "charter_created", ... })
  │       → first event in append-only event log
  │
  └── updateIndex("index.json", state)
          → upsert row in .pi/charters/index.json
```

**Load path:**
```
loadCharterState(dirOrProject, charterId?)
  └── normalizeCharterState(JSON.parse(readFile("state.json")))
```

**Event append path:**
```
appendEvent(dir, event)
  └── withPathLock("events.jsonl")
        └── readFile(existing "") → writeTextAtomicUnsafe(existing + newline + JSON)
              └── rename(tmp → events.jsonl)
```

**Index read path:**
```
loadCharterIndex(projectDir)
  └── JSON.parse(index.json).charters[]
        └── filter(isIndexRow)  ← guards against null/extra fields
```

### Integration Points

| Imported from | Symbol | Usage |
|---|---|---|
| `domain/charter-md` | `renderInitialCharterMarkdown` | Generates the `charter.md` scaffold at workspace creation. |
| `domain/types` | `Budget`, `CharterEvent`, `CharterState` | All disk-serialized shapes are `CharterState` or subtypes. |
| Node.js `node:fs/promises` | `mkdir`, `readFile`, `rename`, `writeFile` | All filesystem I/O. |
| Node.js `node:crypto` | `randomBytes(6)` | Temp file suffix entropy for sub-ms collision prevention. |
| Node.js `node:path` | `dirname`, `join` | Path construction. |

### Exported API Surface

| Symbol | Signature | Notes |
|---|---|---|
| `CreateCharterWorkspaceInput` | interface | Input to `createCharterWorkspace`. |
| `CreatedCharterWorkspace` | interface | Return type of `createCharterWorkspace`. |
| `CharterIndexRow` | interface | Shape of entries in `index.json`. |
| `chartersRoot` | `(projectDir) => string` | Pure path helper. |
| `charterDir` | `(projectDir, charterId) => string` | Pure path helper. |
| `createCharterWorkspace` | `(projectDir, input) => Promise<CreatedCharterWorkspace>` | Full workspace bootstrap. |
| `loadCharterState` | `(dirOrProject, charterId?) => Promise<CharterState>` | Lazy state hydration. |
| `writeCharterState` | `(dir, state) => Promise<void>` | Atomic state write. |
| `loadCharterIndex` | `(projectDir) => Promise<CharterIndexRow[]>` | Index read with graceful fallback. |
| `appendEvent` | `(dir, event) => Promise<void>` | Path-locked append to `events.jsonl`. |
| `writeJsonAtomic` | `(path, value) => Promise<void>` | Pretty-printed JSON atomic write. |
| `writeTextAtomic` | `(path, value) => Promise<void>` | Path-locked text atomic write. |

### Filesystem Layout (per charter)

```
.pi/charters/
├── index.json                          ← global charter registry (managed by store.ts)
└── <charterId>/
    ├── charter.md                       ← authored source of truth
    ├── state.json                       ← runtime CharterState snapshot
    ├── events.jsonl                     ← append-only event log
    ├── plan.json                        ← milestone + feature DAG (managed by service.ts)
    ├── feature-state.json               ← per-feature completion bitmap
    ├── criterion-state.json             ← per-criterion evidence records
    └── plan/
        └── <plan artifacts>            ← plan-specific artifacts (if any)
```

---

## `subagent-bridge.ts`

### Responsibility

Typed bridge for `pi.events` bus communication between `pi-charter` and `pi-subagents`. Locally redeclares event constants and payload shapes from `pi-subagents/types.ts` so the two extensions stay decoupled. No runtime behavior; purely declarative.

### Design Pattern: Decoupled Extension Communication

`pi-charter` and `pi-subagents` are independent extensions. They communicate exclusively over the shared `pi.events` pub/sub bus. Each side redeclares the constants it emits or consumes; there is no direct import. This avoids a hard dependency and allows the two extensions to evolve independently (analogous to the `pi-prune-router` / `pi-prune-swe-pruner-provider` pattern).

### Event Constants

| Constant | `pi.events` event name | Direction |
|---|---|---|
| `SUBAGENT_EXPOSE_API_EVENT` | `"subagent:expose-api"` | Consumed by pi-charter (requests pi-subagents' API) |
| `SUBAGENT_REGISTER_PERSONA_DIR_EVENT` | `"subagent:register-persona-dir"` | Consumed by pi-subagents (pi-charter registers persona dirs) |
| `SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT` | `"subagent:unregister-persona-dir"` | Consumed by pi-subagents |
| `SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT` | `"subagent:register-persona-dir-error"` | Consumed by pi-charter (conflict notification) |
| `SUBAGENT_ASYNC_STARTED_EVENT` | `"subagent:async-started"` | Consumed by pi-charter (async delegation lifecycle) |
| `SUBAGENT_ASYNC_COMPLETE_EVENT` | `"subagent:async-complete"` | Consumed by pi-charter |

### Metadata Key Convention

When the host agent delegates to a charter persona via `subagent({...})`, it embeds structured metadata in the opaque `metadata` bag. pi-subagents copies this bag verbatim into `subagent:async-*` event payloads. pi-charter reads the keys back to attribute async runs to the correct charter/feature/criterion.

| Key | Type | Purpose |
|---|---|---|
| `PI_CHARTER_METADATA_KEYS.projectDir` | `"pi-charter.projectDir"` | Required. Locates the per-project charter directory (no `ctx.cwd` available in `pi.events` handlers). |
| `PI_CHARTER_METADATA_KEYS.charterId` | `"pi-charter.charterId"` | Attributes the run to a specific charter. |
| `PI_CHARTER_METADATA_KEYS.featureId` | `"pi-charter.featureId"` | Attributes the run to a specific feature. |
| `PI_CHARTER_METADATA_KEYS.criterionId` | `"pi-charter.criterionId"` | Attributes the run to a specific criterion. |

### Payload Shapes (redeclared)

All `interface` types in this file are locally redeclared copies of `pi-subagents/types.ts`. They must be kept in sync manually if pi-subagents renames or restructures any type. Affected payloads:

- `RegisterPersonaDirPayload` — sent on `subagent:register-persona-dir`
- `UnregisterPersonaDirPayload` — sent on `subagent:unregister-persona-dir`
- `PersonaDirErrorPayload` — received on `subagent:register-persona-dir-error`
- `SpawnRawInput` — shape of the `spawnRaw` call on the exposed API
- `SpawnRawResult` — return type of `spawnRaw`
- `SubagentExposedAPI` — interface for the API pi-subagents exposes
- `SubagentAsyncStartedPayload` — body of `subagent:async-started`
- `SubagentAsyncCompletePayload` — body of `subagent:async-complete`

### Integration Points

This module has no imports from the rest of pi-charter. It is a pure type/constant declaration file consumed by `application/` (likely `service.ts`) to:
1. Emit events to pi-subagents (e.g., persona dir registration, spawning with metadata).
2. Register `pi.events.on()` handlers for async lifecycle events.
3. Read metadata back from completed async subagent runs.

### Extension Identity

| Constant | Value |
|---|---|
| `PI_CHARTER_EXTENSION_ID` | `"pi-charter"` |
| `PI_CHARTER_METADATA_PREFIX` | `"pi-charter."` |

---

## Shared Characteristics

- **No domain logic**: Neither file contains `CharterCriterion` parsing, status machine transitions, evidence evaluation, or charter plan manipulation. Those belong in `domain/` and `application/`.
- **Synchronous helpers are pure**: `chartersRoot`, `charterDir` are pure path calculators; `isStatus`, `isIndexRow` are pure type guards.
- **All mutating I/O is async**: No synchronous `fs` calls; all reads/writes go through `node:fs/promises`.
- **Single writer assumption**: The path mutex in `writeQueues` only orders writes within a single Node.js process. Cross-process concurrency (two Pi agents in the same project) is not protected and must be handled at a higher layer or by the filesystem's `O_APPEND` semantics for `events.jsonl`.
