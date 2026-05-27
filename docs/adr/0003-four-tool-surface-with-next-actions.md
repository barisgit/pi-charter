# Use four grouped LLM tools with nextActions

Status: superseded by ADR-0011

pi-charter exposes four LLM-callable tools: `charter_manage`, `charter_plan`, `charter_record`, and `charter_status`. A single giant `manage({action, ...payload})` schema would be hard for agents to scan, while twelve narrow tools would bloat the tool surface; four tools group actions by cognitive shape and every return carries `nextActions[]` so the agent follows the FSM from tool output instead of memorizing docs.

## Superseded

With features/macro-DAG/handoffs/planning-state removed in v3, `charter_plan` has nothing to do and `charter_manage` shrinks to lifecycle (create/pause/resume/complete/abandon). See ADR-0011 for the v3 three-tool surface.
