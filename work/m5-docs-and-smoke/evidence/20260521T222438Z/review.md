# Review: f13-showcase-v22 (VAL-SHOWCASE-V22)

**Round:** 1  
**Reviewed at:** 2026-05-21T22:24:38Z  
**Outcome:** pass

---

## Spec reviewed

`f13-showcase-v22.md` (feature plan in `.pi/charters/523dd305-4b90-4e87-a151-c3ca81a5adbb/plan/`).

Key requirements:
- Surgical edits to `docs/showcase.html`, not a rewrite.
- DAG example shows planner-authored review feature with `Verifier: subagent { agent: charter-reviewer }` (replaces auto-injected ghost).
- Verifier kinds card grid shows all 6 kinds.
- `## Commands` section with worked example.
- Historical note: auto-injection removed in v2.2.
- Dir-per-run evidence layout referenced (`work/<featureId>/evidence/<ts>/evidence.json`).

## Diff / transcript inputs

- `git show 29c0455 -- docs/showcase.html`: +73/-16 on an ~805-line file — surgical.
- `git show 29c0455 -- tests/v22-showcase.test.ts`: +54 new test file, 5 named tests.
- Test run: `bun test tests/v22-showcase.test.ts` → 5 pass, 0 fail.

## Criterion-by-criterion findings

### 1. Surgical edits (not rewrite)
`PASS` — +73/-16 on an 805-line doc. Edits are targeted replacements and section insertions. No full-page rewrite.

### 2. DAG example: planner-authored review with `Verifier: subagent`
`PASS`  
- `docs/showcase.html:336` — heading changed to `m1 · planner-authored reviews`.  
- `docs/showcase.html:341` — `m1-review-oauth-cb` node carries `Verifier: subagent { agent: charter-reviewer }`.  
- Legend at line 403 updated to `review (planner-authored)` and `qa (planner-authored milestone gate)`.

### 3. 6 verifier kinds shown
`PASS` — Lines 462–494: card grid with `<h3>` headings for `command`, `hook`, `manual`, `prompt-judge`, `subagent`, `evidence-exists` plus summary paragraph "All 6 verifier kinds".

### 4. `## Commands` worked example
`PASS` — Lines 656–682: section `<h2>## Commands</h2>` with two cards: "Declared in charter.md" (code block with build/test/dev) and "Worked example — feature smoke".

### 5. Historical note on auto-injection removal
`PASS` — `docs/showcase.html:408`: `<strong>Historical note:</strong> auto-injection was removed in v2.2...`. The string `auto-inject` appears exactly once in the file, inside this historical note. No stale references remain.

### 6. Dir-per-run evidence reference
`PASS` — `work/<featureId>/evidence/<ts>/` path appears in:
- SVG node title `docs/showcase.html:594`
- Prose paragraph `docs/showcase.html:630` (references "v2.1 dir-per-run layout")
- Filesystem tree `docs/showcase.html:738`

## Blocking issues

None.

## Non-blocking notes

1. `docs/showcase.html:656` — `<h2>## Commands</h2>` has a literal `##` in the rendered heading. This is intentional per spec ("## Commands section") and the test asserts this exact string. Cosmetically unusual but consistent with the spec intent of showing the section marker.

2. `docs/showcase.html:~345` — Only `m1-review-oauth-cb` SVG node carries the `Verifier: subagent` annotation; `m1-review-session` does not. The spec requires the DAG *example* to show the pattern — one annotated node suffices.

3. `tests/v22-showcase.test.ts:49` — The auto-injection exclusion test uses a single-match regex replace. Latent fragility if the historical note is ever duplicated, but no issue with the current content.

## Tests run

```
bun test tests/v22-showcase.test.ts
 5 pass  0 fail  (76ms)
```

No truncation. No output piped through head/tail.

---

## Surprises / Worth noting

- The `<h2>## Commands</h2>` literal-markdown-in-HTML heading is the most notable style oddity but is spec-driven and test-confirmed.
