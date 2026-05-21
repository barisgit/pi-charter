# Review: f10-named-test-helper — m1-schema milestone

**Outcome:** PASS  
**Reviewed at:** 2026-05-21T21:00:00Z  

---

## Spec vs. Implementation

### Script: `scripts/charter-named-test.sh`

**Argument handling:** Accepts 1 or 2 args. With 1 arg, `test_file=""` and phrase is `$1`. With 2, file is `$1`, phrase is `$2`. Zero or 3+ args prints usage to stderr and exits 2. Matches spec "exits non-zero if missing args".

**Zero-match detection:** `awk` parses `N pass` lines; if `pass_count == 0` → stderr message `"0 tests matched phrase: <phrase>"` + exit 1. Correct.

**Failure detection:** `fail_count` from `awk` on `N fail` lines; if non-zero → dump output to stderr + exit 1. Checked before zero-match, which is correct order (a 0-pass 1-fail case exits with the failure message, not the "0 matched" message).

**Exit 0 condition:** Only reached when `fail_count == 0` AND `pass_count >= 1`. The `status` check after those two is a belt-and-suspenders guard for unexpected non-zero bun exits that don't surface as fail lines.

**One minor observation:** The 1-arg form (`phrase` only, no file) is not in the spec and not tested. Non-blocking — it's additive and harmless.

### Tests: `tests/v21-named-test-helper.test.ts`

All four plan-anchored test names are present verbatim:
- "exits zero when one or more tests match" — passes, asserts exit 0 + `"1 pass"` in stdout.
- "exits nonzero when zero tests match" — passes, asserts non-zero + `"0 tests matched phrase:"` in stderr.
- "exits nonzero when a matched test fails" — passes, asserts non-zero + failure name in stderr, explicitly checks "0 tests matched phrase" is NOT present (correct).
- "exits nonzero when arguments are missing" — passes, asserts non-zero + usage string in stderr.

Fixtures: `passing-fixture.ts` trivially passes; `failing-fixture.ts` uses `expect(1).toBe(2)` — genuinely fails.

### Test run

```
bun test tests/v21-named-test-helper.test.ts
4 pass, 0 fail, 11 expect() calls — 85ms
```

---

## Non-blocking notes

1. The 1-arg invocation form (`phrase` only, no test file) is undocumented and untested. Additive only; no spec violation.
2. `set -euo pipefail` at top, but the `$output` capture block explicitly uses `set +e` / `set -e` guards — correct pattern for capturing exit codes without aborting.

---

## Verdict

No blocking issues. Spec requirements fully met.
