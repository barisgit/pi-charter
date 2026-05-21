# Code Review — m5-cleanup (f4-briefs-rename + f13-skill-md-update)

**Charter:** a252b21d-9451-4dda-af1d-f7b02bd22b7f  
**Criteria:** VAL-BRIEFS-RENAME, VAL-SKILL-MD-V21-UPDATE  
**Reviewer:** charter-reviewer  
**Date:** 2026-05-21  
**Outcome:** PASS — no blocking findings

---

## f4-briefs-rename (VAL-BRIEFS-RENAME)

### What was reviewed

- `src/application/service.ts` — `listQaBriefs()`, `QA_BRIEFS_DIR`, `LEGACY_QA_BRIEFS_DIR` constants, `createCharter` path construction.
- `tests/v21-briefs-rename.test.ts` — 4 tests.
- Grep for `qa/` in `src/` (excluding qa-briefs / QA_BRIEFS constants).

### Test results

```
(pass) v2.1 briefs dir rename > create charter scaffolds qa-briefs not qa [5.02ms]
(pass) v2.1 briefs dir rename > no qa/ briefs dir created by default [3.01ms]
(pass) v2.1 briefs dir rename > reads legacy qa/ briefs dir when qa-briefs absent [6.21ms]
(pass) v2.1 briefs dir rename > src/ contains no references to the literal qa/ briefs path [7.12ms]
```

All 4 pass. The `join()` grep (test 4) explicitly checks for bare `join(..., "qa"` patterns in `src/`; passes cleanly (exit 1 with empty stdout).

### Source review

- `service.ts:161` warning string `"legacy qa/ briefs dir is deprecated; rename ${legacyDir}..."` — this is user-visible deprecation text, not a path construction. The actual path construction uses the `LEGACY_QA_BRIEFS_DIR` constant. Correct.
- `createCharterWorkspace` constructs paths through `QA_BRIEFS_DIR = "qa-briefs"` constant; no raw `"qa"` path strings in join calls.
- `getCharterStatus` calls `listQaBriefs(dir)` which prefers `qa-briefs/`, falls back with warn to `qa/`. Fallback behavior is intentional and tested.

### Lingering `qa/` references assessed

| Location | Content | In scope? |
|---|---|---|
| `skills/pi-charter/references/qa.md` | Recipe shelf routing table | Explicitly excluded (intentional) |
| `skills/pi-charter/references/qa/http-api.md` | Recipe content | Explicitly excluded (intentional) |
| `docs/showcase.html` (4 occurrences) | v2 design-preview HTML, v1→v2 delta docs | Out of scope — static historical docs |
| `tests/v21-briefs-rename.test.ts` | Test code describing the qa/ legacy path | Expected — tests must reference the old name |
| `tests/v21-recipe-*.test.ts` | Recipe shelf test assertions | Out of scope — recipe shelf is excluded |
| `src/application/service.ts:161` | Deprecation warning message string | Correct — intentional behavior |

**No unexcused `qa/` brief-dir references remain in runtime source or skill/agent surface.**

---

## f13-skill-md-update (VAL-SKILL-MD-V21-UPDATE)

### What was reviewed

- `skills/pi-charter/SKILL.md` — full text.
- `agents/charter-qa.md` — qaBriefs field and briefs example.
- `tests/v21-skill-md-update.test.ts` — 5 tests.

### Test results

```
(pass) v2.1 SKILL.md update > SKILL.md references qa-briefs not qa [0.67ms]
(pass) v2.1 SKILL.md update > SKILL.md points at references/qa.md recipe shelf [0.34ms]
(pass) v2.1 SKILL.md update > SKILL.md documents dir-per-run evidence layout [0.17ms]
(pass) v2.1 SKILL.md update > SKILL.md mentions named-test helper script [0.11ms]
(pass) v2.1 SKILL.md update > SKILL.md documents qa.md and review.md companions [0.15ms]
```

All 5 pass.

### SKILL.md surface match to v2.1 reality

| v2.1 requirement | Location in SKILL.md | Status |
|---|---|---|
| `qa-briefs/<surface>.md` phrasing (not `qa/`) | "Planning QA briefs" section | Present |
| `not \`qa/\`` explicit callout | Same section | Present |
| Pointer to `skills/pi-charter/references/qa.md` | Same section | Present |
| `work/<feat>/evidence/<ts>/` dir-per-run layout | Evidence layout example | Present |
| `evidence.json`, `qa.json / qa.md`, `review.json / review.md` in layout | Same block | Present |
| Named-test helper `scripts/charter-named-test.sh` | "Verifier robustness" section | Present |
| `instead of bare` / `bun test -t` / `0-match pass` phrasing | Same section | Present |

### charter-qa.md

`qaBriefs` input described as `qa-briefs/<surface>.md` paths. Briefs example uses `"qa-briefs/surface.md"`. No legacy `qa/` references. Correct.

---

## Summary

Both features are complete and correctly implemented. All 9 tests across 2 test files pass. No lingering bare `qa/` brief-dir references in runtime source, SKILL.md, or agents. The `docs/showcase.html` occurrences are static design-preview HTML documenting v1 behavior and are out of scope for the rename. The deprecation warning string in `service.ts:161` is intentional behavioral text, not a path construction error.

**VAL-BRIEFS-RENAME: PASS**  
**VAL-SKILL-MD-V21-UPDATE: PASS**
