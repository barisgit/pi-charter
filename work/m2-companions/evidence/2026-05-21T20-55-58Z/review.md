# Review: f3-md-companions — m2-companions milestone

**Criterion:** VAL-MD-COMPANION  
**Outcome:** PASS  
**Reviewed at:** 2026-05-21T20:55:58Z  

---

## Spec vs. Implementation

The spec (f3-md-companions.md) requires:

1. Optional `narrativePath: string` on schema kinds (qa, review, command, readiness)
2. Sibling auto-detection: `qa.md` alongside `qa.json` → stored in `narrativePath`
3. Absolute paths rejected at validation
4. `..`-traversal outside run dir rejected
5. deeply-nested charter dirs round-trip correctly
6. Both `qa.md` and `review.md` companions tested

### (a) Schema accepts optional relative narrativePath — PASS

`evidence-schemas.ts` defines `NarrativePathSchema = Type.Optional(Type.String())` applied on all four schema kinds (command, review, qa, readiness). The `validateNarrativePath()` function enforces relative-only (rejects `/`-prefix, Windows drive `C:\`, and UNC `\\` paths). No `.md` extension is enforced at schema level; that is done in `validateNarrativeCompanionPath()` during import. Test `"evidence record accepts relative narrativePath"` passes.

### (b) Absolute paths rejected — PASS

`validateNarrativePath()` rejects paths starting with `/` or matching `^[A-Za-z]:[\\/]` or starting with `\\`. Test `"evidence record rejects absolute narrativePath"` passes.

### (c) Outside-dir paths rejected — PASS

`validateNarrativeCompanionPath()` resolves the path under `runDir` and checks `relativeToRun.startsWith("..")`. It also checks `relativeToCharter.startsWith("..")` for paths that escape the charter dir. Test `"evidence record rejects narrativePath outside run dir"` passes with `err.code === "evidence.narrative_path_invalid"`.

### (d) Deeply-nested charter dirs round-trip correctly — PASS

Test `"deeply-nested charter dir round-trips narrativePath correctly"` creates a project at `rootDir/deep/nested/project`, runs through the full import pipeline, and confirms `stored.narrativePath === "qa.md"`. Passes.

### (e) Both qa.md and review.md companions tested — PASS

Dedicated tests for each:
- `"qa.md companion lands next to evidence.json in dir-per-run"` — verifies sibling auto-detection for `qa` kind via `siblingNarrativePath()`.
- `"review.md companion lands next to evidence.json in dir-per-run"` — passes `.md` as the `evidenceFile` argument, triggering `requestedIsMarkdown` path; verifies `stored.recordedBy` carries the reviewer session id.

---

## Test run

```
bun test tests/v21-md-companions.test.ts
6 pass, 0 fail, 17 expect() calls — 196ms
```

---

## Minor non-blocking observations

1. The spec Validation section references `tests/v21-md-companion.test.ts` (singular), but the actual file is `tests/v21-md-companions.test.ts` (plural). The criterion `Command:` in `charter.md` also uses the singular form and would fail if run verbatim. This is a documentation/command mismatch, not a code defect — the correct file exists and passes.

2. `validateNarrativePath()` does not reject `..` segments in the top-level schema validator; only `validateNarrativeCompanionPath()` (called during file import) blocks traversal. A raw schema-only `validateEvidenceFile({ narrativePath: "../escape.md" })` returns `ok: true`. This is consistent with the lazy-check design (traversal is only relevant during a real import), but worth noting for future schema tightening if evidence JSON is stored/transmitted without a subsequent import step.

3. No test covers the "missing companion still valid" path (JSON-only evidence without sibling `.md`). The spec says "No enforcement that .md exists; a JSON-only evidence record is still valid." The implementation correctly omits the `.md` when absent (`siblingNarrativePath` returns `undefined`), but test coverage for this path is absent in `v21-md-companions.test.ts`. Non-blocking since spec explicitly treats it as optional.

---

## Verdict

No blocking issues. All five spec requirements verified by code reading and confirmed by the full test run.
