# Review: f11-planner-critic-rewrite

Charter: a252b21d-9451-4dda-af1d-f7b02bd22b7f  
Feature: f11-planner-critic-rewrite  
Criterion: VAL-PLANNER-CRITIC-REWRITE  
Milestone: m3-personas  
Date: 2026-05-21  
Outcome: **FAIL**

---

## Mandate assessment

### (a) Critic prompt teaches depth-grading rubric (≥1 happy + ≥1 edge)

**PASS.** `agents/charter-planner-critic.md` lines 113–133 contain the full `### Depth-grading rubric per feature` section: list claimed behaviors, count happy checks, count edge checks, list uncovered behaviors, grade depth as none/shallow/adequate/strong. The `≥1 happy + ≥1 edge per feature` requirement is stated verbatim. Zero-edge-check and zero-happy-check both map to `BLOCK validation-underspecified`. Tests `critic flags feature with zero edge checks` and `critic mandates ≥1 happy + ≥1 edge per feature` grep for all required strings and pass.

### (b) validation-underspecified verdict shape documented

**PASS.** Shape `{kind:'validation-underspecified', featureId, missing:['edge'|'happy'|'depth']}` documented at agent lines 124–125 and repeated in the report template at line 169. The `validation-underspecified:` list header in the output section is present. Test `critic returns validation-underspecified verdict shape` greps for both and passes.

### (c) Verifier-robustness rule documented with grandfather clause for pre-f10 plans

**PASS.** Agent lines 80–93 contain the full rule:
- `[BLOCK] verifier-not-robust` for post-f10 plans (schemaVersion >= 2.2)
- `Grandfather clause:` explicit header
- `schemaVersion < 2.2` or absent helper triggers ADVISORY
- `[ADVISORY] verifier-not-robust` with statement it is grandfathered for future migration

Tests `critic grandfathers pre-f10 plans on verifier-robustness` and `critic flags bare bun test -t verifier in v2.2+ plan` grep for all required strings and pass.

### (d) Touch-overlap detection documented

**PARTIAL — test coverage missing (BLOCK).** `agents/charter-planner-critic.md` lines 146–151 have the full `### Touch-overlap detection` section. The description frontmatter (line 3) also lists `touch overlap` as a flagged category. However, `tests/v21-planner-critic-rewrite.test.ts` contains zero tests that grep for any touch-overlap keyword. The spec review checklist requires tests to grep for each mandate keyword; this rule has no test verification.

### (e) review skip-list audit documented

**PARTIAL — test coverage missing (BLOCK).** `agents/charter-planner-critic.md` lines 154–157 have the `### review:skip audit` section. The description frontmatter lists `review-skip issues`. However, `tests/v21-planner-critic-rewrite.test.ts` contains zero tests that grep for any review-skip keyword. Same gap as (d).

---

## Blocking findings

### B1: All 6 spec-named test checks have 0-match test names
`tests/v21-planner-critic-rewrite.test.ts`

The feature plan's `### Happy` and `### Edge` validation sections specify 6 checks by name, each with a `bun test -t '<phrase>'` verifier command. Every one of those 6 phrases matches 0 tests in the file:

| Spec check id | Required test name | Found? |
|---|---|---|
| critic-returns-verdict-on-shallow-plan | `critic flags shallow plan with validation-underspecified entry` | No |
| critic-flags-bun-test-without-helper | `critic flags bun test -t without charter-named-test.sh wrapper for post-f10 plans` | No |
| critic-flags-unverifier-backed-verification-prose | `critic flags Verification prose not backed by VAL` | No |
| critic-passes-well-specified-plan | `critic passes well-specified plan with no validation-underspecified` | No |
| critic-flags-feature-with-zero-edge-checks | `critic flags feature with zero edge checks as validation-underspecified` | No |
| critic-grandfathers-pre-f10-plans | `critic grandfathers pre-f10 plans for bun-test rule as ADVISORY not BLOCK` | No |

The 6 tests that do exist use different names (e.g., `critic flags feature with zero edge checks` vs the required `…as validation-underspecified`). When the spec's verifier commands run with `charter-named-test.sh`, they all exit non-zero. Without the helper they would silently pass — which is exactly the f10 silent-pass hole.

### B2: Touch-overlap detection has zero test coverage
`tests/v21-planner-critic-rewrite.test.ts`

Mandate (d) requires the test file to verify the touch-overlap rule is documented. No test greps for `touches`, `touch-overlap`, `Touch-overlap`, or any related keyword. The rule exists in the agent prompt but is unverified by the test suite.

### B3: review:skip audit has zero test coverage
`tests/v21-planner-critic-rewrite.test.ts`

Mandate (e) requires the test file to verify the review-skip rule is documented. No test greps for `review:skip`, `review.*skip`, `skip-list`, or any related keyword. The rule exists in the agent prompt but is unverified by the test suite.

---

## Non-blocking notes

- The 6 existing tests all pass cleanly (`6 pass, 0 fail`). The agent prompt content is substantively correct for mandates (a), (b), (c). The gap is purely test–spec alignment and missing coverage for (d) and (e).
- `critic flags feature with zero edge checks` (line 29) is a near-miss for the spec check `critic-flags-feature-with-zero-edge-checks`; adding `as validation-underspecified` to the test name plus the corresponding spec-named checks for the other 5 would close B1.
- The `Verification-prose-must-back-VAL` rule is documented in the agent prompt (lines 20–25) and is a BLOCK category; it is referenced in spec check `critic-flags-unverifier-backed-verification-prose` but has no test. Fixing B1 by adding that test would simultaneously close the gap.

---

## Required fixes before PASS

1. Rename (or add) test cases in `tests/v21-planner-critic-rewrite.test.ts` so the 6 spec-defined check names (`-t '<phrase>'`) each match exactly one test.
2. Add tests for touch-overlap detection (mandate d): at minimum grep for `touches`, `Touch-overlap detection`, and a BLOCK/ADVISORY distinction.
3. Add tests for review:skip audit (mandate e): at minimum grep for `review:skip`, `review.*skip audit`, and the rationale/owner requirement.
