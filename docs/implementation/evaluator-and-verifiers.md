# Verifiers and hooks

## Separation of concerns

- **Verifier** decides whether a criterion has passing evidence.
- **Hooks** decide whether high-risk state transitions may proceed.
- **Ralph** only reprompts the agent from current `charter_status`; it does not judge completion.

Do not collapse these roles.

## Verifier kinds

Prefer deterministic checks before LLM judges:

1. `command` — command exits 0 and output/observation is recorded.
2. `hook` — another extension or project hook returns pass/fail.
3. `prompt` — LLM judge evaluates a criterion against evidence.
4. `manual` — user-attested; weakest and should be explicit.

## Evidence freshness

`requireFreshEvidence` blocks completion when the latest passing evidence predates a relevant charter/criterion change. Implementation can start with a simple timestamp rule:

```text
latestPassingEvidence.ts > criterion.lastModifiedAt
```

If criterion-level timestamps are not implemented yet, use `charterDigestUpdatedAt` as the conservative boundary.

## Review subagent requirement

`requireReviewSubagent` blocks completion until a passing evidence record exists with:

```json
{
  "recordedBy": "subagent:charter-verifier"
}
```

The implementing agent's own evidence can still be useful, but it cannot satisfy the independent-review predicate.

## charter-verifier behavior

The verifier should not blindly rerun everything. It should inspect state and run only criteria where:

- latest evidence is missing;
- latest evidence failed;
- latest evidence predates source or charter changes;
- `requireReviewSubagent` is true and no verifier-authored pass exists;
- the user explicitly requested a fresh review.

## Legacy migration

Pre-m1 charters often lack an explicit `Verifier:` line on every VAL. To keep
those charters loadable while still enforcing the gate, `parseCharterMarkdown`
emits a `missing-verifier` `ParseWarning` per affected criterion instead of
throwing, and `lockPlan` accepts a `legacy: true` option that downgrades the
BLOCK to a deferred completion-time reject:

- `lockPlan({ legacy: false })` (default): missing-`Verifier:` or weak
  `manual`+no-`Because:` BLOCKs at plan-lock time.
- `lockPlan({ legacy: true })`: lockPlan passes; the BLOCK is deferred to
  `charter_manage action=complete`, where `completeCharter` rejects with the
  per-VAL trust-gate reasons described above.

This lets in-flight legacy charters keep running while forcing authors to
upgrade evidence before they can complete.

## Recommended first cut

1. Implement deterministic command verifiers and manual records first.
2. Stub prompt verifiers behind a clear interface.
3. Keep continuation in `charter_status nextActions[]` and deterministic Ralph.
