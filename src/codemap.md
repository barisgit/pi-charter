# src/

## Responsibility

Implements the Pi extension runtime and keeps pure charter concepts, lifecycle orchestration, filesystem/host adapters, and terminal presentation separate.

## Design patterns

- **Composition root:** `index.ts` registers extension capabilities and re-exports public contracts.
- **Layered dependencies:** application and UI consume domain contracts and infrastructure adapters; domain code has no Pi host dependency.
- **Explicit projections:** application services return the exact `CharterStatusResult`; UI reducers turn it into picker and widget view models.

## Data and control flow

1. Pi invokes the default export in `index.ts`.
2. Registration installs the one tool, slash commands, `registerCharterFileHooks()`, Ralph loop and renderer, widget, and dashboard.
3. Inputs flow through application services to Objective/Phase domain parsing and infrastructure persistence.
4. Whole-file changes flow through `application/snapshots.ts`; Ralph guard transitions flow through `application/ralph.ts` under the shared mutation lock.
5. Status results flow into UI snapshot builders and pure view-model reducers.
6. `index.ts` re-exports public lifecycle, Phase/parser, identifier, error, and version contracts.

## Integration points

- Entry point: `src/index.ts`.
- Pi host contracts enter through `index.ts`, `application/registration.ts`, selected UI host adapters, and infrastructure logging.
- Runtime storage is `.charters/<id>/`; legacy `file-interface` state under that root is display-only. No source module reads old `.pi/charters/` data.

## Directory map

| Directory | Responsibility | Detailed map |
|---|---|---|
| `application/` | Lifecycle, whole-file snapshots, hooks, registrations, Ralph, and guard behavior. | [`application/codemap.md`](application/codemap.md) |
| `domain/` | Objective/Phase file model, ids, templates, lifecycle and guard types, parsing. | [`domain/codemap.md`](domain/codemap.md) |
| `infrastructure/` | Durable storage, locks, atomic writes, logging, event-name bridges. | [`infrastructure/codemap.md`](infrastructure/codemap.md) |
| `ui/` | Dashboard and widget projections. | [`ui/codemap.md`](ui/codemap.md) |
