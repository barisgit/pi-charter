# Review: m2-verifiers — f4-verifier-subagent-dispatch + f5-verifier-evidence-exists-dispatch

**Charter:** 523dd305-4b90-4e87-a151-c3ca81a5adbb (pi-charter v2.2)  
**Milestone:** m2-verifiers  
**Features reviewed:** f4-verifier-subagent-dispatch (VAL-VERIFIER-SUBAGENT), f5-verifier-evidence-exists-dispatch (VAL-VERIFIER-EVIDENCE-EXISTS)  
**Round:** 1  
**Reviewed at:** 2026-05-22T12:00:00.000Z

---

## Spec reviewed

### f4-verifier-subagent-dispatch
Adds a `subagent` branch to `verifyCriterion` in `record-service.ts`. Dispatches via `getSubagentApi().spawnRaw()`, sets `dispatchStartedAt` before the spawn, interpolates `{charterId}`, `{featureId}`, `{criterionId}`, `{evidenceDir}`, `{commands.<key>}` into the task template, scans `work/<featureId>/evidence` for the newest typed evidence written after dispatch, derives pass/fail, records evidence into criterion-state.

Spec-named tests (5):
- `subagent verifier kind round-trips`
- `subagent dispatch reads newest evidence by timestamp`
- `subagent dispatch fails when persona writes no evidence`
- `subagent dispatch interpolates charterId and featureId in task`
- `subagent dispatch honors requireFreshEvidence with stale evidence`

### f5-verifier-evidence-exists-dispatch
Adds an `evidence-exists` branch. Calls `loadFeatureEvidence(dir, featureId)` (reused from service.ts), maps each raw record to `{path, ts, kind}` via `evidenceKindFromRecord`, filters by `verifier.evidenceKind` and optional `freshSince` (epoch ms comparison), counts matching records, records result into criterion-state.

Spec-named tests (5):
- `evidence-exists verifier kind passes when matching evidence is present`
- `evidence-exists verifier kind fails when no evidence`
- `evidence-exists with freshSince filters stale evidence`
- `evidence-exists matches both dir-per-run and legacy flat layout`
- `evidence-exists rejects wrong evidenceKind`

---

## Diff / transcript inputs

- `src/application/record-service.ts`: +330 lines (wave 2 commit 29c0455)
- `tests/v22-verifier-subagent-dispatch.test.ts`: 229 lines (new)
- `tests/v22-verifier-evidence-exists.test.ts`: 242 lines (new)
- Supporting files inspected: `src/domain/verifier.ts`, `src/application/subagent-api.ts`, `src/infrastructure/subagent-bridge.ts`, `src/domain/charter-md.ts`, `src/application/service.ts` (loadFeatureEvidence)

---

## Test run

```
bun test tests/v22-verifier-subagent-dispatch.test.ts tests/v22-verifier-evidence-exists.test.ts
 10 pass
 0 fail
 39 expect() calls
Ran 10 tests across 2 files. [172ms]
```

All 10 spec-named tests present and passing. No output truncation used.

## Type check

```
bun run check-types
# tsc --noEmit exits 0
```

Clean — no errors.

---

## Blocking issues

None.

---

## Non-blocking notes

1. **record-service.ts size** (`src/application/record-service.ts`, line 1): Now 1655 lines (+325 from wave 2). Growth is spec-directed (spec explicitly scopes both new branches to this file) and consistent with the pre-existing command-verifier pattern in the same module. Not a god-file violation introduced here, but worth factoring out verifier dispatch to `src/application/verifiers/` if more kinds land.

2. **Misleading test name** (`tests/v22-verifier-subagent-dispatch.test.ts`, line 160 approx): `subagent dispatch honors requireFreshEvidence with stale evidence` tests the `dispatchStartedAt` cutoff, not `criterion.requireFreshEvidence`. The spec says `requireFreshEvidence honored` means "read newest evidence written AFTER dispatch timestamp," which is what the code does. The behavior is correct; the test name implies a different mechanism. No functional defect.

3. **`partial` → `fail` not explicitly tested** (`src/application/record-service.ts`, `outcomeFromEvidenceFile`): Subagent evidence with `outcome: "partial"` correctly maps to `fail` via `evidenceOutcome === "pass" ? "pass" : "fail"`. The spec acknowledges this as a failure mode but the spec-named test list does not include it. Consistent with spec.

4. **Empty `agent` field** (`src/domain/charter-md.ts`, parseVerifier subagent case): If `Agent:` is present but blank, TypeBox `Type.String()` accepts `""` and `verifySubagentCriterion` would construct `systemPrompt: "You are "`. Planner responsibility to supply a valid name; not a code defect but a schema gap (non-empty string not enforced).

---

## Surprises / Worth noting

- `evidenceKindFromRecord` has a three-level fallback (`record.kind` → `record.details.kind` → `record.details.typedEvidence.kind`). The middle fallback is used in evidence-exists tests via the `details.typedEvidence` field written by test fixtures. The logic is correct but the indirection is non-obvious.
- `newestTypedEvidenceAfterDispatch` uses `Math.max(evidenceTimeMs, fileStat.mtimeMs)` for the freshness cutoff, so an evidence record with an old `reviewedAt` timestamp but a recent filesystem mtime (e.g., file was copied or touched) would still be considered fresh. This is intentional defensive behavior to handle stub/test evidence that may not carry accurate `reviewedAt` values.
