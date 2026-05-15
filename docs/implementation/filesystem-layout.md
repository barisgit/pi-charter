# Filesystem layout

Charter state is project-local and explicit.

```text
<project>/.pi/charters/
├── index.json
└── <charterId>/
    ├── charter.md
    ├── state.json
    ├── plan/
    │   ├── <featureId>.md
    │   └── ...
    ├── plan.json
    ├── feature-state.json
    ├── criterion-state.json
    ├── events.jsonl
    ├── work/
    │   └── <featureId>/
    │       ├── notes.md
    │       └── evidence/
    │           └── VAL-...__<isoTs>.json
    ├── handoffs/
    │   └── <isoTs>__<featureId>__<sessionId>.json
    └── result.json
```

Reverse session binding:

```text
~/.pi/agent/sessions/<sessionId>/charter.json
```

## Source-of-truth rules

| File | Role | Mutable? | Author |
|---|---|---:|---|
| `charter.md` | Objective, Criteria, Scope and constraints | Only through amend flow | Agent/user/orchestrator |
| `plan/<featureId>.md` | Declarative feature definition | Only through plan flow | Agent/planner |
| `work/<featureId>/notes.md` | Optional narrative scratch | Yes | Agent/subagent |
| `state.json` | Kernel mission state and binding | Yes | pi-charter |
| `plan.json` | Computed macro DAG snapshot | Yes, generated | pi-charter |
| `feature-state.json` | Feature progress bitmap | Yes, generated | pi-charter |
| `criterion-state.json` | Criterion progress bitmap | Yes, generated | pi-charter |
| `events.jsonl` | Append-only charter events | Append-only | pi-charter |
| `evidence/*.json` | Append-only evidence records | Append-only | Agent/verifier/subagent |
| `handoffs/*.json` | Append-only delegated-work envelopes | Append-only | pi-charter/subagent |
| `result.json` | Terminal summary | Once at terminal state | pi-charter |

## `charter.md`

Recommended shape:

```md
# Charter: <short title>

## Objective

<one concise outcome>

## Criteria

### VAL-AREA-001 — <title>

Description: <observable assertion>
Verifier: command | hook | prompt | manual
Evidence required: true
Fresh evidence required: true | false
Review subagent required: true | false

## Scope and constraints

- <constraint or non-goal>
```

## `plan/<featureId>.md`

```md
---
id: f1-bootstrap
milestone: m1-bootstrap
order: 1
fulfills:
  - VAL-BOOT-001
preconditions: []
---

# Bootstrap workspace

Feature description and expected behaviour prose.
```

No runtime status in frontmatter.

## Evidence record

```json
{
  "id": "ev_...",
  "charterId": "...",
  "criterionId": "VAL-BOOT-001",
  "featureId": "f1-bootstrap",
  "recordedBy": "agent:root" ,
  "ts": "2026-05-15T02:33:04Z",
  "kind": "command",
  "verdict": "pass",
  "observation": {
    "command": "bun test",
    "exitCode": 0,
    "summary": "All tests passed"
  }
}
```

Writers may be the root agent, `charter-verifier`, or another delegated subagent. `criterion-state.json.latest` is the highest timestamp record regardless of writer, but `requireReviewSubagent` adds a predicate requiring a passing `recordedBy: subagent:charter-verifier` record.

## Lazy directories

`work/<featureId>/` is created only when notes, evidence, or handoff artifacts exist. A freshly planned charter has no `work/` directory.

## Binding reconciliation

Resolution order:

1. Explicit `charterId` argument.
2. Reverse binding at `~/.pi/agent/sessions/<sid>/charter.json`.
3. Exactly one active charter in the project.
4. Otherwise error with explicit choices.

Forward state wins if forward and reverse binding disagree.
