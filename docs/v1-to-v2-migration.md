# v1 to v2 charter migration

pi-charter v2 intentionally does not rewrite existing v1 charter directories.

A v1-shaped charter is detected when `charter.md` still has a `## Criteria` section with `### VAL-*` entries and `criterion-state.json` exists. When detected, tools report `migration.replan_required` for mutating plan/record/complete actions.

Recommended path:

1. Run `charter_status` and confirm the migration hint.
2. Run `charter_manage` with `action: "amend_charter"` and `target: "planning"` to start a manual replan.
3. Port the old VAL criteria into the v2 plan shape manually, using per-feature validation checks and typed evidence where applicable.
4. Re-lock the plan after the rewritten charter and plan are internally consistent.

If the charter should not continue, use `charter_manage action=force_complete` with a reason instead of replanning.
