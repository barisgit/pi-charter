# Filesystem layout

Charter state is project-local and explicit. The current runtime stores the authored charter as two Markdown files (`charter.md` + `criteria.md`) plus mutable JSON sidecars and append-only evidence/event files.

```text
<project>/.pi/charters/
├── index.json
└── <charterId>/
    ├── charter.md
    ├── criteria.md
    ├── state.json
    ├── criterion-state.json
    ├── REPORT.md                         # scaffolded on first complete attempt
    ├── events.jsonl
    ├── architecture.md                    # optional helper surface
    ├── prompts/
    │   └── ralph/
    │       └── <case>.md                  # optional Ralph prompt override
    ├── qa-briefs/
    │   └── <brief>.md                     # optional status/display briefs
    └── work/
        └── <feature-or-_charter>/
            └── evidence/
                └── <stamp>/
                    └── evidence.json
```

Reverse session binding:

```text
~/.pi/agent/sessions/<sessionId>/charter.json
```

There is no live `plan/`, `plan.json`, `feature-state.json`, `handoffs/`, `result.json`, or `work/<featureId>/notes.md` layout. `feature-state.json` only remains in comments/protected-file audit lists as a vestigial name; it is not read or written as a runtime sidecar.

## Source-of-truth rules

| File | Role | Mutable? | Author |
|---|---|---:|---|
| `charter.md` | Authored Objective, Scope and constraints, Mission Boundaries, and optional `## Commands` | Yes, authored surface | Agent/user |
| `criteria.md` | Authored VAL register grouped by milestone headings | Yes, authored surface | Agent/user |
| `state.json` | Lifecycle/session metadata, status, budget, and `lastToolWriteAt` | Yes, generated | pi-charter |
| `criterion-state.json` | Latest evidence pointer/outcome per VAL and `lastToolWriteAt` | Yes, generated | pi-charter |
| `REPORT.md` | Completion report scaffold/readiness gate | Yes, authored after scaffold | Agent/user |
| `events.jsonl` | Append-only lifecycle, evidence, and attributed subagent events | Append-only | pi-charter |
| `work/<feature-or-_charter>/evidence/<stamp>/evidence.json` | Append-only flat evidence records | Append-only | Agent/user-owned subagent via `charter_record` |
| `architecture.md` | Optional architecture helper target | Yes, optional | pi-charter helper / agent |
| `prompts/ralph/<case>.md` | Optional Ralph prompt override | Yes, optional | Agent/user |
| `qa-briefs/*.md` | Optional status/display briefs | Yes, optional | Agent/user |
| `index.json` | Project-local charter index | Yes, generated | pi-charter |
| `~/.pi/agent/sessions/<sid>/charter.json` | Reverse session binding | Yes, generated | pi-charter |

## `charter.md` and `criteria.md`

`charter.md` holds the narrative contract only. Criteria live in `criteria.md` for new charters; parsers still tolerate legacy inline `## Criteria` in `charter.md` for compatibility.

Recommended `charter.md` shape:

```md
# Charter: <short title>

## Objective

<one concise outcome>

## Scope and constraints

- <constraint or non-goal>

## Commands

- test: <command the agent may run and record as evidence>
```

Recommended `criteria.md` shape:

```md
# Criteria: <short title>

## <Milestone name>

### VAL-AREA-001 — <title>

Description: <observable assertion>
Pass criteria: <what must be true>
Failure modes: <what would disprove it>
Verifier: <descriptive check guidance only>
Command: <optional command guidance only>
RequireFreshEvidence: true | false
RequireReviewSubagent: true | false
```

`Verifier:` and `Command:` annotations are descriptive only. They tell the agent or reviewer what good evidence should demonstrate; pi-charter does not execute commands, hooks, prompt judges, verifier personas, or subagent dispatch. `RequireReviewSubagent` is display-only; `RequireFreshEvidence` remains a completion gate.

## Evidence record

Evidence is a flat row written under `work/<feature-or-_charter>/evidence/<stamp>/evidence.json`:

```json
{
  "charterId": "...",
  "criterionId": "VAL-BOOT-001",
  "featureId": "optional-segment",
  "recordedBy": "agent:root",
  "ts": "2026-05-15T02:33:04Z",
  "source": "manual",
  "outcome": "pass",
  "summary": "Observed the required behavior.",
  "because": "Manual evidence rationale when source is manual.",
  "details": {
    "command": "bun test",
    "exitCode": 0,
    "stdout": "..."
  }
}
```

Allowed `source` values are `manual`, `verifier`, and `subagent`; allowed `outcome` values are `pass`, `fail`, and `partial`. `because` is required for manual evidence. `recordedBy` is populated by the runtime/call site and displayed for provenance. Current evidence files may also include optional `artifacts`, `narrativePath`, or copied descriptive `verifier` text. Legacy typed evidence envelopes with `kind: "command" | "review" | "qa" | "readiness"`, `verdict`, or `observation` are rejected.

Writers may be the root agent or a delegated user-owned subagent. `criterion-state.json` stores the latest evidence path/outcome per criterion. `requireReviewSubagent` is a display-only annotation; `source` and `recordedBy` are surfaced as provenance, not completion predicates.

## Lazy directories

The charter workspace creates `work/` at charter creation. Per-segment evidence directories are lazy: `work/<feature-or-_charter>/evidence/<stamp>/` appears only when evidence is recorded or imported. `_charter` is used when no `featureId`/segment is supplied; feature ids are optional evidence grouping labels, not a persisted feature DAG.

## Binding reconciliation

Resolution order for tool calls is:

1. Explicit `charterId` argument.
2. Reverse binding at `~/.pi/agent/sessions/<sid>/charter.json`.
3. Service-level fallback to exactly one non-terminal charter in the project index when no session binding is involved.
4. Otherwise error with explicit choices.

Binding is bidirectional: `state.json.sessionId` is the forward pointer and the session file is the reverse pointer. `reconcileSessionBinding()` reads the reverse binding and repairs a missing or stale forward pointer from it when possible.
