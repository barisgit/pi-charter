# m3-personas-and-skill Review — f6-critic-four-question-gate

**Charter:** 523dd305-4b90-4e87-a151-c3ca81a5adbb  
**Feature:** f6-critic-four-question-gate  
**Criterion:** VAL-FOUR-QUESTION-GATE  
**Reviewed at:** 2026-05-22T00:10:00.000Z  
**Outcome:** PASS

---

## Spec reviewed

`.pi/charters/523dd305-4b90-4e87-a151-c3ca81a5adbb/plan/f6-critic-four-question-gate.md`

Boundaries:
1. Insert verbatim four-question gate into `agents/charter-planner-critic.md`
2. Extend critic verdict shape with `feature-underspecified` + `whichQuestion`
3. Gate scopes to feature plan body, NOT charter.md

## Diff inputs

`agents/charter-planner-critic.md` — static read (persona text, not runtime code)

## Verification

```
bun test tests/v22-critic-four-question.test.ts
3 pass, 0 fail
```

## Findings against spec

| Requirement | Location in file | Status |
|---|---|---|
| Verbatim four-question block | Lines 53-56 | Present |
| `BLOCK feature-underspecified` | Line 59 | Present |
| `whichQuestion: 'does'\|'boundaries'\|'complexity'\|'verification'` | Line 61 | Present |
| `FEATURE PLAN BODY` (all-caps) | Lines 50, 54 | Present |
| `The four-question gate applies to FEATURE PLAN BODY content` | Line 50 | Present |
| `does NOT apply to charter.md` | Line 51 | Present |

## Blocking issues

None.

## Non-blocking notes

1. Four-question bullet block sits flush-left (lines 53-56) while surrounding numbered-list steps are indented — cosmetic inconsistency, no functional impact.
2. `whichQuestion` enum is inline prose; other BLOCK kinds in the file use a dedicated verdict-shape example block. Minor consistency gap, non-blocking.

## Surprises / Worth noting

- The prior evidence for this feature was `partial` (suite had unresolved failures from earlier in the build). Those failures are now resolved by m1-foundation (f1/f2/f3). The feature itself was always correct.
