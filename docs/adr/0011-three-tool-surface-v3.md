# Three-tool surface for pi-charter v3

Status: accepted; supersedes ADR-0003

pi-charter v3 exposes three LLM-callable tools grouped by mutation category:

- `charter` — lifecycle: `create`, `pause`, `resume`, `complete`, `abandon`
- `charter_record` — write: `evidence` (manual or batch), `verify` (run a `## Commands` entry, stamp result)
- `charter_status` — read

Every return carries `nextActions[]`.

## Why three, not four (and not one)

- `charter_plan` from ADR-0003 has nothing to do: features.md is gone, `lock_plan` is gone, plan editing is direct file writes on `charter.md` / `criteria.md`.
- `charter_manage` is renamed to `charter` since it now owns the full lifecycle surface and is the only mutator outside `charter_record`.
- Collapsing to a single tool would widen the action enum to ~8 entries and mix audit categories (read vs append-only write vs FSM transition). The category split keeps audit logs clean and the per-tool schemas narrow.

## What changed from v2.3

- `lock_plan` action — gone (no planning state, validation on every read)
- `force_complete` action — gone (use `abandon` with reason)
- `amend_charter` action — gone (direct edits to charter.md / criteria.md)
- `ask` action — gone (use `pause` with reason)
- `handoff` / `handoff_apply` actions on charter_record — gone (no handoff store)
- `add_feature` / `update_feature` actions on charter_plan — gone (no features)
- `lock_plan` action on charter_plan — gone
- `view` action on charter_plan — gone (status surface covers it)
