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
| `create` | `objective` | Creates and session-binds a new active phases charter. |
| `list` | none | Lists current and legacy project charters. |
| `status` | optional `id` | Returns the Objective/Phase projection or a read-only legacy projection. |
| `pause` | optional `id`, optional `note` | Active to paused. |
| `resume` | optional `id` | Paused phases charter to active, except guard-paused state. Tool resume cannot clear that guard. |
| `complete` | optional `id`, optional `note` | Accepts the worker's completion decision, invokes the hook, then generates or preserves the report and completes if allowed. Worker guidance calls for a concise audit note. |
| `abandon` | optional `id`, required `note` | Active or paused to abandoned. |

`id` may be a full id, unique prefix, or unique slug fragment. Session binding resolves omitted ids when unambiguous. Explicit user `/charter resume` is a distinct registration path because only it may clear a Ralph guard pause. An ordinary pause/resume while only a recovery warning is pending retains that warning and its rolling history; the reset applies after the guard actually pauses the charter.

## Authored file projection

```ts
type PhaseStatus = "upcoming" | "current" | "done";

type Phase = {
  number: number;
  title: string;
  status: PhaseStatus;
  body: string;
};

type ParsedCharterFile = {
  objective: string;
  references: string;
  scope: string;
  phases: Phase[];
  warnings: string[];
};
```

## Status result

`CharterStatusResult` has these fields:

```ts
{
  charterId: string;
  status: "active" | "paused" | "completed" | "abandoned";
  objective: string;
  references: string;
  scope: string;
  phases: Phase[];
  phaseCounts: Record<PhaseStatus, number>;
  createdAt: string;
  warnings: string[];
  reportExists: boolean;
  nextActions: NextAction[];
  legacy: boolean;
  charterMarkdown: string;
  ralph?: {
    activations: number[];
    warnedAt?: number;
    pausedByGuard?: boolean;
  };
}
```

The result does not contain `criteria`, `statusCounts`, `readyNext`, `openEnded`, `blockers`, or staleness fields. `Phase` and `PhaseStatus` are public exports matching this contract.

Legacy `file-interface` state is decoded only far enough to render a read-only dashboard/status view with `legacy: true`. No lifecycle action may write, resume, or migrate it.

## Completion hook

`charter:before_complete` remains a veto point. Its payload contains `charterId`, `ts`, `phaseCount`, and optional `completionNote`; `phaseCount` replaces the removed `criteriaCount` field. The hook runs before report generation or the completed transition. It does not imply that the runtime independently verified the Objective.

## UI projections

- Terse status reports lifecycle, Objective, phase counts/current phase, warnings, and legal next actions.
- The bordered widget presents the short charter slug, lifecycle, current phase, a full-width phase-completion bar without a numeric count, and elapsed wall-clock time since creation (including pauses) beside lifecycle in the top border. The bar fills the entire inner row with one column of padding on each side, with phase detail below it. The bar describes the phase map, not Objective completion. The Objective and phase bodies stay in the dashboard. Ralph countdowns and guard guidance carry the loop icon, as do Ralph message headers.
- `/charters` always renders the full Objective and phase narrative. Legacy charters remain visible and clearly read-only; long content wraps within the scrollable detail pane.
- Custom tool calls and results have one column of horizontal padding, including wrapped lines. Collapsed results show orientation; expanded results preserve the full message or structured status/list details, warnings, and legal next-action hints.
- Ralph messages use Pi's native collapsed/expanded state: a compact header by default, the complete continuation prompt when expanded. Rendering never changes the model-facing tool result or prompt.

## Ralph

Ralph builds continuation from the same status result and the full Objective. It does not run checks, judge completion, or spawn work.

Registration owns the exact shared guard: fifth actual send within rolling 15 minutes is recovery; the next eligible activation at or before 5 minutes pauses before send; quiet expiry does not pause; compaction and edits do not reset; explicit user `/charter resume` clears a guard pause and history; tool resume cannot bypass; unrelated jobs are untouched.
