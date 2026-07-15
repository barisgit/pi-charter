# Unify criterion activity and evidence in Status

Status: accepted; amends ADR-0013 and ADR-0014

## Context

ADR-0014 reduced pi-charter to one authored file and one lifecycle tool, but its scaffold encouraged an Objective followed by title-only criteria whose `Evidence: pass|fail|none` lines described only verification. In practice that surface was too close to a tactical task list: it carried too little durable context for handoffs and could not show users which criteria were currently being worked on.

Adding a separate activity field would make criterion state contradictory (`Status: in-progress` beside `Evidence: pass`) and restore avoidable ceremony. Treating criteria as tasks would instead duplicate pi-dag-tasks and weaken the charter's role as a durable outcome contract.

## Decision

### One authored state line

Each criterion has one canonical state line:

```md
Status: pending|in-progress|blocked|pass|fail — <note>
```

The values mean:

- `pending`: not currently being worked on and not verified as satisfied.
- `in-progress`: currently being worked on.
- `blocked`: progress cannot currently continue; the note should explain why.
- `pass`: verification observed that the criterion is satisfied; the note records that evidence and any artifact paths.
- `fail`: verification observed that the criterion is not satisfied; the note records what failed.

A note is required for `pass`, encouraged for `fail` and `blocked`, and optional for `pending` and `in-progress`. Latest authored state lives in `charter.md`; transitions live in `events.jsonl`.

There is no authored `stale` value. Staleness remains the global, sequence-counter computation over pass status and source-modifying tool calls. Completion still requires every criterion to have a fresh `pass` with a non-empty evidence note. Every other status blocks completion because the criterion is not yet demonstrated, not because `blocked` or `Depends:` gains special gate semantics.

### Legacy input compatibility

The tolerant parser accepts existing `Evidence: pass|fail|none — <note>` lines as a legacy input alias, mapping `none` to `pending`. New templates, parsed projections, reports, events, documentation, and UI use Status terminology only. Existing sidecar snapshots and journals are decoded compatibly; no authored-file migration is required and `.pi/charters/` remains unread.

### Richer authoring without prose gates

A charter should carry enough durable meaning to resume after compaction, handoff, or agent replacement:

- Objective is normally descriptive prose explaining the intended outcome and why it matters, not a task title.
- References is an optional inert section containing durable pointers to relevant specs, plans, handoffs, ADRs, docs, or code, with a short indication of each reference's role.
- Scope remains optional inert prose defining in-scope and out-of-scope boundaries.
- Each criterion has a concise observable assertion and a prose body explaining expected behavior, boundaries, or important cases.
- A substantial charter should usually find roughly 10–20 independently meaningful criteria. This is guidance, never a parser or completion gate; narrow work may use fewer and criteria must not be padded with implementation tasks.

The charter says why and what must become true. pi-dag-tasks continues to own tactical next steps and execution ordering.

### Presentation hierarchy

The compact widget shows overall progress, status counts, and the titles of currently in-progress or blocked criteria. It does not render the full charter.

The `/charters` dashboard renders the descriptive Objective, References, Scope, criterion bodies, dependencies, Status notes, freshness, and progress. This is a read-only projection of `charter.md`, not another authored surface.

## Consequences

- Users can see current activity without a second mutable field.
- Pass and fail notes remain evidence under ADR-0013; pi-charter still records checks and never runs them.
- Runtime projections and UI gain five criterion statuses instead of three evidence outcomes.
- Compatibility code must normalize legacy files, snapshots, and journal events without making legacy names part of the new domain model.
- Richer charters take more authoring judgment, but no word count, criterion count, section-presence, or formatting gate is added.
