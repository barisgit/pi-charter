# Research archive

This directory contains the research and brainstorming corpus that led to `pi-charter`.

## Primary archive

`2026-05-14-pi-charter-design/`

| File | Use |
|---|---|
| `v2-brainstorm.md` | Main design archive; broadest source for lifecycle, persistence, tools, evaluator, and rename decisions. |
| `orchestration-layering.md` | Relationship between pi-charter, pi-subagents personas, internal personas, and workflow layering. |
| `showcase.html` | Visual showcase with Mermaid diagrams and comparison charts. Mermaid 10.9.6 parser has been verified against all blocks. |
| `report.md` | Original comparison report across Codex, Claude Code, Factory Droid, and v1 goals. |
| `codex-digest.md` | Codex `/goal` and `update_plan` digest. |
| `claude-code-digest.md` | Claude Code goals/plans/hooks digest. |
| `factory-digest.md` | Factory Missions public docs digest. |
| `factory-mission-fact.md` | FACT-level inventory of a real local Factory mission directory. Do not rename its Factory-specific `mission.md`/`validation-contract.md` vocabulary. |
| `v2-validation-pass/report.md` | Deep validation pass, naming collision check, and `pi-charter` recommendation. |
| `v2-validation-pass/sources.md` | Audited source list. |

## Naming caution

`pi-missions` and `pi-quests` are taken by live Pi extensions. Keep `pi-charter` unless a fresh collision/trademark check finds a blocker.

## How to use this archive

Use `CONTEXT.md` and ADRs for canonical current decisions. Use this archive only when you need provenance, alternatives, or implementation detail not yet promoted into `docs/implementation/`.
