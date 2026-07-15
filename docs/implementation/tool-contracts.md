# Tool and projection contracts

## LLM tool

There is one tool:

```ts
charter({
  action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon",
  id?: string,
  objective?: string,
  note?: string,
})
```

Every success and domain error carries `nextActions[]`.

| Action | Required input | Effect |
|---|---|---|
| `create` | `objective` | Creates and session-binds a new active charter. |
| `list` | none | Lists project charters. |
| `status` | optional `id` | Returns lifecycle, rich authored sections, criteria, unified status counts, blockers, readiness, staleness, warnings, and report presence. |
| `pause` | optional `id`, optional `note` | Active to paused. |
| `resume` | optional `id` | Paused to active and binds current session. |
| `complete` | optional `id`, optional `note` | Scaffolds report first; then completes only when all gates pass. |
| `abandon` | optional `id`, required `note` | Active/paused to abandoned. |

`id` may be a full id, unique prefix, or unique slug fragment. Session binding resolves omitted ids when unambiguous.

## Criterion status projection

```ts
type CriterionStatus = "pending" | "in-progress" | "blocked" | "pass" | "fail";

interface CriterionStatusView {
  id: string;
  title: string;
  body: string;
  status: CriterionStatus;
  note: string;
  stale: boolean;
  depends: string[];
  failCount: number;
}
```

There is no parallel evidence field. A pass/fail note is the evidence record. Legacy authored Evidence lines and old sidecars/journal fields are normalized at input boundaries only.

## UI projections

- Terse `status` text gives lifecycle, five-way counts, criterion summaries, blockers, ready-next ids, and legal next actions.
- The compact widget shows pass/active/pending progress and prioritizes `in-progress`, then `blocked`, `fail`, and `pending` as current/next work.
- `/charters` renders Objective, References, Scope, full criterion bodies, dependencies, statuses, notes, staleness, recent status changes, and terminal reports.

## Ralph

Ralph emits a condensed steering message from the same status projection: counts, top blocker, stale passes, repeated failures, and the next criterion. It never spawns a scheduler or runs checks.
