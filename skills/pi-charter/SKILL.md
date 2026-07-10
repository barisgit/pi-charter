---
name: pi-charter
description: "Use for durable charter-bound agent work in pi-charter: create/list/status/pause/resume/complete/abandon, edit the charter file under .charters, record Evidence lines, and curate REPORT.md. Skip quick single-turn fixes."
---

# pi-charter

Use this skill when work should be bound to a durable charter: multi-turn implementation, long-running verification, resumable work, or a user explicitly asks for a charter. For quick single-file or single-turn fixes, work normally.

`CONTEXT.md`, `docs/adr/0014-file-as-interface-redesign.md`, `AGENTS.md`, and `src/domain/template.ts` are the binding sources. If this skill conflicts with them, follow those files.

## 1. Create only when ready

Create a charter when the agent already has enough information to author meaningful criteria and start work.

- If scope, success criteria, or permission is unclear, ask the user before creating.
- Do not create a charter as a waiting room for unanswered questions. There is no separate waiting state.
- Once active, keep working until completed, paused, or abandoned.
- If a user answer is needed mid-charter, pause and put the question in `note`:
  `charter({ action: "pause", note: "Need user decision: ..." })`.
- Use `charter({ action: "status" })` when unsure about lifecycle state or blockers. Follow `nextActions[]` from tool returns.

Tool surface:

```ts
charter({ action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon", id?, objective?, note? })
```

## 2. Lifecycle walkthrough

Typical charter work is about three lifecycle tool calls. Everything contentful is normal work plus direct edits to `.charters/<id>/charter.md`.

1. Create: `charter({ action: "create", objective: "Ship X with verified behavior Y" })`.
2. Open `.charters/<id>/charter.md`.
3. Edit `charter.md`: refine `## Objective`/`## Scope` if needed, then author live criteria under `## Criteria` as `### C1. ...` with `Evidence: none`.
4. Implement normally: inspect, edit code, delegate recon or QA when useful, run the real app or commands.
5. Verify one criterion at a time using the strongest appropriate evidence.
6. Save artifacts produced during verification into `.charters/<id>/work/`.
7. Inspect each artifact yourself before citing it.
8. Edit the criterion's Evidence line in `charter.md`, for example: `Evidence: pass — drove login on dev server; screenshot: work/c1-login.png (2026-07-02)`.
9. Continue implementation and evidence edits until every criterion has `pass` evidence with a non-empty note.
10. Attempt complete: `charter({ action: "complete", note: "All criteria verified; report curated." })`.
11. If completion rejects stale evidence because source changed after a pass note, re-verify the listed criteria, update their Evidence lines, then call `complete` again.
12. If the first complete attempt scaffolds `REPORT.md`, curate it from the objective, criteria, Evidence notes, and already-captured artifacts; then retry `complete`.

Open-ended charter: if `## Criteria` has no live criteria, the charter can never complete. Use that only for intentionally unbounded work; later add criteria to make it completable.

## Verification ownership

pi-charter owns durable assertions and evidence records, not the verification mechanism. The charter-owning root remains responsible for `charter.md`, `REPORT.md`, artifacts, and lifecycle.

When an external verifier is useful:

1. Give it the criterion assertion, only the context needed to exercise it, and the artifact destination under `.charters/<id>/work/`.
2. Ask it to return the observed result and artifact paths. Do not delegate edits to `charter.md`, report curation, or lifecycle calls.
3. Inspect the returned artifacts yourself, decide what they prove, and write the Evidence line.

A failed verification ends that pass, not the charter lifecycle. Record `Evidence: fail` when useful, fix the work, and start a new verification pass. Do not pause or abandon solely because a verifier reported failure.

## EVIDENCE DOCTRINE

Prefer the strongest evidence that fits the criterion. Evidence proves the built thing works; it is not a diary entry.

1. **Use it like a user.** Start the real app/server, drive the actual flow, and capture a screenshot or recording into `.charters/<id>/work/`. Use whatever verifier and capture mechanism best matches the surface.
2. **Observe the real system.** Capture real CLI output, endpoint responses, logs, database output, or generated files from the system under test. Save long output into `work/` and cite the path.
3. **Run the checks.** Tests, typecheck, and lint are necessary but weakest. They are acceptable alone only for criteria that are purely about code behavior.

Before citing an artifact, inspect it yourself: open the screenshot, replay the recording, or read the saved output. If it does not show the built thing working, the criterion is not verified.

Wrong example: for a TUI app criterion, recording a terminal that only runs tests and greps source files. That proves checks ran; it does not prove the TUI was used. Record the actual TUI session instead.

Evidence line pattern:

```markdown
Evidence: pass — <what you did, what it showed, artifact path(s), date>
Evidence: fail — <what failed, where to inspect, date>
Evidence: none
```

Keep `none` until verification really happened. Do not backfill artifacts at report time.

## REPORT.md is the deliverable

`REPORT.md` is scaffolded on the first `complete` attempt. Treat it as the PR-pasteable showcase of the work.

- Curate from evidence already captured during verification.
- Link useful screenshots, recordings, logs, and output saved under `work/`.
- Explain what changed, why it satisfies the criteria, and how to review it.
- Never capture new evidence just to fill the report. If a report needs an artifact that does not exist, return to the criterion, verify properly, save the artifact, update its Evidence line, then curate the report.

## Grammar reference

The parser only cares about these constructs in `charter.md`:

```markdown
## Objective
## Criteria
### C<n>. <title>
Depends: C1, C2
Evidence: pass|fail|none — <note>
```

Rules:

- `## Objective` and `## Criteria` are required sections.
- Criteria are flat `### C<n>.` headings.
- `Depends:` is optional and advisory only; it never gates evidence or completion.
- Exactly one `Evidence:` line belongs under each criterion.
- `## Scope`, grouping headings, comments, and prose are inert unless they contain one of the parsed constructs above.
- Unknown structure is not a work blocker; fix it when status warns, then continue.

