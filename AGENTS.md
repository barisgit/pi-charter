# AGENTS.md — pi-charter

Reference for coding agents working in this repository.

## Project stance

`pi-charter` is a new successor concept, not a cosmetic rename of `pi-goals` v1. Treat v1 as reference material only. The current domain model is documented in `CONTEXT.md` and the ADRs (notably ADR-0014 and ADR-0015, which supersede the v3 surface from ADR-0010/0011 and amend ADR-0012/0013).

## Read order

1. `CONTEXT.md` — canonical language and boundaries.
2. `docs/adr/` — decisions that should not be re-litigated casually.
3. `docs/implementation/` — implementation specs and tool contracts.
4. `docs/research/2026-05-14-pi-charter-design/v2-brainstorm.md` — full design archive when details are missing.
5. `docs/reference/v1-pi-goals/pi-goals/index.ts` — old implementation patterns to lift surgically.

## Invariants

- The file is the interface: `charter.md` is the single authored artifact (descriptive Objective, optional References and Scope, substantive `### C<n>.` criteria with optional `Depends:` and one `Status:` line). There is no `criteria.md` and no tool for editing criteria or recording evidence — agents edit the file; the runtime snapshot-diffs it at tool-result boundaries.
- One LLM tool: `charter({action, id?, objective?, note?})` with actions `create | list | status | pause | resume | complete | abandon`. Every return carries legal `nextActions[]` so agents do not memorize the FSM.
- Charters live in `.charters/<YYYYMMDD-HHMMSS>-<slug>/` (timestamp-sorted ids, not UUIDs). Sidecars: `state.json` (lifecycle/session/snapshot only), `events.jsonl` (append-only journal), `work/` (evidence artifacts), `REPORT.md` (deliverable). Old `.pi/charters/` dirs are never read; no migration.
- Criterion workflow and evidence live together in `Status: pending|in-progress|blocked|pass|fail — <note>`; history lives in the journal. Do not add a parallel evidence/activity field. `criterion-state.json` and `feature-state.json` are dead names.
- Decomposition is flat: Objective → Criterion. Milestones are not modeled; grouping headings are inert. `Depends:` is advisory only — never a gate.
- A charter with no criteria is open-ended: `complete` is never legal; it runs until pause/abandon.
- Staleness is computed and global (sequence-counter order, per tool call — never per turn): a stale `pass` Status is advisory in status/Ralph and hard-rejected at `complete`. There is no per-criterion freshness flag.
- The agent is the smart-Ralph loop driver. Do not add an auto-spawn scheduler. Ralph reprompts are condensed one-liners; `status` stays terse.
- The charter records evidence; it does not run checks (ADR-0013). Evidence doctrine (taught, not gated): use it like a user (screenshot/recording in `work/`) > observe the real system > run tests. Artifacts are captured at verification time, never retroactively for the report.
- REPORT.md is curation, not creation: scaffolded at first `complete` attempt, pre-populated from charter.md; artifact links are encouraged, not code-gated.
- One active charter per session; `create` while one is active fails with a pointer to it.
- Tactical turn-to-turn todos stay in `pi-dag-tasks`; pi-charter only subscribes to hook events if needed.
- No `contractPath`, no `--charter-spec`, no spec auto-detect, no spec copy heuristic. No budgets (bound by the host session; revisit with the planned CLI extraction).

## Implementation guidance

- Lift from v1 only proven extension plumbing: TypeBox schemas, atomic temp-file writes, lazy state loading, reminder event shape, status widget basics, and command parsing.
- Replace v1 static reminders with deterministic Ralph steering.
- Status is the single `Status: pending|in-progress|blocked|pass|fail — <note>` line in charter.md; pass/fail notes carry evidence and the journal keeps history. Existing `Evidence:` lines are accepted only as a legacy input alias. The v3 structured entry schema and the older typed `kind`/`verdict`/`observation` envelope are rejected.
- Charter ids are `<YYYYMMDD-HHMMSS>-<slug>` (ADR-0014); do not use UUIDs or v1 hash ids.
- The parser is tolerant: unknown structure is inert prose, breakage is a warning, never a work blocker.
- The `create` scaffold template teaches the whole grammar, richer authoring guidance, and evidence doctrine in HTML comments, with example criteria inside a comment (zero live placeholders).
- Use Pi extension APIs from `docs/reference/pi-docs/extensions.md` and live installed docs if in doubt.
- Before editing runtime code, inspect the relevant docs and v1 reference. Keep changes surgical.

## Verification

At minimum before handoff:

```bash
bun run check-types
bun test
```

If tests are not yet present, state that clearly and run `bun run check-types` once dependencies are installed.
