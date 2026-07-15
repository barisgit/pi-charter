# Architecture

## Boundary

pi-charter is a Pi extension for durable outcome contracts. The agent is the loop driver; the extension persists and projects the charter, observes file/tool boundaries, computes staleness, and enforces lifecycle legality. It does not plan implementation tasks, run verification commands, or dispatch an execution scheduler.

## Layers

1. **Authored contract** — `.charters/<id>/charter.md` contains Objective, optional References and Scope, and flat criteria. Each criterion has one canonical `Status:` line.
2. **Domain parser** — `src/domain/charter-file.ts` tolerantly parses known grammar and treats unknown structure as inert prose. Existing `Evidence:` lines are decoded only as a legacy input alias.
3. **Application services** — lifecycle operations, completion blockers, report scaffolding, source-change recording, staleness, and Ralph steering.
4. **Infrastructure** — atomic file writes, timestamp-sortable ids, state/event persistence, and legacy sidecar normalization.
5. **Projections** — terse tool status, compact widget, and `/charters` dashboard. These all consume the same criterion Status model.

## Runtime flow

At every relevant tool-result boundary, the runtime re-reads `charter.md`, diffs the parsed criteria against the previous snapshot, appends field changes to `events.jsonl`, updates sequence counters in `state.json`, and refreshes projections. Source modifications advance a global source sequence. A pass is stale when its Status sequence predates that source sequence.

## Deep boundaries

- `charter.md` owns durable why, what, boundaries, criterion semantics, and current criterion activity.
- `pi-dag-tasks` owns tactical execution steps and dependencies.
- `state.json` owns lifecycle/session/snapshot mechanics, never authored criterion truth.
- `events.jsonl` owns append-only history.
- `REPORT.md` curates already-recorded charter content and verification artifacts.

See ADR-0014 and ADR-0015.
