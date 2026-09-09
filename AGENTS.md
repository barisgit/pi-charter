# AGENTS.md — pi-charter

Reference for coding agents working in this repository.

## Project stance

`pi-charter` is a successor concept, not a cosmetic rename of `pi-goals` v1. ADR-0016 defines the current Objective/Phases model and supersedes the criterion surface in ADR-0014 and ADR-0015. Treat earlier ADRs and v1 as history where they conflict.

## Read order

1. `CONTEXT.md` — canonical domain language.
2. `docs/adr/0016-objective-and-emergent-phases.md` — current cross-cutting decision.
3. `docs/implementation/` — implementation contracts.
4. Earlier ADRs — decision history and surviving constraints.
5. `docs/research/` and `docs/reference/v1-pi-goals/` — historical design and plumbing patterns only.

## Invariants

- `charter.md` is the single authored file: substantial `# Objective`, optional `## References` and `## Scope`, and `## Phases` containing ordered Markdown items.
- Every new charter starts with exact `1. Explore phases`. If no phase is explicitly `current`, the initial bare phase or first unfinished unmarked phase is `current` by inference; other unmarked phases are `upcoming`. Explicit suffixes are `— upcoming`, `— current`, or `— done`. Indented Markdown is the phase body.
- A Phase is `{ number, title, status, body }`. It is progress narrative, not a criterion, task, dependency, evidence schema, freshness unit, or completion gate. There is no phase-count quota.
- One LLM tool remains: `charter({ action, id?, objective?, note? })` with `create | list | status | pause | resume | complete | abandon`. Every return carries legal `nextActions[]`.
- Lifecycle remains `active | paused | completed | abandoned`. A new charter can complete with zero phases.
- New state uses `schemaVersion: "phases"`, lifecycle/session fields, optional whole-file `snapshotHash`, and optional Ralph guard state. Do not restore criterion snapshots or global source/tool sequences.
- `schemaVersion: "file-interface"` charters are dashboard-visible, read-only history. Never mutate, resume, or migrate them. Continued work starts in a new charter.
- Completion is worker judgment after auditing the Objective and external references. It needs a concise note, a curated `REPORT.md`, and approval from `charter:before_complete`; it does not require phases done, fresh passes, artifact counts, or a deliberately failed first call. Preserve an already curated report.
- pi-charter records evidence and never runs verification. The worker drives the real system. Capture screenshots or recordings at verification time, link useful files in phase bodies, and curate them into REPORT.md.
- The agent is the loop driver. Do not add an auto worker scheduler or another evaluator.
- Ralph's shared guard semantics are exact: the fifth actual send in a rolling 15 minutes is recovery; the next eligible activation at or before the 5-minute warning boundary pauses before send; quiet expiry does not pause; compaction and edits do not reset; only explicit user `/charter resume` clears a guard pause and history; tool resume cannot bypass; unrelated jobs continue.
- Charter ids remain `<YYYYMMDD-HHMMSS>-<slug>` under `.charters/`. Sidecars remain `state.json`, `events.jsonl`, `work/`, and `REPORT.md`.
- Tactical turn-to-turn todos stay in pi-dag-tasks.
- No `contractPath`, `--charter-spec`, spec auto-detect, budgets, question/planning states, artifact gates, or OpenSpec framework.

## Implementation guidance

- Before runtime edits, inspect ADR-0016, the matching implementation spec, and v1 only for proven extension plumbing.
- Keep the parser tolerant: unknown Markdown is inert and malformed known grammar produces warnings rather than blocking work.
- The Objective may gain only user-authorized constraints, verification detail, and report requirements. Never change or narrow user intent.
- Use Pi extension APIs from `docs/reference/pi-docs/extensions.md` and live installed docs if needed.
- Make changes through failing behavior tests and small vertical slices. Preserve unrelated shared-tree work.

## Verification

Run the narrowest behavior tests while iterating. Before handoff, the project minimum remains:

```bash
bun run check-types
bun test
```

Do not claim known baseline failures passed without checking them.
