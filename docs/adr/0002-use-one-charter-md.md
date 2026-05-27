# Use one charter.md as the authored source of truth

Status: superseded by ADR-0010

The authored charter file is `charter.md` with three sections: Objective, Criteria, and Scope and constraints. Earlier drafts split this into `mission.md` plus `contract.md`, but that made the user and agent manage two documents for one conceptual artifact; one file keeps the surface simple while sidecar JSON files hold mutable runtime state.

## Superseded

The Criteria section was extracted into a sibling `criteria.md` file in v2.3 (commit 96f0248). The two-file split earns its keep because runtime sidecars index criteria by stable `VAL-*` id, the planner-critic gates target the criteria register independently, and authors editing criteria are editing the contract — making it a separate file forces a deliberate edit. See ADR-0010 for the current authored-file layout.
