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
recorded pass evidence and completion gates are clear.

The deterministic Ralph loop is the engine. `charter_status nextActions[]`, the
four-state FSM, drift views, evidence gates, and completion blockers are
runtime-owned. Markdown teaches doctrine; it does not define legal transitions.

**pi-charter ships zero bundled personas.** Delegate recon, verification, and
review to **user-owned subagents** when useful. When a VAL marks
`RequireReviewSubagent: true`, charter displays that authoring annotation and
any `source` / `recordedBy` provenance, but it is not a completion gate.

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
able to evaluate the VAL from the criterion text, descriptive verifier/command
annotation, and recorded evidence.

Good VALs name observable pass criteria, plausible failure modes, and what good
evidence should demonstrate. Best evidence **demonstrates the objective**; command
output, screenshots, logs, review notes, and artifacts are supporting detail.
`Verifier:` / `Command:` lines in `criteria.md` are descriptive annotations only:
they tell the agent or reviewer what to run or inspect, and charter parses and
displays them, but charter never executes them.

Evaluate a VAL at **behavior level**, not at the level of one test's title:

- Strong: recorded evidence that shows the intended behavior or outcome, with
  supporting command output or artifacts when a command is relevant.
- Good: a whole test **file** or **glob** run by the agent, with the command and
  output captured in evidence details.
- Avoid: evidence that only says a narrowly named test passed without showing how
  it demonstrates the objective. pi-charter may emit a
  `weak-verifier-phrase-coupled` parse warning for brittle phrase-coupled command
  annotations; it shows up in `charter_status` under `parse-warnings:`.

Size a VAL as a **reviewer-meaningful behavioral guarantee** — roughly 3–8 per
milestone. A VAL is not a restatement of one test name; its failure should
localize to "this behavior of the milestone is broken." The agent owns any
command execution itself and records the command string plus real output as
evidence through `charter_record action=evidence`.

Per-VAL flags in `criteria.md`:

- `RequireFreshEvidence: true` — pass evidence must be newer than the last `src/`
  change.
- `RequireReviewSubagent: true` — display-only authoring annotation; provenance
  (`source`, `recordedBy`) is shown for confidence, not used as a gate.

## Lifecycle (v3)

States: `active`, `paused`, `completed`, `abandoned`.

1. **Create** — `charter action=create` opens an active charter and scaffolds
   `charter.md`, `criteria.md`, and `work/`.
2. **Execute** — edit criteria, implement, delegate recon/review/QA work to
   user-owned subagents when useful, run any checks yourself or via chosen subagents,
   and record evidence.
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

Manual evidence requires a non-empty `because`. Commands are run by the agent
(or a user-owned subagent) and their output is recorded with
`charter_record action=evidence`; charter stores evidence, it never runs checks.

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

- Every VAL has explicit pass criteria, failure modes, and a descriptive verifier
  or evidence shape an independent party can evaluate.
- Cross-cutting VALs cover integration, commands, QA, architecture, or suite
  health — not only happy-path feature checks.
- `## Commands` declares build/test/dev/lint commands agents or user-owned
  subagents can quote and run when gathering evidence.

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
- Recording manual evidence without `because` — manual evidence requires a rationale.
- Writing orchestrator-owned sidecars from a subagent — report via evidence only.
- Treating `RequireReviewSubagent` as a gate — it is display-only; delegate review
  when useful for confidence, then record the result as evidence.

## Quick reference

| Tool | Purpose |
| --- | --- |
| `charter action=create` | Open a charter; session auto-binds. |
| `charter action=pause/resume` | Lifecycle escape hatch. |
| `charter action=complete` | Gated finish; REPORT.md + recorded VAL pass evidence + alignment gates. |
| `charter action=abandon` | Terminal exit; reason required. |
| `charter_record action=evidence` | Append pass/fail/partial evidence (batch `entries`). |
| `charter_status` | Status + drift + blockers + `nextActions[]`. |
