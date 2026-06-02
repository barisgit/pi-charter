# Tool contracts

pi-charter registers three LLM-callable tools. Schemas are strict and action-specific; lifecycle and status results include `nextActions[]` so agents can follow legal transitions without memorizing the FSM.

## Common result envelope

```ts
interface CharterToolResult<T = unknown> {
  charterId?: string;
  status?: CharterStatus;
  message: string;
  data?: T;
  nextActions: Array<{
    tool: "charter" | "charter_record" | "charter_status";
    action?: string;
    hint: string;
  }>;
}
```

`CharterStatus` is the four-state runtime FSM: `"active" | "paused" | "completed" | "abandoned"`. Charters are created `active`; there is no planning, review, or budget-limited live state. Legacy persisted state names are normalized for compatibility only.

## `charter`

Lifecycle FSM and charter-level mutations.

Actions:

| Action | Required payload | Notes |
|---|---|---|
| `create` | `objective` | Optional `name`, `budget`, `idempotencyKey`. Creates the charter workspace in `active` state and writes initial `charter.md`, `criteria.md`, sidecars, and index entries. |
| `pause` | none | Non-terminal interruption; optional `reason` is accepted. |
| `resume` | optional `charterId` | Only legal from `paused`; rebinds the current session when available. |
| `complete` | optional `completionNote` | Only legal from `active`; succeeds after completion gates and `charter:before_complete` pass. |
| `abandon` | `reason` | Legal from non-terminal states; requires a non-empty reason and runs `charter:before_abandon`. |

Create signature:

```ts
charter({
  action: "create",
  objective: string,
  name?: string,
  budget?: { tokens?: number; wallclockMs?: number; turns?: number },
  idempotencyKey?: string,
})
```

Explicitly absent: `contractPath`, `charterPath`, `specPath`, `autoApprovePlan`, `completionMode`, `planDraft`, `contractDraft`, `amend_charter`, and `force_complete`. `forceCompleteCharter()` and `amendCharter()` still exist as deprecated service exports, but they are unwired vestiges and are not tool actions.

## `charter_record`

Append-only execution writes. Charter records evidence produced by the agent or a subagent; it does not execute commands, run verifier personas, or dispatch subagents.

Actions:

| Action | Required payload | Notes |
|---|---|---|
| `evidence` | exactly one of `entries` or `evidenceFile` | Appends flat evidence rows under `work/<feature-or-_charter>/evidence/<stamp>/evidence.json` and recomputes `criterion-state.json`. |

Batch signature:

```ts
charter_record({
  action: "evidence",
  charterId?: string,
  entries: Array<{
    criterionId: string,
    featureId?: string,
    outcome: "pass" | "fail" | "partial",
    summary: string,
    source?: "manual" | "verifier" | "subagent", // omitted defaults to manual
    because?: string, // required when source is manual
    artifacts?: string[],
    details?: Record<string, unknown>, // e.g. { command, exitCode, stdout }
  }>,
})
```

File-import signature:

```ts
charter_record({
  action: "evidence",
  charterId?: string,
  evidenceFile: string,
})
```

Imported files use the same flat evidence shape plus `ts` and optional display/import fields such as `recordedBy`, `narrativePath`, and `verifier`. Legacy typed evidence with `kind: "command" | "review" | "qa" | "readiness"` is rejected. Evidence is never edited in place; corrections are new records.

## `charter_status`

Read-only status and guidance tool.

```ts
charter_status({ verbose?: boolean, charterId?: string })
```

Return shape:

```ts
{
  charterId: string;
  name?: string;
  status: "active" | "paused" | "completed" | "abandoned";
  objective: string;
  budget?: Budget;
  drift: {
    uncovered: Array<{ criterionId: string; reason: "no-evidence" | "non-pass" }>;
    stale: Array<{ criterionId: string; reason: "src-change" | "age-window"; lastTs: string; ageMs: number }>;
    readyNext: Array<{ criterionId: string; milestoneId: string }>;
    sidecarDrift?: Array<{ path: string; lastToolWriteAt: string; fileMtimeMs: number }>;
    milestoneArtifacts?: Array<{ milestoneId: string; reason: "no-artifact-capture" }>;
  };
  milestones: Array<{ milestoneId: string; title: string; criterionIds: string[]; valCount: number; valPassCount: number }>;
  valTotal: number;
  valPass: number;
  registerEmpty: boolean;
  guidelines: string[];
  details?: { blockingForComplete: Array<{ criterionId?: string; reason: string; outcome?: string; lastEvidencePath?: string }> };
  qaBriefs: string[];
  commands: Record<string, string>;
  parseWarnings: unknown[];
  nextActions: Array<{ tool: "charter" | "charter_record" | "charter_status"; action?: string; hint: string }>;
}
```

`drift.uncovered` names VALs without pass evidence, `drift.stale` names `requireFreshEvidence` VALs whose pass evidence predates the latest `src/` change, and `drift.readyNext` is the first non-pass VAL advisory in declaration order. There is no feature-level `stuck` or `milestoneDebt` drift.

## Completion gate

`charter action=complete` passes only when every parsed VAL has pass evidence, `requireFreshEvidence` VALs have fresh pass evidence, `REPORT.md` has non-empty content under every required heading, and `charter:before_complete` allows the transition. `blockingForComplete` blocks on latest non-pass evidence and on `source: manual` pass evidence without `because`; `source`, `recordedBy`, and `requireReviewSubagent` are otherwise display/provenance fields, not trust-rank or identity-disjoint gates.

## `nextActions[]` rule

The tool result is the lifecycle guide. For `active`, suggest status, evidence recording, pause, complete, and abandon as appropriate. For `paused`, suggest resume, status, or abandon. For terminal `completed`/`abandoned`, suggest status inspection only. Do not emit planning, lock-plan, review, amend, force-complete, or verify actions.

## Slash command surface

- `/charter` — prints a usage hint; it does not open or mutate a charter directly.
- `/charter <objective>` — sends the objective to the agent with instructions to read referenced material, create a charter via the `charter` tool, author `charter.md`/`criteria.md`, record evidence, and complete when gates pass.
- `/charters` — opens the charter picker when UI is available, or lists active charter ids.
- `/charters list`
- `/charters status`
- `/charters pause`
- `/charters resume`
- `/charters select <charterId|none>`

There is no `/charter force-complete` command.

## CLI flags

Registered via `pi.registerFlag()`:

- `--charter-objective "<text>"`
- `--charter-resume <id>`

No positional extension CLI API is assumed.
