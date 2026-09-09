# Objective and emergent phases

Status: accepted; supersedes ADR-0014 and ADR-0015; amends ADR-0009, ADR-0012, and ADR-0013

## Context

The criterion model made agents maintain a second specification beside the user's request. Global source-change staleness then invalidated unrelated verification and pulled the loop toward repeated fresh-pass sweeps. The result displaced work on the objective with bookkeeping.

The redesign keeps the useful parts of pi-charter: a durable objective, a small lifecycle, idle continuation, verification artifacts, and a report. It removes runtime judgment that pretends progress can be proved from criterion state.

A one-off backend outage is not part of this decision. The problem is false invalidation and the stale-first loop it caused.

## Decision

### The Objective is the completion contract

`charter.md` starts with `# Objective`. Its body carries the full authorized outcome: why the work matters, constraints, verification expectations, and report requirements. The agent may expand an objective only with constraints, verification detail, and reporting detail the user has authorized. It must not change, narrow, or reinterpret user intent.

`## References` and `## Scope` are optional. References identify durable sources of authority and their roles. Scope clarifies boundaries without replacing the Objective.

### Phases emerge from the work

A new charter starts with one phase:

```md
## Phases

1. Explore phases
```

Phases are lightweight progress notes, not acceptance criteria, tasks, milestones, or gates. The agent edits the ordered Markdown list as the work becomes understood. There is no required phase count, dependency graph, per-phase evidence schema, freshness rule, or completion gate.

The parsed model is:

```ts
type PhaseStatus = "upcoming" | "current" | "done";

type Phase = {
  number: number;
  title: string;
  status: PhaseStatus;
  body: string;
};

type ParsedCharterFile = {
  objective: string;
  references: string;
  scope: string;
  phases: Phase[];
  warnings: string[];
};
```

The grammar accepts ordered Markdown items under `## Phases` with an optional exact suffix: `— upcoming`, `— current`, or `— done`. Indented Markdown belongs to that phase's body. If no phase is explicitly `current`, the initial bare phase or first unfinished unmarked phase is `current` by inference; other unmarked phases are `upcoming`. The initial bare `1. Explore phases` is therefore current.

### Lifecycle and tool stay small

The lifecycle remains `active | paused | completed | abandoned`. The tool remains:

```ts
charter({ action, id?, objective?, note? })
```

with `create | list | status | pause | resume | complete | abandon`. A new charter may complete with zero phases. Completion is the worker's judgment that the Objective has been met, accompanied by a concise completion note, a curated `REPORT.md`, and approval from the existing `charter:before_complete` hook. The runtime does not require phase completion, fresh passes, evidence counts, or a deliberately failed scaffold call. If `REPORT.md` already contains curated work, completion preserves it.

The worker audits the Objective and external references before completing. pi-charter records and projects that judgment; it does not run checks, schedule workers, or add another evaluator.

### State and old charters

New state uses `schemaVersion: "phases"` and keeps lifecycle, timestamps, session binding, and an optional whole-file `snapshotHash` for change journaling. Criterion snapshots and global source/tool sequences are removed.

Existing `schemaVersion: "file-interface"` charters remain visible in the dashboard as read-only history. They cannot be mutated or resumed. There is no migration. All new work starts in a new phases charter.

The status projection keeps the common fields `charterId`, `status`, `objective`, `references`, `scope`, `createdAt`, `warnings`, `reportExists`, and `nextActions`, and adds:

```ts
phases: Phase[];
phaseCounts: Record<PhaseStatus, number>;
legacy: boolean;
charterMarkdown: string;
ralph?: {
  activations: number[];
  warnedAt?: number;
  pausedByGuard?: boolean;
};
```

It removes criterion projections, status counts, ready-next advice, open-ended inference, blockers, and staleness.

### Ralph remains agent-driven, with a loop guard

Ralph continues only when the root agent and async subagents are idle. It does not auto-spawn work.

The guard uses one shared rolling-history rule:

- On the fifth actual Ralph send within a rolling 15-minute window, replace the normal message with a recovery prompt.
- If the next eligible activation occurs at or before the five-minute warning boundary, pause before sending it.
- Quiet expiry never causes a timed pause; retain rolling activation history and evaluate it only when another activation becomes eligible.
- Compaction and file edits do not reset the guard.
- After a guard pause, only an explicit user `/charter resume` clears the warning and activation history. A tool `resume` cannot bypass the guard.
- Guard handling must not kill unrelated jobs.

This is the only case where runtime code may pause a charter without an agent lifecycle call.

### Evidence and the report

Visual evidence is a core product value. When verifying user-visible behavior, capture screenshots or recordings at verification time, link them in the relevant phase body, and curate the useful artifacts into `REPORT.md`. Do not manufacture screenshots at the end, and do not add an artifact count gate.

Canonical example:

```md
# Objective

Ship the approved account recovery flow without changing login behavior. Verify the real browser flow at desktop and mobile widths, and deliver a reviewable report with the captured UI evidence.

## References

- [Recovery specification](../../docs/recovery.md) — behavior authority

## Scope

Password recovery UI and API integration only. Login and registration are unchanged.

## Phases

1. Explore phases — done
   Confirmed the approved flow and existing login boundaries.
2. Implement — done
   Added the recovery form and token exchange.
3. Verify — current
   - Desktop result: [screenshot](work/recovery-desktop.png)
   - Mobile flow: [recording](work/recovery-mobile.mp4)
```

## Consequences

The Objective now bears more authoring weight, but it preserves the user's actual completion contract instead of translating it into a runtime-owned checklist. Phases communicate approach and progress without pretending to prove completion.

The runtime becomes less prescriptive. Worker judgment and the final report carry completion quality. Reviewers can inspect the Objective, phase narrative, linked artifacts, and completion note directly.

Research archives and the v1 reference remain historical and are not rewritten.

## Supersession summary

- ADR-0014's one file, one tool, timestamp-slug ids, `.charters/` location, and no scheduler remain. Its Criterion grammar, snapshot sequencing, staleness, open-ended completion rule, and mandatory first failed completion attempt are superseded.
- ADR-0015's unified Criterion Status model and criterion projection are superseded.
- ADR-0013 still governs the runtime boundary: charter records evidence and does not run verification. Its fresh-evidence gate is superseded.
- ADR-0012's four lifecycle states and worker-owned execution remain. Its modeled decomposition and criterion sidecars are superseded.
- ADR-0009's no-extra-evaluator decision remains. Its claim that only the agent may pause is amended by the Ralph loop guard.
