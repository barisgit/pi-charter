# v1 pi-goals reference

The old v1 `pi-goals` extension has been moved here for reference.

Path:

```text
docs/reference/v1-pi-goals/pi-goals/index.ts
```

## Useful patterns to lift

- Atomic JSON writes via temp file + rename.
- Lazy `ensureState(ctx)` loading and path resolution.
- `PI_GOALS=off|path|relative|name` style env override, adapted as `PI_CHARTER` only if needed.
- TypeBox + `StringEnum` schemas for tool parameters.
- `textResult()` helper returning `{content, details}`.
- Reminder bus integration via `reminder:upsert` / `reminder:remove`.
- Status widget via `ctx.ui.setStatus`.
- Command parsing pattern for a single slash command with subcommands and positional shortcut.
- `pi.appendEntry(customType, data)` for branch-aware audit entries.

## Do not carry over

- Static every-8-turn reminder text.
- Flat `criteria[]`, `evidence[]`, and `nextAction` string fields as the whole model.
- Self-attested `complete` with no verifier/evidence gate.
- Single file state layout under `.pi/goals/`.
- Hash-based short ids; use UUIDs.
- `goal_*` names or v1 `GoalState` terminology.

See `CONTEXT.md` and `docs/implementation/` for the replacement model.
