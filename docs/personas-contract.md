# pi-charter persona contract

pi-charter v2 resolves persona roles through `.pi/charter/charter-config.json`:

```json
{
  "personas": {
    "plannerCritic": "charter-planner-critic",
    "reviewer": "charter-reviewer",
    "qa": "charter-qa",
    "readinessProbe": "charter-readiness-probe"
  }
}
```

Role enum: `plannerCritic | reviewer | qa | readinessProbe`.

## Shared task prompt fields

Every BYOA persona must accept a task prompt containing:

- `charterId`
- relevant `featureId` or `milestoneId`
- `specPath` or QA brief paths
- optional `priorEvidencePath`
- enough feature context or diff/probe details to make an evidence decision

## Typed evidence outputs

Personas write JSON evidence and record it with `charter_record action=evidence` when evidence-file recording is available.

- `plannerCritic`: structured critique with `verdict: "PASS" | "BLOCK" | "ADVISORY"` and `findings[]` containing `severity`, `category`, `summary`, and `evidence`.
- `reviewer`: `review.json` with `kind: "review"`, `outcome`, `blocking[]` file/line findings, `notes[]`, and `artifacts[]`.
- `qa`: `qa.json` with `kind: "qa"`, `outcome`, `briefs[]`, `checks[]`, `screenshots[]`, and `discovered[]`.
- `readinessProbe`: `readiness.json` with `kind: "readiness"`, `outcome`, `probe`, `result`, `fallbackApplied`, and `artifacts[]`.

Overrides point at any pi-subagents agent name that follows the same prompt and evidence contract.
