# Domain Layer Codemap

Source: `src/domain/` — pure TypeScript, no I/O, no external dependencies except shared `types.ts`.

---

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Shared type definitions and algebraic data types for the entire domain. |
| `charter-md.ts` | Parse and render `charter.md` (authoring template + H2/H3 parser). |
| `feature-md.ts` | Parse feature plan markdown (YAML frontmatter extractor). |
| `trust-rank.ts` | Evidence trustworthiness ranking consumed by the completion gate. |

---

## Design Patterns

### Algebraic data types (ADTs) via TypeScript discriminated unions

`types.ts` defines several strict unions used throughout the service layer:

- `CharterStatus` — 8-state lifecycle FSM: `planning | active | review | paused | completed | budget_limited | abandoned`.
- `VerifierKind` — 4-enum closed set: `command | hook | prompt | manual`.
- `RecordedBy` — template-literal tagged union: `` `agent:root` | `subagent:${string}:${string}` | `user` ``.
- `EvidenceSource` — 4-enum set parallel to `RecordedBy` but scoped to evidence provenance.
- `ParseWarningReason` — 2-variant warning discriminant: `missing-verifier | missing-because`.

The `CharterCriterion.requireReviewSubagent` field is intentionally **tri-state** (`boolean | undefined`) to distinguish three author intents: explicitly `true`, explicitly `false`, and completely omitted. The completion gate uses the omitted state to auto-default to `true` when a `milestone_ready_for_review` event fires.

### Two-pass section parser

`charter-md.ts` uses a **streaming line-buffer split** pattern:
1. First pass (`splitH2Sections`) accumulates lines into a `Map<sectionName, rawContent>`. Section boundaries are detected by `^##\s+(.+?)\s*$` regex; headings are normalized (`toLowerCase`, whitespace collapsed) for case-insensitive key lookup.
2. Second pass (`parseCriteria`) re-splits each section by H3 headings (`^###\s+(.+?)\s*$`), buffering body lines until the next heading flushes.

This avoids full DOM/AST parsing; the markdown is treated as a line-oriented structured format, not rich prose.

### Field-value map pattern

Both `charter-md.ts` and `feature-md.ts` use a `Map<string, string | string[]>` intermediate representation after regex-parsing field-value lines. This decouples the raw input format from the final typed object and makes field normalization reusable.

### Trust ranking as pure function

`trust-rank.ts` exports a single pure function `trustRank(input: TrustRankInput): number`. No side effects, no I/O. The ranking is consumed by the completion gate to enforce identity-disjoint review: higher rank = more trustworthy evidence, less human review required.

---

## Data / Control Flow

### Charter markdown lifecycle

```
author (LLM or human)
  │
  ▼
renderInitialCharterMarkdown(objective) → string (template charter.md)
  │
  ▼
user edits charter.md
  │
  ▼
parseCharterMarkdown(markdown) → ParsedCharterMarkdown
  │
  ├── { objective: string }
  ├── { constraints: string[] }      ← bullet-list extractor
  ├── { criteria: CharterCriterion[] } ← H3 heading parser + field-value map
  └── { warnings: ParseWarning[] }  ← advisory: missing-verifier, missing-because
```

### Feature markdown lifecycle

```
plan author (LLM)
  │
  ▼
charter_plan action=add_feature → YAML-frontmatter markdown written to .pi/charters/<id>/plan/<featureId>.md
  │
  ▼
parseFeatureMarkdown(markdown) → FeatureDefinition
  │
  ├── { id, milestone, order, fulfills: string[], preconditions: string[], body }
  └── used by service layer to build plan DAG
```

### Evidence / completion gate flow

```
EvidenceRecord created (manual, verifier, hook, or subagent source)
  │
  ▼
trustRank({ recordedBy, source, hasBecause }) → 0 | 1 | 2 | 3
  │
  ▼
completion gate reads criterion.requireReviewSubagent + trustRank + RecordedBy
  └── enforces identity-disjoint review: subagent record must come from a different RecordedBy than charter author
```

---

## Integration Points

### Consumed by service layer (`src/service/`)
- `parseCharterMarkdown` — called at charter creation and lock time to populate `CharterState`.
- `parseFeatureMarkdown` — called when loading feature plan entries.
- `trustRank` — called by the completion gate logic.
- All exported types from `types.ts` — used as method signatures in service.

### Consumed by tools (`src/tools/`)
- `charter_manage`, `charter_plan`, `charter_record` use `ParsedCharterMarkdown`, `CharterCriterion`, `EvidenceRecord` as request/response shapes.
- `charter_plan` `add_feature` internally produces markdown that `parseFeatureMarkdown` must round-trip.

### Consumed by evaluator (`src/evaluator/`)
- Reads `CharterState`, `CharterCriterion`, and `EvidenceRecord` to compute criterion bitmap and completion readiness.

### Consumed by the status widget
- `CharterStatus` union displayed in the widget header.

### Tri-state `requireReviewSubagent` propagation

```
charter.md:  Review subagent required: <true|false|omitted>
  │
  ▼
parseCriterion() → CharterCriterion.requireReviewSubagent: boolean | undefined
  │
  ▼
effectiveRequireReviewSubagent (service.ts) handles the auto-default:
  - if criterion.requireReviewSubagent === true  → require subagent
  - if criterion.requireReviewSubagent === false → opt-out explicit
  - if criterion.requireReviewSubagent === undefined AND milestone_ready_for_review event fired
      → auto-default to true
```

### Warning taxonomy

`ParseWarning` is advisory only; the service layer decides whether to **block** or **warn** based on the `reason` discriminant:
- `missing-verifier` — always emitted, severity decided by caller.
- `missing-because` — emitted only when `verifier === "manual"` and no `because` field. Used by `lock_plan` to block weak-verifier charters unless `legacy: true` is set.

---

## Key Type Relationships

```
CharterState
  ├── status: CharterStatus
  ├── budget?: Budget
  └── charterDigest?, planDigest? (content-addressed idempotency)

CharterCriterion
  ├── verifier: VerifierKind
  ├── requireReviewSubagent: boolean | undefined  ← tri-state
  ├── because?: string                            ← author-time rationale
  └── command?: string                            ← shell command for VerifierKind="command"

EvidenceRecord
  ├── source: EvidenceSource                      ← manual|verifier|hook|subagent
  ├── recordedBy: RecordedBy                     ← agent:root|subagent:…|user
  ├── because?: string                            ← per-evidence rationale (required for manual)
  ├── outcome: "pass" | "fail" | "partial"
  └── artifacts: string[]                         ← output paths, URLs, etc.

TrustRankInput → trustRank() → number
  source=subagent     → 3
  source=verifier|hook → 2
  source=manual+because → 1
  source=manual         → 0
```

---

## Parsing Invariants

1. `charter-md.ts` ignores bullet lists entirely. Only `### VAL-*` H3 headings are parsed as criteria. This was a deliberate design decision to force structured authoring and prevent ambiguity.
2. `charter-md.ts` normalizes section headings case-insensitively and collapses internal whitespace, so `## Objective`, `## objective`, `##  Objective  ` all resolve to `"objective"`.
3. `feature-md.ts` requires YAML frontmatter (`---` delimiters) at the top of every feature markdown file. Throws if absent.
4. `parseOptionalBoolean` returns `undefined` for empty strings and unrecognized values, distinguishing "author wrote nothing" from "author wrote `false`".
5. The `parseCharterMarkdown` `legacy` option is a **marker only**: the parser always emits the same warning set; the caller (`lock_plan`) reads the flag to decide whether `missing-because` on a manual verifier is a block or a warning.
