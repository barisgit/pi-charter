# Filesystem layout

Charters are project-local under `.charters/`. Old `.pi/charters/` directories are never read or migrated.

```text
.charters/
└── <YYYYMMDD-HHMMSS>-<slug>/
    ├── charter.md
    ├── state.json
    ├── events.jsonl
    ├── work/
    └── REPORT.md          # created on first complete attempt
```

## `charter.md`

The single authored interface:

```markdown
## Objective
<descriptive outcome and rationale>

## References
<optional durable pointers>

## Scope
<optional boundaries>

## Criteria
### C1. <observable title>
<expected behavior, boundaries, important cases>
Depends: C0
Status: pending|in-progress|blocked|pass|fail — <note>
```

`References`, `Scope`, criterion bodies, and `Depends:` are optional. Grouping headings are inert. No `criteria.md` exists.

## `state.json`

Generated lifecycle/session/snapshot state: charter id, objective cache, lifecycle status, timestamps, session binding, sequence counters, latest source sequence, and normalized criterion snapshots (`status` plus `statusSeq`). It is not an authored contract.

Older snapshots containing `evidence`/`evidenceSeq` are normalized in memory and written back in the Status shape on the next update.

## `events.jsonl`

Append-only journal of lifecycle, source, and criterion Status changes. New criterion fields are `status.value` and `status.note`. Old `evidence.status` journal rows remain readable for failure-history compatibility.

## `work/`

Verification artifacts captured when the system is exercised: screenshots, recordings, logs, responses, or generated output. Artifacts are inspected and linked from pass/fail Status notes. They are not generated retroactively for the report.

## `REPORT.md`

Scaffolded on the first complete attempt from Objective, References, Scope, criterion bodies, dependencies, Status notes, and existing work artifacts. The agent curates it before retrying completion.
