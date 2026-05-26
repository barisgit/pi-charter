# Tool contracts

pi-charter uses four grouped tools. Schemas should be strict and action-specific; every result should include `nextActions[]`.

## Common result envelope

```ts
interface CharterToolResult<T = unknown> {
  charterId?: string;
  status?: CharterStatus;
  message: string;
  data?: T;
  nextActions: Array<{
    tool: "charter_manage" | "charter_plan" | "charter_record" | "charter_status";
    action?: string;
    hint: string;
  }>;
}
```

## `charter_manage`

Lifecycle FSM and charter-level mutations.

Actions:

| Action | Required payload | Notes |
|---|---|---|
| `create` | `objective` | Optional `budget`, `idempotencyKey`. Creates `state.json`; planning still authors `charter.md`. |
| `pause` | optional `reason` | Non-terminal interruption. |
| `resume` | optional `charterId` | Rebinds current session when needed. |
| `amend_charter` | `rationale`, `patch` or `replacementSections` | Runs `charter:before_amend_charter`; invalidates stale evidence where needed. |
| `complete` | optional `completionNote` | Only succeeds after criteria/evidence/hooks pass. |
| `force_complete` | `reason` | Escape hatch; runs `charter:before_force_complete`. |

Create signature:

```ts
charter_manage({
  action: "create",
  objective: string,
  budget?: { tokens?: number; wallclockMs?: number; turns?: number },
  idempotencyKey?: string,
})
```

Explicitly absent: `contractPath`, `charterPath`, `specPath`, `autoApprovePlan`, `completionMode`, `planDraft`, `contractDraft`.

## `charter_plan`

Planning and macro-DAG operations.

Actions:

| Action | Required payload | Notes |
|---|---|---|
| `view` | optional `charterId` | Returns current plan, coverage, and drift. |
| `add_feature` | `id`, `milestone`, `order`, `fulfills`, `body` | Writes `plan/<featureId>.md`; no runtime status in frontmatter. |
| `update_feature` | `id`, patch fields | Use for body/frontmatter edits, not status flips. |
| `lock_plan` | none | Runs planner-critic checks then `charter:before_lock_plan`. |

Recommended first implementation may omit `add_feature`/`update_feature` as separate actions if the agent writes markdown directly and `charter_plan({action:'view'})` recomputes `plan.json`; keep the names reserved.

## `charter_record`

Execution-time writes.

Actions:

| Action | Required payload | Notes |
|---|---|---|
| `evidence` | `criterionId`, `kind`, `verdict`, `observation` | Appends evidence file and recomputes criterion/feature state. |
| `verify` | optional `criterionIds`, `featureId` | Runs configured verifiers where possible. |
| `handoff_apply` | `handoff` or `handoffPath` | Applies subagent handoff envelope and extracted evidence. |

Evidence should never be edited in place. Corrections are new records.

## `charter_status`

Read-only tool.

```ts
charter_status({ verbose?: boolean, charterId?: string })
```

Return shape:

```ts
{
  charterId: string;
  status: CharterStatus;
  phase: "planning" | "active" | "review" | "terminal";
  objective: string;
  budget?: BudgetState;
  drift: {
    uncovered: unknown[];
    stuck: unknown[];
    stale: unknown[];
    readyNext: unknown[];
    milestoneDebt?: unknown[];
  };
  guidelines: string[];
  nextActions: Array<{ tool: string; action?: string; hint: string }>;
}
```

## `nextActions[]` rule

The tool result is the lifecycle guide. If status is `planning`, suggest planning/lock actions; if `active`, suggest implement/record/verify/status; if `review`, suggest complete or amend; if terminal, suggest status/resume/new only where valid.

## Slash command surface

- `/charter` — open widget/TUI/status.
- `/charter <objective>` — shortcut to create.
- `/charter status`
- `/charter ls`
- `/charter resume <id>`
- `/charter pause`
- `/charter force-complete`

## CLI flags

Registered via `pi.registerFlag()`:

- `--charter-objective "<text>"`
- `--charter-resume <id>`

No positional extension CLI API is assumed.
