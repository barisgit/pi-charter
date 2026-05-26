# pi-charter design showcase (archived research)

`showcase.html` is pre-ADR research material from the May 2026 v2 design pass.
It is preserved to show the design exploration, but it is not canonical.

Canonical sources now live in:

- `CONTEXT.md`
- `docs/adr/0008-loop-doctrine-and-runtime-boundary.md`
- ADR 0009 (deterministic Ralph replaces the removed separate-model supervisor)
- `skills/pi-charter/SKILL.md`

If this showcase conflicts with those files, the canonical files win. In
particular, ADR 0009 removed the old separate-model supervisor idea; current
continuation is deterministic Ralph output from `charter_status` and the main
agent decides whether to continue, pause, abandon, or complete.
