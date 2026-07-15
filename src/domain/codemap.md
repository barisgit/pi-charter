# src/domain/

## Responsibility

Defines the charter's framework-independent language and pure rules: the tolerated `charter.md` grammar, criterion readiness, timestamped IDs, creation scaffold, lifecycle state, criterion snapshots, events, and legal-action descriptors.

## Design Patterns

- **File-as-interface parser:** `charter-file.ts` recognizes Objective, optional References/Scope, Criteria, `### C<n>.` headings, advisory `Depends:`, and a single `Status:` line while treating unknown prose as inert and reporting warnings rather than throwing.
- **Pure domain functions:** parsing, readiness, slugging, timestamp formatting, path checks, and template rendering are deterministic apart from explicitly supplied time/filesystem inputs.
- **Value-object types:** `types.ts` centralizes lifecycle unions and serialized `CharterState`, `CriterionSnapshot`, `CharterEvent`, and `NextAction` shapes.
- **Collision-safe identifier factory:** `ids.ts` creates `<YYYYMMDD-HHMMSS>-<slug>` IDs and adds numeric suffixes when needed.

## Data and Control Flow

1. `renderCharterTemplate()` converts an objective into the initial commented teaching scaffold with zero live criteria.
2. `parseCharterFile()` strips HTML comments, extracts authored sections and criteria, normalizes current or legacy evidence status syntax, and returns warnings/open-ended state without blocking work.
3. Infrastructure snapshots parsed criteria into state; application status combines that snapshot with lifecycle and journal data.
4. `readyCriteria()` selects non-pass criteria whose known dependencies are passed; dependencies remain advisory rather than transition gates.
5. ID input flows through objective slugging and UTC timestamp formatting for creation, while lookup accepts exact IDs, unique prefixes, or unique slug fragments.

## Integration Points

- Consumed by `src/application/service.ts` and `src/application/staleness.ts` for lifecycle validation, readiness, and freshness.
- Consumed by `src/infrastructure/store.ts` for scaffold creation, parsing, normalization, and serialized state/event contracts.
- Charter/UI status types are consumed throughout `src/ui/`.
- `ids.ts` uses Node filesystem/path APIs only for directory lookup and path construction; the parser, template, and shared types have no Pi host dependency.
