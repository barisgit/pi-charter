# Dumb-smart charter loop (archived design exploration)

This directory holds the archived design exploration that led to ADRs 0008 and 0009.
It is not the current architecture and must not be treated as a spec.

## What this is

`dumb-smart-charter-loop.html` is a self-contained explainer drafted while
deciding how much of the pi-charter execution loop should live in Markdown
versus runtime code. It walks through the candidate adaptive checkpoint loop
(plan / clarify / lock / orient / set checkpoint / execute / inspect / decide /
next checkpoint / replan / complete / give-up), the proposed doctrine tree,
and the reminder vs. Ralph distinction.

The exploration concluded that a Markdown-defined FSM or doctrine tree is
redundant given the existing tool surface and would create a parallel
workflow language. The HTML preserves the reasoning that led there.

## What is canonical instead

- `docs/adr/0008-loop-doctrine-and-runtime-boundary.md` — code owns lifecycle / nextActions / gates / Ralph; Markdown carries doctrine and persona behavior only; milestones first-class in status; VALs are the only contract.
- `docs/adr/0009-remove-charter-evaluator-prefer-deterministic-ralph.md` — `charter-evaluator` removed; deterministic Ralph drives continuation; Ralph never self-stops.
- `CONTEXT.md` — updated domain language (Checkpoint, Reminder, Ralph reprompt, Replan, Milestone).
- `skills/pi-charter/SKILL.md` — execution-loop doctrine and stuck handling (updated as part of the charter that implements the ADRs above).

If the HTML and the canonical docs disagree, the canonical docs win.
