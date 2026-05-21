# m1-foundation Code Review

**Charter:** 523dd305-4b90-4e87-a151-c3ca81a5adbb  
**Milestone:** m1-foundation  
**Features:** f1-drop-auto-inject, f2-commands-section, f3-verifier-schema-extension  
**Criteria:** VAL-NO-AUTO-INJECT, VAL-COMMANDS-SECTION, VAL-VERIFIER-SUBAGENT, VAL-VERIFIER-EVIDENCE-EXISTS  
**Reviewed at:** 2026-05-22T00:00:00.000Z  
**Outcome:** PASS

---

## Spec reviewed

- `.pi/charters/523dd305-4b90-4e87-a151-c3ca81a5adbb/plan/f1-drop-auto-inject.md`
- `.pi/charters/523dd305-4b90-4e87-a151-c3ca81a5adbb/plan/f2-commands-section.md`
- `.pi/charters/523dd305-4b90-4e87-a151-c3ca81a5adbb/plan/f3-verifier-schema-extension.md`

## Diff inputs

`git diff HEAD~2` over:
- `src/application/plan-service.ts` (-149 lines)
- `src/domain/feature-md.ts` (-23 lines)
- `src/application/record-service.ts` (+340 lines)
- `src/infrastructure/feature-state.ts` (no changes — file lives at `src/persistence/feature-state.ts`)
- `src/domain/charter-md.ts` (+103 lines)
- `src/domain/verifier.ts` (+98 lines, new file)
- `src/application/subagent-bootstrap.ts` (+37 lines, new file)
- `src/application/status-service.ts` (no diff output; commands surface via `service.ts`)
- `tests/v22-no-auto-inject.test.ts` (+227 lines, new file)
- `tests/v22-commands-section.test.ts` (+101 lines, new file)
- `tests/v22-verifier-schema.test.ts` (+62 lines, new file)

## Prior evidence

- f1: `2026-05-21T21-59-50-147Z/evidence.json` — pass, subagent-recorded, all 4 named tests + full suite
- f2: `2026-05-21T21-59-43-025Z/evidence.json` — pass, command verifier
- f3: `2026-05-21T21-58-17-196Z/evidence.json` — pass, verifier, subagent + schema tests

---

## f1-drop-auto-inject (VAL-NO-AUTO-INJECT)

### Spec boundaries vs diff

| Spec requirement | Implemented |
|---|---|
| Remove synthesis in `lockPlan` | Yes — `synthesizeAutoInjectedFeatures` + `renderSyntheticFeatureMarkdown` fully removed (~142 lines) |
| Drop `review`/`targets`/`reviewSkipRationale` from `feature-md.ts` | Yes — `FeatureReviewPolicy` type removed, fields removed from `FeatureDefinition`, `reviewField()` and `optionalStringField()` removed |
| Drop milestone-readiness impl-only filter in `record-service.ts` | Yes — `feature.kind === "impl"` predicate replaced with no kind check, comment updated to match new semantics |
| Drop `auto-injected` flag from `feature-state.ts` schema | Yes — `normalizeFeatures` in `src/persistence/feature-state.ts` uses a structural whitelist that never copies unknown keys including `auto-injected` |
| Back-compat: legacy `auto-injected:true` tolerated | Yes — `loadFeatureState` → `normalizeFeatures` silently drops the field; test confirms |

**Note:** Spec references `src/infrastructure/feature-state.ts` but the actual path is `src/persistence/feature-state.ts`. The `git diff HEAD~2` on the wrong path produced empty output. The correct file was already clean; the normalizer implements the back-compat requirement correctly.

**Minor:** `digestFeatures` dropped `targets: [...feature.targets].sort()` without a comment. Type-check confirms this is safe (field no longer exists on `FeatureDefinition`), but a comment noting the removal would help future git blame readers.

### Tests

All 4 named tests pass:
- `lock_plan does not fabricate review or qa features`
- `feature-state row schema no longer carries auto-injected`
- `record-service milestone-readiness treats all features uniformly`
- `legacy auto-injected:true flag tolerated by reader`

---

## f2-commands-section (VAL-COMMANDS-SECTION)

### Spec boundaries vs diff

| Spec requirement | Implemented |
|---|---|
| `charter-md.ts` tolerant `## Commands` parser | Yes — `parseCommands()` added; absence returns `{}` with no warnings |
| Missing section tolerated | Yes — `sections.has("commands")` guard returns `{}` |
| Keys lowercased, last-write-wins + warning | Yes — `key.trim().toLowerCase()`; duplicate detected via `hasOwnProperty`; warning emitted before overwrite |
| Malformed lines produce warnings | Yes — non-matching regex, empty key, empty value each emit distinct warnings |
| `charter_status` surfaces commands | Yes — `service.ts:loadCharterCommands()` reads parsed commands; `CharterStatus.commands` field added; `registration.ts:formatCharterStatusText` renders `commands: key=val; ...` |
| Subagent bootstrap includes commands | Yes — `subagent-bootstrap.ts:renderSubagentBootstrapPrompt` appends `Commands:` block when non-empty |

**Minor:** `formatCommandsInline` uses `key=value` separator for the status surface, while the source format is `key: value`. This is consistent with the test expectation but worth documenting as a deliberate display choice.

**Minor:** Key lowercasing is a sensible design decision not explicitly stated in the spec. Authors writing `Build:` will get key `build`. This is compatible with the spec's intent.

### Tests

All 5 named tests pass:
- `Commands section parsed and surfaced`
- `charter without Commands section parses cleanly`
- `duplicate keys: last-write-wins with warning`
- `malformed Commands section: parser returns empty and emits warning`
- `subagent bootstrap includes commands in prompt`

---

## f3-verifier-schema-extension (VAL-VERIFIER-SUBAGENT, VAL-VERIFIER-EVIDENCE-EXISTS)

### Spec boundaries vs diff

| Spec requirement | Implemented |
|---|---|
| `verifier.ts` — new `subagent` kind `{ kind, agent, task }` | Yes — `SubagentVerifierSchema` via TypeBox with `additionalProperties: false` |
| `verifier.ts` — new `evidence-exists` kind `{ kind, evidenceKind, freshSince? }` | Yes — `EvidenceExistsVerifierSchema`; `evidenceKind` constrained to union literal |
| Discriminated union with `validateVerifier()` | Yes — `schemasByKind` dispatch map; kind-specific TypeBox `Check`; ISO8601 validation for `freshSince` |
| Unknown kind → clear error | Yes — `Unknown verifier kind: <value>` before dispatch |
| `subagent` missing `agent` → error at parse time | Yes — TypeBox Check fails; error message includes field path `/agent` |
| `charter-md.ts` parses `Verifier: subagent` + `Agent:`/`Task:` | Yes — `parseVerifier` switch case; `fields.get("agent")` / `fields.get("task")` |
| `charter-md.ts` parses `Verifier: evidence-exists` + `Kind:`/`FreshSince:` | Yes — `fields.get("kind")` → `evidenceKind`; `fields.get("freshsince")` → `freshSince` (normalized heading) |
| Template updated to document new kinds | Yes — `renderInitialCharterMarkdown` updated with `Agent:`/`Task:`/`Kind:`/`FreshSince:` comments |

**Scope observation:** `record-service.ts` also gained `verifySubagentCriterion` and `verifyEvidenceExistsCriterion` (~231 lines) which are the dispatch implementations specified by f4/f5. These are in scope for m1-foundation (same milestone) and are tightly coupled to the schema. No module boundary concern.

**Positive:** `isEvidenceKind` helper and `assertNever` guard in `record-service.ts` are correct defensive patterns — the `outcomeFromEvidenceFile` switch now exhausts all cases.

**Note on evidence-exists parser coverage:** The spec requires one parser test (`parser extracts Verifier: subagent block`). No parallel test for `evidence-exists` parsing from charter.md text exists. The implementation path is correct (mirrors subagent) and VAL-VERIFIER-EVIDENCE-EXISTS is met by schema tests. Non-blocking.

### Tests

All 5 named tests pass:
- `verifier schema accepts subagent kind with agent and task`
- `verifier schema accepts evidence-exists kind with evidenceKind`
- `verifier schema rejects subagent kind without agent field`
- `verifier schema rejects unknown kind`
- `parser extracts Verifier: subagent block from charter.md`

---

## Type-check and full suite

```
bun run check-types  → clean (0 errors)
bun test (14 named tests across 3 files) → 14 pass, 0 fail
```

---

## Blocking issues

None.

---

## Non-blocking notes

1. `src/application/plan-service.ts` line ~721: `digestFeatures` removed `targets:` field silently; a one-line comment noting the removal would help future readers.
2. `src/domain/charter-md.ts` line 64: keys are lowercased, which is sensible but undocumented in the spec. Worth noting in code comments.
3. `src/application/subagent-bootstrap.ts` line 14: `formatCommandsInline` uses `=` separator vs source `:` separator — deliberate display normalization, worth a comment.
4. No `evidence-exists` parser smoke test from charter.md text (spec only requires subagent parser test). Implementation is correct by inspection; consider adding later for symmetry.
5. Spec for f1 references `src/infrastructure/feature-state.ts` (wrong path); actual file is at `src/persistence/feature-state.ts`. Pre-existing stale path in spec doc — no code impact.

---

## Surprises / Worth noting

- `record-service.ts` absorbed f4/f5 dispatch implementations alongside f3 schema. This is acceptable (same milestone, tightly coupled) but means the file grew by ~340 lines in a single diff. Worth monitoring for further growth pressure.
- `src/infrastructure/feature-state.ts` appeared in the diff target list but does not exist; the actual persistence layer is at `src/persistence/`. The feature-state change (dropping `auto-injected`) was already present in the structural normalizer before this diff window.
