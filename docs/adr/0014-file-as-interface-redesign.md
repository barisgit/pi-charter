# The file is the interface

Status: accepted; supersedes ADR-0010 and ADR-0011; amends ADR-0012 and ADR-0013

> **Amended by ADR-0015.** The single-file/tool/lifecycle design remains current, but ADR-0015 supersedes this ADR's criterion grammar and authoring guidance: canonical criteria now use one unified `Status:` line, optional References, and substantive criterion bodies. `Evidence:` is legacy input only.

## Context

A design review against the 2026 agent landscape (Codex `/goal`, Claude Code `/goal` and `/loop`, Factory Missions, spec-driven frameworks) found that pi-charter's core bets are validated — durable objective, runtime idle-reprompt (smart-Ralph), evidence-gated completion — but its ergonomics are the industry outlier. An agent had to perform ~6–7 ceremony steps (create, author two markdown files against a bespoke grammar, satisfy parse warnings, read status) before the first line of real work, and drive evidence through an RPC-style tool schema agents repeatedly fumbled. Codex and Claude Code reach the same loop with one command.

Observed failure modes that motivated the redesign:

- Agents stumbled on the criteria.md grammar and the `charter_record` entry schema.
- Evidence defaulted to "ran tests" — the weakest form — because docs taught it as canonical.
- REPORT.md's non-empty-headings gate produced artifact-shaped junk (e.g. a "recording" of a terminal running tests and greps instead of the built app).
- UUID directory names made finding the latest charter painful.

## Decision

### One tool, four params, seven actions

The LLM surface collapses to a single `charter` tool:

```
charter({
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon",
  id?,         // addressing; omit = session-bound charter
  objective?,  // create only
  note?        // pause/abandon/complete annotation; required for abandon
})
```

`charter_record` and `charter_status` are deleted. There is no tool for editing criteria or recording evidence — that is the point.

### The file is the interface

Everything contentful happens by editing one markdown file, `charter.md`. `criteria.md` is deleted. Evidence is recorded by editing the criterion's `Evidence:` line in place. Agents are bad at remembering tool schemas and excellent at editing markdown; the grammar is small enough to teach entirely inside the scaffolded template.

Grammar the runtime parses (everything else is inert prose):

```markdown
## Objective                      — required, prose
## Criteria                       — required section
### C<n>. <title>                 — one heading per criterion
Depends: C1, C2                   — optional, advisory ordering only
Evidence: pass|fail|none — <note> — one line per criterion; reads until next heading
```

- Optional prose body between the heading and `Evidence:` describes how to verify (commands, budgets, failure modes). Replaces the v3 `Verifier:`/`Command:` annotations (already descriptive-only per ADR-0013).
- `## Scope` and any grouping headings are inert and encouraged.
- A charter with **no criteria is open-ended**: `complete` is never legal; it runs until `pause` or `abandon`. Criteria can be added later to make it bounded.
- HTML comments are ignored; the `create` scaffold uses them for guidance.

### Milestones are unmodeled

The persisted decomposition is `Objective → Criterion`, flat. Grouping headings inside `## Criteria` are welcome but the runtime does not model them: no milestone state, no per-milestone gates, no VAL-count doctrine. (Amends ADR-0012's `Objective → Milestone → VAL`.)

### Depends: advisory micro-DAG

A criterion may declare `Depends: C1, C2`. This feeds only Ralph steering and status ordering. It never gates evidence recording or completion. Cycles and dangling references are status warnings, never errors. (This does not reopen ADR-0012's feature-DAG removal: no lock-time validation, no persistence beyond the markdown line.)

### Timestamp-slug ids

Charter ids are `<YYYYMMDD-HHMMSS>-<slug>`, e.g. `20260702-153042-streaming-parser`. Slug derives from the objective (lowercase, non-alphanumeric stripped, ~32 chars). Directories sort chronologically in `ls`; `list` is a reverse-lex sort; `id` accepts unique prefixes/fragments. Supersedes the `crypto.randomUUID()` invariant.

### Storage: `.charters/`, minimal sidecars

```
.charters/
  20260702-153042-streaming-parser/
    charter.md      — objective + criteria + evidence; THE interface
    state.json      — FSM state, session binding, snapshot hash + parsed-criteria cache
    events.jsonl    — append-only journal: per-criterion evidence diffs, source-change ticks, transitions
    work/           — evidence artifacts: screenshots, recordings, output dumps
    REPORT.md       — scaffolded at first complete attempt
```

`criterion-state.json` is deleted; the markdown carries criterion state, `events.jsonl` carries history. This narrows the "runtime status lives in JSON sidecars" invariant: only *lifecycle* state is sidecar JSON. The charters root moves from `.pi/charters/` to `.charters/`. No migration: old `.pi/charters/` dirs are left untouched and never read. pi-charter does not edit `.gitignore`; users decide what to commit.

One active charter per session. `create` while one is active fails with a pointer to it. `id` addresses paused/other charters.

### Edit detection: snapshot-diff at tool-result boundaries

No polling, no fs watcher. The extension hooks every tool result and turn boundary; at each, a content-hash compare against the last snapshot (parse + per-criterion diff only on change). A monotonic **sequence counter** over tool calls orders events: evidence edits and source-file modifications each get a seq.

### Staleness: computed, global, gate-at-complete

A criterion is **stale** when its `pass` evidence's seq precedes the latest source-modifying seq. No per-criterion flags (`requireFreshEvidence` is deleted as authored syntax; the check is now automatic and global), no path-scoping cleverness.

- Continuous: status and Ralph mention stale criteria (advisory).
- Hard: `complete` rejects stale `pass` evidence, listing exactly which criteria need re-verification.

This turns the "final verification sweep" from doctrine into mechanism.

### Evidence doctrine: use it like a user

Evidence quality hierarchy, taught by template and skill, strongest first:

1. **Used it like a user would** — drove the actual app/site/CLI, captured a screenshot or recording into `work/`.
2. **Observed the real system** — real command/endpoint output pasted or saved.
3. **Ran the checks** — tests/typecheck/lint; necessary but weakest, acceptable alone only for criteria that are themselves about code behavior.

Artifacts are born at **verification time, per criterion** — never captured retroactively to satisfy the report. The runtime still records and never runs (ADR-0013 holds); quality enforcement is template teaching plus Ralph advisories (e.g. UI-facing criterion with tests-only evidence), not gates.

### REPORT.md: curation, not creation

At first `complete` attempt the runtime scaffolds REPORT.md pre-populated from charter.md: objective, each criterion with its pass note and `work/` artifact links. The agent's job is narrative and ordering, not producing new evidence. Artifact links per criterion are a **soft requirement** — encouraged by scaffold and Ralph, not gated in code (revisit if junk recurs). The completion gate on the report is: file exists with the scaffold filled in.

### Completion gate (full)

1. Every criterion's `Evidence:` line is `pass` with a non-empty note.
2. No `pass` evidence is stale.
3. REPORT.md exists (scaffolded on first attempt, then filled).
4. `charter:before_complete` hook allows.

### Unchanged

- Internal FSM: `active / paused / completed / abandoned`; created active; abandon requires a note.
- Smart-Ralph loop: deterministic idle reprompt for non-terminal charters; condensed one-liner (state + counts + top blocker); `status` is the detail view and stays terse.
- No auto-spawn scheduler; the agent is the loop driver.
- Charter records evidence, never runs verification (ADR-0013).
- Budgets stay out (bound by the host session); revisit with the planned CLI extraction.

## What this supersedes

| Prior decision | Fate |
| --- | --- |
| ADR-0010 charter.md / criteria.md split | Superseded: one charter.md |
| ADR-0011 three-tool surface | Superseded: one tool |
| ADR-0012 Objective → Milestone → VAL | Amended: Objective → Criterion, flat |
| ADR-0012 criterion-state.json sidecar | Amended: markdown + events.jsonl |
| ADR-0012/AGENTS.md UUID ids | Superseded: timestamp-slug ids |
| ADR-0013 evidence entry schema (source/because/outcome enum) | Superseded: Evidence: line; `partial` dropped; source/because folded into the note |
| ADR-0013 requireFreshEvidence per-VAL flag | Superseded: automatic global staleness |
| `.pi/charters/` + index.json | Superseded: `.charters/`, dir listing is the index |

## Consequences

- Activation energy drops to `/goal` parity: one tool call, then edit the scaffolded file. The differentiator over `/goal` — a structured, evidence-carrying completion contract — survives at zero marginal schema cost.
- Evidence loses its structured append-only envelope in the primary artifact; history survives in `events.jsonl`. Trust semantics were already display-only (ADR-0013), so nothing enforceable was lost.
- A tolerant markdown parser and per-criterion differ replace two tool schemas plus the criteria.md grammar. One grammar instead of three surfaces.
- The design is now host-portable (markdown + small FSM + journal); a standalone CLI with per-agent Ralph shims is a planned later phase. Until then, the pi extension remains the sole implementation.
