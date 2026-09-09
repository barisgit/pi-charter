# Architecture

## Boundary

pi-charter is a Pi extension for durable Objective-led work. The worker is the loop driver and completion judge. The extension persists lifecycle and authored Markdown, journals meaningful file changes, projects status, triggers Ralph when idle, applies the bounded Ralph guard, and produces the report surface.

It does not turn the Objective into acceptance criteria, plan tasks, run verification, enforce evidence freshness, or dispatch workers.

## Layers

1. **Authored charter** — `.charters/<id>/charter.md` contains a substantial Objective, optional References and Scope, and lightweight Phases.
2. **Domain parser** — `src/domain/charter-file.ts` parses the known headings and ordered phase items tolerantly. Unknown Markdown remains inert prose.
3. **Application service** — lifecycle actions, status projection, report generation, whole-file change journaling, and completion-hook coordination.
4. **Infrastructure** — atomic file writes, timestamp-sortable ids, state/event persistence, and read-only legacy loading.
5. **Registration** — tool and slash-command wiring, Ralph idle continuation, and the rolling guard.
6. **UI** — compact current-charter projection and a dashboard that also renders legacy charters read-only.

## Runtime flow

New charters use `schemaVersion: "phases"`. At a relevant boundary, the runtime re-reads `charter.md`. An optional whole-file `snapshotHash` can identify a meaningful authored change for journaling. There are no criterion snapshots, status sequences, source-change sequences, or computed freshness checks.

When the root worker and async subagents are idle, Ralph may send a continuation. Registration owns a rolling activation guard shared by normal and recovery sends. It never starts a worker and never kills unrelated jobs.

On completion, the worker audits the full Objective and external References and supplies a concise note. The service generates REPORT.md when needed, preserves an already curated report, invokes `charter:before_complete`, and completes if the hook allows. Phase statuses do not gate completion.

## Boundaries that should stay deep

- `charter.md` owns the authorized outcome and the human-readable account of the work.
- The Objective is the completion contract. It may gain only user-authorized constraints, verification expectations, and report requirements.
- Phases explain progress; pi-dag-tasks owns tactical execution steps.
- `state.json` owns lifecycle/session mechanics and optional whole-file/Ralph guard state, never a second progress model.
- `events.jsonl` owns append-only history.
- REPORT.md owns the reviewable, artifact-rich delivery narrative.
- Legacy `file-interface` charters are display inputs only. No write path accepts them.

See ADR-0016.
