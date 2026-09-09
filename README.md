# pi-charter

`pi-charter` keeps a substantial user Objective in view during durable agent work. The worker edits one Markdown file, adds lightweight Phases as the work emerges, captures useful verification artifacts, and curates an artifact-rich report. The extension owns persistence, lifecycle, projections, and Ralph continuation. It does not plan the work, run verification, or decide completion from a checklist.

ADR-0016 and `CONTEXT.md` define the current model.

## Current architecture

- One LLM-callable tool: `charter`.
- Seven actions: `create`, `list`, `status`, `pause`, `resume`, `complete`, and `abandon`.
- Four lifecycle states: `active`, `paused`, `completed`, and `abandoned`.
- One authored interface: `.charters/<id>/charter.md`.
- A substantial `# Objective`, optional References and Scope, and emergent Phases.
- No criteria, per-phase evidence schema, dependencies, freshness, phase gate, artifact quota, or auto worker scheduler.
- Completion is worker judgment after auditing the Objective and references, with a concise note, a curated report, and approval from the existing before-complete hook.
- Old `file-interface` charters remain visible in the dashboard as read-only history. They cannot resume or mutate.

## Workspace layout

```text
.charters/<YYYYMMDD-HHMMSS>-<slug>/
├── charter.md
├── state.json
├── events.jsonl
├── work/
└── REPORT.md
```

`charter.md` is the authored Objective and phase narrative. `state.json` stores lifecycle/session data and optional whole-file snapshot and Ralph guard state. `events.jsonl` is append-only history. `work/` holds artifacts captured during verification. `REPORT.md` curates the delivered result and those artifacts.

## Authoring grammar

```md
# Objective

<authorized outcome, constraints, verification expectations, and report requirements>

## References

<optional durable sources of authority and their roles>

## Scope

<optional boundaries>

## Phases

1. Explore phases
2. Implement — current
   Work and progress notes.
3. Verify — upcoming
```

Every new charter begins with exact `1. Explore phases`. Phase suffixes are optional and, when present, use `— upcoming`, `— current`, or `— done`. Indented Markdown belongs to the phase body. If no phase is explicitly current, the initial bare phase or first unfinished unmarked phase is current by inference; other unmarked phases are upcoming.

Phases communicate progress. They are not acceptance criteria or completion gates, and there is no required count. A charter may complete with zero phases.

## Tool surface

```ts
charter({
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon",
  id?,
  objective?,
  note?,
})
```

Use `objective` for `create`. Omit `id` for the session-bound charter, or provide a full id, unique prefix, or unique slug fragment. `abandon` requires a note. Follow `nextActions[]` rather than inferring legal transitions.

## Slash commands

- `/charter` — show the session-bound charter.
- `/charter <id-fragment>` — show a charter.
- `/charter create <objective>` — create and bind a phases charter.
- `/charter list` — list charters.
- `/charter status` — show current status.
- `/charter pause [note]` — pause.
- `/charter resume` — explicitly resume as the user; after a Ralph guard pause, this is the only reset path.
- `/charter complete [note]` — complete with the worker's concise reason.
- `/charter abandon <note>` — abandon.
- `/charters` — open the read-only dashboard and picker.

The current runtime registers no pi-charter CLI flags.

## Verification and reporting

The worker chooses verification that fits the Objective. For user-visible behavior, exercise the real flow and capture screenshots or recordings at verification time under `work/`. Link useful artifacts from the relevant phase body:

```md
3. Verify — current
   - Desktop recovery: [screenshot](work/recovery-desktop.png)
   - Mobile recovery: [recording](work/recovery-mobile.mp4)
```

Inspect artifacts before citing them. Do not create artificial screenshots at report time and do not treat artifact counts as proof. REPORT.md should explain what changed, why it meets the Objective, and what the captured evidence shows. An already curated report survives completion.

## Ralph guard

Ralph sends continuation only when the root worker and async subagents are idle. Within a rolling 15-minute window, the fifth actual send becomes a recovery prompt. If the next eligible activation arrives at or before the 5-minute warning boundary, the runtime pauses before sending. Quiet expiry does not cause a timed pause. Compaction and file edits do not reset history. After a guard pause, only explicit user `/charter resume` clears the warning and history; tool resume cannot bypass it. The guard does not kill unrelated jobs.

## Documentation map

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Current domain language and boundaries. |
| `docs/adr/0016-objective-and-emergent-phases.md` | Current cross-cutting design decision. |
| `docs/implementation/` | Current runtime and API contracts. |
| `skills/pi-charter/SKILL.md` | Worker workflow and authoring guidance. |
| `docs/adr/0014-file-as-interface-redesign.md` | Historical one-file redesign, superseded in part. |
| `docs/adr/0015-unify-criterion-status-and-evidence.md` | Historical criterion model, superseded. |

## Development

```bash
bun run check-types
bun test
```

The package is private (`"private": true`).
