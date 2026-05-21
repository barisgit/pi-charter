# Require manual replan for v1-shaped charters

Status: accepted

pi-charter v2 treats existing v1-shaped charter directories as incompatible rather than silently migrating them. A charter is v1-shaped when `charter.md` contains a `## Criteria` section with `### VAL-*` headings and `criterion-state.json` exists. On load, the runtime marks the in-memory charter state as `schemaVersion: "v1-needs-replan"`.

Mutating plan, record, and normal completion actions refuse with `migration.replan_required`. `charter_status` points agents to `charter_manage action=amend_charter` and `docs/v1-to-v2-migration.md`, or to `force_complete` if the work should be abandoned. This avoids destructive or lossy automatic conversion while preserving the on-disk v1 files for manual porting.
