# Code Review — m4-recipes (f6-recipe-index, f7-recipe-terminal, f8-recipe-stubs)

Charter: a252b21d-9451-4dda-af1d-f7b02bd22b7f  
Criteria: VAL-RECIPE-INDEX · VAL-RECIPE-TERMINAL-VERIFIED · VAL-RECIPES-STUBS  
Reviewer: charter-reviewer  
Date: 2026-05-21  
Outcome: **PASS**

---

## (a) Decision tree — VAL-RECIPE-INDEX

`skills/pi-charter/references/qa.md` section "What surface are you capturing?" lists 11 bullet entries covering all 10 distinct surfaces (WebSocket/SSE shares `http-api.md#websocket-sse`, which is intentional and spec-conformant). Every bullet maps correctly:

| Surface | Target recipe |
|---|---|
| Terminal / CLI / TUI / agent shell | qa/terminal.md |
| Browser / web app / web TUI | qa/browser.md |
| Native desktop / OS UI / dialogs | qa/desktop.md |
| Mobile / simulator | qa/mobile.md |
| HTTP / REST / GraphQL | qa/http-api.md |
| WebSocket / SSE / real-time | qa/http-api.md#websocket-sse |
| Database state / schema / query plans | qa/database.md |
| Server logs / processes / metrics | qa/logs-and-processes.md |
| File changes / generated code / build outputs | qa/generated-files.md |
| Visual regression (before/after pixel diff) | qa/visual-regression.md |
| Reproducing the run (env, scripts) | qa/reproducibility.md |

"Shared conventions" section is present, specifying artifact placement convention, stable filenames, dual-artifact rule (qa.json + qa.md), and improvise guidance pointer.

`SKILL.md` references `references/qa.md` at line 207. All test assertions for `VAL-RECIPE-INDEX` pass.

No blocking findings.

---

## (b) Terminal recipe content — VAL-RECIPE-TERMINAL-VERIFIED

`skills/pi-charter/references/qa/terminal.md` reviewed against all required sections:

- `## What this is for` — present
- `## Recommended stack — verified` — present; names tmux, asciinema 3.2.0, agg 1.8.1, ffmpeg; lists exact verified command sequence; documents observed artifact sizes (64KB cast, 300KB gif, 225KB mp4, 2.7KB txt).
- `## Detection` — present; 4-tier STACK detection script.
- `## Graceful degradation` — present; 4 numbered fallbacks (full stack → asciinema+agg → asciinema-only → script(1) → plain tee).
- `## Platform notes` — present; macOS Homebrew, Linux apt, Windows WSL sub-sections.
- `## Anti-patterns` — present; covers `asciinema cat` broken in 3.x, `--no-session` requirement, PTY requirement, and the two-layer Ctrl-D exit dance (all explicitly named as required by tests).
- `## Out-of-scope` — present.
- `## When to abandon` — present (full heading "## When to abandon and improvise").
- `## Smoke command` — present; 4-tool conjunction.

The recipe is runnable: commands are concrete, refer to real tools (tmux, asciinema, agg, ffmpeg), use the correct `agg --theme monokai terminal.cast terminal.gif` regeneration line. The exit-dance procedure matches asciicast fixture content.

Note: test file checks for `## Platform notes` but the recipe uses `## Platform notes` (correct). The stubs test checks for `## Platform-specific notes` (stubs use that variant). The terminal recipe uses the non-"specific" variant `## Platform notes` — the terminal test passes because it tests terminal.md via `requiredSections` which itself uses `## Platform notes`. No mismatch.

No blocking findings.

---

## (c) Fixture validity — VAL-RECIPE-TERMINAL-VERIFIED

**terminal.cast**  
- Header: `{"version":3,"term":{"cols":100,"rows":30,...},"command":"pi --no-session",...}`  
- Version is 3 (expected). cols=100 > 0, rows=30 > 0. command="pi --no-session" matches spec. First event `[3.730,"o","..."]` — valid array, type "o". File has 169 lines (full session).

**terminal.gif**  
- Size: 307,428 bytes (> 0). Magic bytes: `47 49 46 38 39 61` = `GIF89a`. Valid animated GIF (NETSCAPE2.0 extension present, confirming animation).

Both fixtures pass structural validation tests. No blocking findings.

---

## (d) Stubs — VAL-RECIPES-STUBS

All 9 stub files are present: browser.md, desktop.md, mobile.md, http-api.md, database.md, logs-and-processes.md, generated-files.md, visual-regression.md, reproducibility.md.

Required sections per stub (from test): `## What this is for`, `## Recommended stack`, `## Detection`, `## Graceful degradation`, `## Platform-specific notes`, `## Anti-patterns`, `## Out-of-scope`, `## When to abandon`, `## Smoke command` — verified present in all 9 files.

Status banner: all 9 files open with `> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.`

Note: terminal.md uses `## Platform notes` while stubs use `## Platform-specific notes`. This is consistent with the test assertions (stubs test checks for the "specific" variant; terminal test checks for the non-"specific" variant). Not a defect.

No blocking findings.

---

## (e) Status table consistency — VAL-RECIPE-INDEX / VAL-RECIPES-STUBS

Status table in qa.md:

```
| qa/terminal.md | verified | macOS arm64 | 2026-05-21 |
| qa/browser.md  | stub     | n/a         | n/a        |
| qa/desktop.md  | stub     | n/a         | n/a        |
| qa/mobile.md   | stub     | n/a         | n/a        |
| qa/http-api.md | stub     | n/a         | n/a        |
| qa/database.md | stub     | n/a         | n/a        |
| qa/logs-and-processes.md | stub | n/a   | n/a        |
| qa/generated-files.md    | stub | n/a   | n/a        |
| qa/visual-regression.md  | stub | n/a   | n/a        |
| qa/reproducibility.md    | stub | n/a   | n/a        |
```

Table has exactly 10 rows. All shipped files are accounted for. terminal.md is the only verified recipe; all others are stubs. Table matches filesystem state exactly.

No blocking findings.

---

## Test run

```
bun test tests/v21-recipe-index.test.ts tests/v21-recipe-terminal.test.ts tests/v21-recipe-stubs.test.ts
20 pass, 0 fail, 195 expect() calls — 129ms
```

---

## Summary

All five assessment areas pass. No blocking findings. No non-blocking notes worth flagging.

**Verdict: PASS**
