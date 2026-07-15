# src/

## Responsibility

Implements the Pi extension runtime and enforces the boundary between pure charter concepts, lifecycle orchestration, filesystem/host adapters, and terminal presentation.

## Design Patterns

- **Composition root:** `index.ts` is a thin entry point that registers all extension capabilities.
- **Layered dependencies:** application and UI consume domain contracts; application and UI call infrastructure adapters; domain code remains independent of Pi APIs.
- **Explicit projections:** application services return `CharterStatusResult`; UI reducers convert that result into picker snapshots and widget view models.

## Data and Control Flow

1. Pi invokes the default export in `index.ts` with an `ExtensionAPI`.
2. Registration functions install the tool and its compact call/result renderer, commands, host lifecycle listeners, shared event-bus listeners, widget, and custom Ralph renderer.
3. Inputs flow through `application/` services to `domain/` parsing/rules and `infrastructure/` persistence.
4. Status results flow into `ui/` snapshot builders and pure view-model reducers before terminal rendering.
5. `index.ts` also re-exports `CharterToolError`, package version access, charter-file parsing APIs, and identifier helpers for consumers and tests.

## Integration Points

- Entry point declared by `package.json`: `src/index.ts`.
- Pi host contracts enter only through `index.ts`, `application/registration.ts`, selected UI host adapters, and infrastructure logging.
- Runtime project storage is `.charters/<id>/`; no source module reads legacy `.pi/charters/` data.

## Directory Map

| Directory | Responsibility | Detailed Map |
| --- | --- | --- |
| `application/` | Coordinates lifecycle actions, snapshot freshness, hooks, Pi registrations, and Ralph behavior. | [`application/codemap.md`](application/codemap.md) |
| `domain/` | Defines the charter file model, IDs, templates, lifecycle types, and pure parsing rules. | [`domain/codemap.md`](domain/codemap.md) |
| `infrastructure/` | Implements durable storage, atomic writes, logging, and external event-name bridges. | [`infrastructure/codemap.md`](infrastructure/codemap.md) |
| `ui/` | Builds and renders dashboard and widget projections from charter status. | [`ui/codemap.md`](ui/codemap.md) |
