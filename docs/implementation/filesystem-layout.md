# Filesystem layout

Charters are project-local under `.charters/`:

```text
.charters/
└── <YYYYMMDD-HHMMSS>-<slug>/
    ├── charter.md
    ├── state.json
    ├── events.jsonl
    ├── work/        # optional
    └── REPORT.md    # optional
```

## `charter.md`

The single authored interface:

```md
# Objective

<full authorized outcome, constraints, verification expectations, and requested deliverables>

## References

<optional durable sources of authority and their roles>

## Scope

<optional boundaries>

## Notes

<optional ordinary Markdown>
```

`# Objective` is required. Nested headings such as `## Constraints` and `### Verification` remain part of its body; `## References`, `## Scope`, `## Notes`, the historical `## Phases`, or a new top-level heading ends it. Only the Objective, References, and Scope carry meaning. Everything else is ordinary notes with no grammar, status, or gate.

Creation writes the Objective plus commented, optional References and Scope sections; there is no phase section or scaffold. Existing charters keep their authored text unchanged; a `## Phases` section in them is inert notes, never parsed or rewritten, and never leaks into the Objective.

## `state.json`

Writable state keeps the historical storage label `schemaVersion: "phases"` for compatibility; the persisted shape is unchanged and the name implies no phase feature. It holds the charter id, lifecycle status, timestamps, and session binding, and may also contain:

- `ralph.activations`, a rolling list of actual send times;
- `ralph.warnedAt` when recovery began;
- `ralph.pausedByGuard` when the guard paused the charter.

It contains no criterion snapshots, file hash (a `snapshotHash` in older files is ignored and dropped by the next lifecycle write), phase state, reminder counters, global tool sequence, or source-change sequence.

A state with `schemaVersion: "file-interface"` is legacy. The store may load it for dashboard display only. Mutation, resume, migration, and write-back are forbidden. Old `.pi/charters/` paths remain outside the current store.

## `events.jsonl`

The append-only journal of lifecycle transitions and Ralph activations. Older journals may contain `charter_file_changed` entries from the removed edit journal; they are history and are never rewritten.

## Internal lock files

`.charters/.mutation.lock` and each `events.jsonl.lock` are persistent SQLite files. An exclusive transaction provides cross-process locking, and the operating system releases it if a process exits. The files remain after unlock; their presence does not mean a writer is active.

The store converts legacy lock directories with a dead local PID or a `releasing-*` marker before opening the SQLite file. It leaves empty, malformed, and foreign-host legacy directories untouched because their owner cannot be identified safely.

## `work/` and `REPORT.md`

Optional conveniences for artifacts and a report the Objective asks for. The runtime never requires, generates, or overwrites them, and existing files are preserved.
