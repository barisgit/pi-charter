# pi-charter

`pi-charter` is a Pi extension for durable, charter-bound agent work. It owns the charter contract, lifecycle, evidence record, artifacts, and final report; it does not choose or run a verifier.

The live implementation is the source of truth. `src/index.ts` is the composition root, `CONTEXT.md` defines the domain language, and `docs/adr/0014-file-as-interface-redesign.md` records the current architecture.

## Current architecture

- One LLM-callable tool: `charter`.
- Seven actions: `create`, `list`, `status`, `pause`, `resume`, `complete`, and `abandon`.
- Lifecycle states: `active`, `paused`, `completed`, and `abandoned`.
- One authored interface: `.charters/<id>/charter.md`.
- Flat `### C<n>.` criteria with in-place `Evidence: pass|fail|none — <note>` lines.
- Optional `Depends: C1, C2` lines are advisory ordering only.
- Completion requires pass evidence with non-empty notes for every criterion, no stale pass evidence, an existing `REPORT.md`, and approval from the before-complete hook; the root agent curates the report as doctrine.
- A charter with no criteria is open-ended and cannot complete; it runs until criteria are added, or the charter is paused or abandoned.

Earlier multi-file, multi-tool, milestone-based architecture and legacy runtime paths are unsupported and are not read.

## Workspace layout

Each charter lives under the project root:

```text
.charters/<id>/
├── charter.md    # objective, flat criteria, and current Evidence lines
├── state.json    # current lifecycle/session binding and parser snapshot state
├── events.jsonl  # append-only evidence, source-change, and lifecycle history
├── work/         # verification artifacts, created as needed
└── REPORT.md     # scaffolded on the first completion attempt, then curated
```

`charter.md` is the content interface and current evidence record. `state.json` carries runtime state, `events.jsonl` carries history, `work/` carries screenshots/recordings/output, and `REPORT.md` is the reviewable deliverable.

## Tool surface

```ts
charter({
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon",
  id?,
  objective?,
  note?,
})
```

Use `objective` for `create`. Omit `id` to address the session-bound charter; provide an id, unique prefix, or unique fragment to address another charter. `abandon` requires a note. Follow the returned `nextActions[]` rather than inferring legal transitions.

## Slash commands and flags

The registered slash commands are:

- `/charter` — show status for the session-bound charter.
- `/charter <id-fragment>` — show status for that charter.
- `/charter create <objective>` — create and bind a charter.
- `/charter list` — list charters.
- `/charter status` — show status for the session-bound charter.
- `/charter pause [note]` — pause the session-bound charter.
- `/charter resume` — resume the session-bound charter.
- `/charter complete [note]` — attempt completion.
- `/charter abandon <note>` — abandon the charter.
- `/charters` — open the charter picker/dashboard.

The current runtime registers no pi-charter CLI flags.

## Verification ownership

pi-charter is verifier-agnostic. The charter-owning root agent defines durable assertions in `charter.md`, chooses any appropriate verification mechanism, and supplies an external verifier only the assertion, relevant context, and artifact destination under `.charters/<id>/work/`.

The external verifier returns its result and artifact paths. The charter-owning root inspects those artifacts, decides what they prove, and writes the Evidence line. External verifiers do not own `charter.md`, `REPORT.md`, or lifecycle transitions.

A failed verification ends that verification pass, not the charter lifecycle. The charter remains active unless explicitly paused or abandoned; record the failure when useful, fix the work, and run a new verification pass.

## Documentation map

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Current domain language and boundaries. |
| `docs/adr/0014-file-as-interface-redesign.md` | Accepted file-as-interface architecture; supersedes earlier multi-file/tool decisions. |
| `docs/adr/` | Decision history and supersession context. |
| `skills/pi-charter/SKILL.md` | Agent workflow for owning a charter. |
| `src/index.ts` | Live extension composition root. |

## Development

```bash
bun run check-types
bun test
```

The package is private (`"private": true`).
