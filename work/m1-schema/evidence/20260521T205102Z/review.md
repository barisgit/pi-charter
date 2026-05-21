# Code Review — m1-schema / f10-named-test-helper

Charter: a252b21d-9451-4dda-af1d-f7b02bd22b7f  
Criterion: VAL-NAMED-TEST-HELPER  
Reviewer: charter-reviewer  
Date: 2026-05-21  
Outcome: **PASS**

---

## Deliverable: scripts/charter-named-test.sh

Script is present and executable. Implementation reviewed:

- **Argument handling**: accepts 1 arg (phrase only, suite-wide) or 2 args (file + phrase). Zero or >2 args → `Usage:` to stderr + exit 2. Matches spec.
- **Subprocess**: `bun test "$test_file" -t "$phrase"` with stdout+stderr captured. `set +e` around the call, exit code saved. Correct.
- **Pass count parsing**: `awk` on `N pass` line (anchored: leading whitespace + digits + space + "pass"). Count defaults to 0 via `count + 0`. Correct.
- **Fail count parsing**: same pattern for `N fail`. Checked before pass count — fail takes precedence. Correct.
- **Exit logic**:
  - `fail_count != 0` → stderr dump + exit 1.
  - `pass_count == 0` → stderr dump + `"0 tests matched phrase: <phrase>"` to stderr + exit 1.
  - `status != 0` (bun non-zero for other reason) → stderr dump + exit $status.
  - Otherwise: stdout to stdout, exit 0.
- **Spec requirements met**: exits non-zero on 0 matches with the required error message; exits non-zero on test failure; exits 0 only when ≥1 matched and 0 failed.

## Test fixtures

- `tests/fixtures/v21-named-test-helper/passing-fixture.ts`: single test "fixture matching pass" asserting `1 === 1`. Clean.
- `tests/fixtures/v21-named-test-helper/failing-fixture.ts`: single test "fixture matched failure" asserting `1 === 2`. Intentionally red.

## Test names (spec-anchored)

All four deliberate stable names are present in `tests/v21-named-test-helper.test.ts`:
- "exits zero when one or more tests match" — present
- "exits nonzero when zero tests match" — present
- "exits nonzero when a matched test fails" — present
- "exits nonzero when arguments are missing" — present

## Spec validation checks

| Check | Command | Result |
|---|---|---|
| zero-tests-exits-nonzero | `scripts/charter-named-test.sh ... NONEXISTENT_PHRASE_xyz; test $? -ne 0` | PASS |
| matching-tests-exits-zero | `scripts/charter-named-test.sh ... 'exits zero when one or more tests match'` | PASS — 1 pass, exit 0 |
| missing-args-fails-cleanly | `scripts/charter-named-test.sh 2>&1; test $? -ne 0` | PASS — Usage: to stderr |

(failing-test-exits-nonzero is exercised by the test suite itself — "exits nonzero when a matched test fails" passes.)

## Test run

```
bun test tests/v21-named-test-helper.test.ts
4 pass, 0 fail, 11 expect() calls — 189ms
```

## Findings

No blocking findings. No non-blocking notes.

**Verdict: PASS**
