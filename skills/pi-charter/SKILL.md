---
name: pi-charter
description: Drive multi-milestone work to completion under a durable VAL contract. Use for charter, charter_record, charter_status tools, /charter command, --charter-objective flag, .pi/charters/ dirs, or when the user asks to implement/build/ship something spanning many turns. Skip for single-file edits or quick fixes.
---

# pi-charter

`CONTEXT.md` is the canonical domain-language reference. ADR 0009 keeps Ralph
deterministic: Ralph nudges the main agent back into the contract, but it does
not replace the agent or invent a second evaluator.

## What pi-charter is

A **charter** is an evidence-gated contract between the main agent and the
mission. The contract is complete only when every in-scope `VAL-*` criterion has
pass evidence and completion gates are clear.

The deterministic Ralph loop is the engine. `charter_status nextActions[]`, the
four-state FSM, drift views, evidence gates, and completion blockers are
runtime-owned. Markdown teaches doctrine; it does not define legal transitions.

**pi-charter ships zero bundled personas.** Delegate recon, verification, and
review to **user-owned subagents**. When a VAL
marks `RequireReviewSubagent: true`, any passing evidence row with
`source: subagent` and non-empty `recordedBy` (for example
`subagent:my-reviewer:<sessionId>`) satisfies the gate — no specific agent name
is required.

## File tree

A charter lives under `.pi/charters/<id>/`:

```text
charter.md
criteria.md
REPORT.md                 # scaffolded on first complete attempt
state.json
criterion-state.json
work/<segment>/evidence/<ts>/
```

Authored surfaces:

- `charter.md` — `## Objective`, scope/constraints, mission boundaries, and
  optional `## Commands` (build/test/dev/lint entries for verifiers).
- `criteria.md` — the VAL register grouped by `## <milestone>` headings with
  `### VAL-*` leaves. New charters keep criteria here; parsers still fall back
  to legacy `charter.md ## Criteria` when needed.

Runtime surfaces:

- `criterion-state.json` — latest outcome per VAL plus evidence pointers.
- `work/<segment>/evidence/<ts>/evidence.json` — flat evidence rows (dir-per-run).

Subagent write boundary:

- Subagents may write only under `work/<segment>/evidence/`.
- Subagents must never write `state.json`, `criterion-state.json`, `charter.md`,
  or `criteria.md`. Report results via `charter_record action=evidence`.

## VAL doctrine

VALs are declarative behavioral assertions, not task titles or implementation
steps. The read-aloud test: someone who has never seen the codebase should be
able to verify the VAL from the criterion text, verifier, and produced evidence.

Good VALs name observable pass criteria, plausible failure modes, and a verifier
shape. Prefer project-level commands (`bun test`, `bun run check-types`) over
bespoke per-VAL scripts.

Verify a VAL at **behavior level**, not at the level of one test's title:

- Best: a real observable command whose exit code proves the behavior — a build,
  an HTTP probe, a CLI invocation, a file/exit-code assertion
  (e.g. `bun run build`, `curl -fsS localhost:3000/health`, `test -f dist/app.js`).
- Good: a whole test **file** or **glob** — `bun test tests/unit/group-node.test.ts`
  or `bun test tests/unit/group-*.test.ts`. These fail when the path resolves to
  nothing, so absence can't pass silently.
- Avoid: a single `bun test -t '<title>'` (or `--grep` / `--testNamePattern`)
  with no file/glob. It couples the VAL to one implementer's exact test title and
  **exits 0 when zero tests match** — a silent false pass. pi-charter emits a
  `weak-verifier-phrase-coupled` parse warning for this shape; it shows up in
  `charter_status` under `parse-warnings:`.

Size a VAL as a **reviewer-meaningful behavioral guarantee** — roughly 3–8 per
milestone — each backed by a suite or command that exercises many cases. A VAL
is not a restatement of one test name; its failure should localize to "this
behavior of the milestone is broken." Invariant: **a command verifier must fail
when its target is absent** (file / glob / observable commands satisfy this for
free). For the rare case where a file exists but runs zero tests, guard the
suite with `scripts/charter-named-test.sh <test-file>` (no phrase), which fails
when 0 tests ran. The phrase form `charter-named-test.sh <file> '<phrase>'`
survives only as a niche tool for deliberately binding a VAL to a stable named
subset of a mixed file; do not reach for it by default.

Per-VAL flags in `criteria.md`:

- `RequireFreshEvidence: true` — pass evidence must be newer than the last `src/`
  change.
- `RequireReviewSubagent: true` — pass evidence must include a subagent-attributed
  row (`source: subagent`, non-empty `recordedBy`).

## Lifecycle (v3)

States: `active`, `paused`, `completed`, `abandoned`.

1. **Create** — `charter action=create` opens an active charter and scaffolds
   `charter.md`, `criteria.md`, and `work/`.
2. **Execute** — edit criteria, implement, delegate recon/review/verify work to
   user-owned subagents, record evidence.
3. **Complete** — `charter action=complete` when every VAL passes and blockers are
   clear. First attempt scaffolds `REPORT.md`; completion requires non-empty
   content under every heading.
4. **Pause / abandon** — lifecycle escape hatches; abandon requires a reason.

There is no planning state, no `lock_plan`, no feature DAG, and no handoff store.

## Delegation discipline

Main-agent context is the scarce resource. Delegate bounded read-only recon,
verification, and review to subagents; they return evidence instead of mutating
orchestrator-owned contract files.

| Job | Subagent (examples — use your project's agents) |
| --- | --- |
| Code/file recon, symbol tracing | `explorer` |
| External research (vendor docs, library API) | `explorer` |
| Bounded implementation | `fixer` |
| Independent review + evidence write | your review subagent |
| Command/QA verification + evidence write | your QA or verifier subagent |
| Hard-debug direction | `oracle` (advisory) |

Sync subagent calls block main entirely until the child finishes — main cannot
read, edit, spawn more work, or receive messages in the meantime. Use sync only
when the next move genuinely depends on the child's output and there is nothing
useful to do in parallel.

`subagent({ async: true, ... })` returns immediately with a run id; the child
runs in the background while main stays free to read, edit, spawn more
subagents, or hand control back to the user. The subagent runtime wakes main
when any child finishes or needs attention, so explicit sleeping or polling is
normally unnecessary.

Prefer async when the next step does not depend on the child's output, when you
want to fan out independent runs, or when the user should be able to prompt
fixes while work progresses.

## Evidence

Record evidence with the batch shape when updating multiple VALs:

```ts
charter_record({
  action: "evidence",
  entries: [
    {
      criterionId: "VAL-AUTH-001",
      outcome: "pass",
      summary: "bun test tests/auth.test.ts pass",
      because: "manual capture of CI output",
      source: "manual",
    },
    {
      criterionId: "VAL-AUTH-002",
      outcome: "pass",
      summary: "reviewed diff against criteria",
      source: "subagent",
      recordedBy: "subagent:team-reviewer:session-42",
    },
  ],
})
```

Manual evidence requires a non-empty `because`. Command verifiers run via
`charter_record action=verify`.

Evidence uses dir-per-run layout `work/<segment>/evidence/<ts>/`. Optional
markdown companions (`review.md`, `qa.md`) may sit beside `evidence.json` in
the same run directory.

## Capture recipes

QA capture recipe selection starts at `skills/pi-charter/references/qa.md`. That
shelf routes terminal, browser, desktop, mobile, HTTP/API, real-time, database,
logs/processes, generated-file, visual-regression, and reproducibility surfaces.

## Online research delegation

Delegate online research when the plan depends on current ecosystem facts the
main agent should not guess (smaller/newer ecosystems, SDK-heavy integrations,
"find current docs" questions). Do not spend research budget on foundational,
slowly evolving knowledge unless the objective names a version-specific risk.

Store distilled findings in `library/<topic>.md`. Store raw notes in
`library/research/<topic>.md`.

## Planning is the work

Planning is the work: implementation is mostly typing once criteria name real
outcomes, boundaries, verification, and risks. Before heavy implementation:

- Every VAL has explicit pass criteria, failure modes, and a verifier or evidence
  kind an independent party can evaluate.
- Cross-cutting VALs cover integration, commands, QA, architecture, or suite
  health — not only happy-path feature checks.
- `## Commands` declares build/test/dev/lint commands subagents must use
  verbatim when running verifiers.

Done planning means `criteria.md` covers the mission with milestone groupings and
every VAL has a verifier line; then drive execution via `charter_status`
`nextActions[]`.

## Reading status

Read `charter_status` whenever you are unsure, after recording evidence, and
before completing. It returns per-VAL outcomes, drift (`uncovered`, `stale`,
`readyNext`), completion blockers, milestone summaries, and `nextActions[]`.
Follow `nextActions[]`; do not guess transitions from this Markdown file.

If a Ralph reprompt appears, treat it as a nudge to re-read `charter_status` and
continue the legal runtime path. Only `charter action=complete` can finish the
charter.

## Common pitfalls

- Stopping after authoring criteria to ask whether to implement — an active
  charter is authorization to execute.
- Recording manual evidence without `because` — weak evidence fails trust gates.
- Writing orchestrator-owned sidecars from a subagent — report via evidence only.
- Completing before review gates clear — delegate a user-owned review subagent
  when `RequireReviewSubagent` is set.

## Quick reference

| Tool | Purpose |
| --- | --- |
| `charter action=create` | Open a charter; session auto-binds. |
| `charter action=pause/resume` | Lifecycle escape hatch. |
| `charter action=complete` | Gated finish; REPORT.md + VAL pass + trust gates. |
| `charter action=abandon` | Terminal exit; reason required. |
| `charter_record action=evidence` | Append pass/fail/partial evidence (batch `entries`). |
| `charter_record action=verify` | Run a criterion's command verifier. |
| `charter_status` | Status + drift + blockers + `nextActions[]`. |
