---
name: pi-charter
description: "Use for durable charter-bound agent work in pi-charter: create/list/status/pause/resume/complete/abandon, edit charter.md under .charters, update criterion Status lines, capture verification artifacts, and curate REPORT.md. Skip quick single-turn fixes."
---

# pi-charter

Use this skill for durable, multi-turn, resumable work or whenever the user explicitly requests a charter. Work normally for quick fixes.

`CONTEXT.md`, ADR-0014, ADR-0015, `AGENTS.md`, and `src/domain/template.ts` are binding. Follow them if this skill drifts.

## Create only when ready

Create once scope and success are clear enough to author meaningful criteria and begin. Do not use a charter as a waiting room for unanswered questions. If a consequential user decision becomes necessary mid-charter, pause with the question in `note`.

```ts
charter({ action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon", id?, objective?, note? })
```

Follow every returned `nextActions[]`; do not memorize lifecycle legality.

## Author the durable contract

After `create`, edit `.charters/<id>/charter.md` directly.

- Make `## Objective` descriptive enough to preserve why the work matters, the intended outcome, and important constraints.
- Add optional `## References` for durable pointers to specs, plans, handoffs, ADRs, docs, or code. Do not put mutable progress there.
- Add optional `## Scope` for in/out boundaries.
- Under `## Criteria`, write independently meaningful observable outcomes, not tactical implementation steps. A substantial charter often needs roughly 10–20 criteria; narrow work may need fewer. Never pad the count.
- Give each criterion a concise title and enough prose to preserve expected behavior, boundaries, and important cases.
- Use `Depends:` only as advisory ordering.
- Use exactly one live record per criterion:

```markdown
Status: pending|in-progress|blocked|pass|fail — <note>
```

Status meanings:

- `pending`: meaningful work has not begun; note optional.
- `in-progress`: current work; note what is happening.
- `blocked`: cannot advance; note the concrete blocker.
- `pass`: verified; note required and must say what was observed.
- `fail`: verification failed; note required and must say what failed and why.

Do not add a separate evidence or activity field. pi-dag-tasks owns tactical execution steps; the charter owns durable outcomes and criterion activity.

A charter with no live criteria is open-ended and can never complete. Use that only for intentionally unbounded work.

## Work and verify

1. Mark current criteria `in-progress` as work begins; use `blocked` only for a real blocker.
2. Implement normally. Delegate bounded recon or QA when useful, but the root owner edits `charter.md`, curates `REPORT.md`, and performs lifecycle calls.
3. Verify each criterion with the strongest fitting evidence.
4. Save artifacts captured at verification time under `.charters/<id>/work/` and inspect them before citation.
5. Update the same Status line to `pass` or `fail` with the observation and artifact paths.
6. Continue until every criterion is `pass` with a non-empty evidence note.

A failed check ends that verification pass, not the charter lifecycle. Record `fail`, fix the work, and verify again. Do not pause or abandon merely because verification failed.

## Evidence doctrine

Evidence proves the built thing works; it is not a diary entry.

1. **Use it like a user.** Drive the real UI or flow and capture a screenshot or recording in `work/`.
2. **Observe the real system.** Capture actual CLI output, endpoint responses, logs, database output, or generated files.
3. **Run the checks.** Tests, typecheck, and lint are necessary but weakest; they may suffice for purely code-level criteria.

Do not backfill artifacts at report time. If an artifact does not show the criterion working, it is not evidence for that criterion.

```markdown
Status: in-progress — implementing the real login flow
Status: blocked — test account access is unavailable
Status: pass — drove login on dev server; screenshot: work/c1-login.png (2026-07-14)
Status: fail — callback returned 500; response saved at work/c1-callback.txt (2026-07-14)
```

Staleness is computed globally. A `pass` recorded before a later source change remains advisory in status/Ralph but hard-blocks completion until the criterion is re-verified and its Status line updated.

## Complete and curate REPORT.md

Call `charter({ action: "complete" })` when all criteria pass. The first attempt scaffolds `REPORT.md` from the Objective, References, Scope, criterion bodies, dependencies, and Status notes, then asks you to curate it.

Treat `REPORT.md` as the reviewable deliverable:

- explain what changed and why it satisfies the criteria;
- link useful artifacts already captured under `work/`;
- keep it reviewable and PR-pasteable;
- do not create new evidence merely to fill the report.

After curation, retry `complete`. If completion reports stale passes, re-verify those criteria first.

## Parsed grammar

```markdown
## Objective
## References
## Scope
## Criteria
### C<n>. <concise observable title>
<criterion body>
Depends: C1, C2
Status: pending|in-progress|blocked|pass|fail — <note>
```

`## References`, `## Scope`, criterion bodies, and `Depends:` are optional. Criteria are flat. Unknown structure and grouping headings are inert; parser breakage produces warnings rather than blocking work.
