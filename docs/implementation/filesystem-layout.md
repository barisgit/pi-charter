# Filesystem layout

Charters are project-local under `.charters/`:

```text
.charters/
└── <YYYYMMDD-HHMMSS>-<slug>/
    ├── charter.md
    ├── state.json
    ├── events.jsonl
    ├── work/
    └── REPORT.md
```

## `charter.md`

The single authored interface for new charters:

```md
# Objective

<authorized outcome, constraints, verification expectations, and report requirements>

## References

<optional durable pointers and their roles>

## Scope

<optional boundaries>

## Phases

1. Explore phases
2. Implement — current
   Notes about work and progress.
3. Verify — upcoming
   - UI result: [screenshot](work/result.png)
   - Full flow: [recording](work/flow.mp4)
```

`# Objective` is required. Nested headings such as `## Constraints` and `### Verification` remain part of its body. Only a new top-level heading or the reserved `## References`, `## Scope`, and `## Phases` sections end that body. Those reserved sections are optional in parsed files. Creation writes exact `1. Explore phases` under `## Phases`.

A phase is an ordered Markdown item. Its optional exact suffix is `— upcoming`, `— current`, or `— done`. Indented Markdown belongs to its body. If no phase is explicitly `current`, the initial bare phase or first unfinished unmarked phase is `current` by inference; other unmarked phases are `upcoming`.

There is no phase-count limit, dependency syntax, per-phase evidence field, freshness field, or phase completion gate.

## `state.json`

New state has `schemaVersion: "phases"` and retains the lifecycle fields: charter id, lifecycle status, timestamps, and session binding. It may also contain:

- `snapshotHash` for whole-file change journaling;
- `ralph.activations`, a rolling list of actual send times;
- `ralph.warnedAt` when recovery began;
- `ralph.pausedByGuard` when the guard paused the charter.

It contains no criterion snapshots, per-phase state, global tool sequence, or source-change sequence.

A state with `schemaVersion: "file-interface"` is legacy. The store may load it for dashboard display only. Mutation, resume, migration, and write-back are forbidden. Old `.pi/charters/` paths remain outside the current store.

## `events.jsonl`

The append-only journal records lifecycle transitions and meaningful whole-file charter changes. It is not a second authored phase state.

## `work/`

The worker saves screenshots, recordings, output, and other artifacts here at verification time. Relevant files may be linked from an indented phase body. The runtime does not require an artifact count.

## `REPORT.md`

The final artifact-rich delivery narrative. Completion generates it when needed without requiring a deliberately failed completion attempt. If the worker has already curated it, completion preserves that content. The Visual Evidence section collects recognized local image and recording links, including terminal `.cast` recordings. Absolute local capture paths are retained as links without reading or copying their contents; prefer `work/` links for a portable report. An omitted completion note is labeled as missing rather than replaced with an invented audit claim.
