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
| `list` | none | Lists current and legacy project charters. |
| `status` | optional `id` | Returns the status projection or a read-only legacy projection. |
| `pause` | optional `id`, optional `note` | Active to paused. |
| `resume` | optional `id` | Paused writable charter to active, except guard-paused state. Tool resume cannot clear that guard. |
| `complete` | optional `id`, required `note` | Invokes the hook with the worker's concise completion note and completes if allowed. Never generates or overwrites `REPORT.md`. |
| `abandon` | optional `id`, required `note` | Active or paused to abandoned. |

`id` may be a full id, unique prefix, or unique slug fragment. Session binding resolves omitted ids when unambiguous. Explicit user `/charter resume` is a distinct registration path because only it may clear a Ralph guard pause. An ordinary pause/resume while only a recovery warning is pending retains that warning and its rolling history; the reset applies after the guard actually pauses the charter.

## Authored file projection

```ts
type ParsedCharterFile = {
  objective: string;
  references: string;
  scope: string;
  notes: string;
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
  notes: string;
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

The result contains no phase, criterion, count, staleness, or progress fields, and no empty compatibility shims for them. `Phase` and `PhaseStatus` are not exported.

Legacy `file-interface` state is decoded only far enough to render a read-only dashboard/status view with `legacy: true`. No lifecycle action may write, resume, or migrate it.

## Completion hook

`charter:before_complete` remains a veto point. Its payload contains `charterId`, `ts`, and `completionNote`; there is no phase or criteria count. It does not imply that the runtime verified the Objective.

## UI projections

- Terse status reports lifecycle, Objective, warnings, and legal next actions.
- The widget is one line: the short charter slug and lifecycle, then the Ralph guard warning, guard pause with `/charter resume`, or the pending Ralph countdown when one applies. It has no frame, clock, or progress. It updates on agent tool results, turn ends, and lifecycle changes, including slash commands; only a pending countdown repaints on a timer. Ralph message headers carry the loop icon.
- `/charters` renders the Objective, References, Scope, and remaining authored Markdown as Notes, including old phase lists without interpreting them. Comments are hidden and long content wraps within the scrollable detail pane. Legacy charters show their whole `charter.md` and remain clearly read-only; status also retains the exact authored file in `charterMarkdown`.
- Custom tool calls and results have one column of horizontal padding, including wrapped lines. Collapsed results show orientation; expanded results preserve the full message or structured status/list details, warnings, and legal next-action hints.
- Ralph messages use Pi's native collapsed/expanded state: a compact header by default, the complete continuation prompt when expanded. Rendering never changes the model-facing tool result or prompt.

## Ralph

Ralph is the only model-facing prompt pi-charter sends during work, and only when the root worker and async subagents are idle. It names the charter path and restates the Objective and any References and Scope verbatim, followed by a short instruction to continue or finish. It adds no instruction-hierarchy disclaimer, workflow lecture, evidence, or report instruction. Recovery adds a short guard warning. Ralph does not run checks, judge completion, or spawn work. There is no periodic Objective reminder and no reminder threshold option.

Registration owns the exact shared guard: fifth actual send within rolling 15 minutes is recovery; the next eligible activation at or before 5 minutes pauses before send; quiet expiry does not pause; compaction and edits do not reset; explicit user `/charter resume` clears a guard pause and history; tool resume cannot bypass; unrelated jobs are untouched.
