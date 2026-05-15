---
date: 2026-05-14
slug: goal-tracking-comparison
author: Claude (main)
---

# Research Brief — Goal/Mission Tracking Across Coding Agents

```yaml
main_question: |
  I want to understand how OpenAI Codex CLI, Anthropic Claude Code, and Factory Droid
  represent, persist, surface, and verify long-horizon goals/missions/plans inside the
  agent loop, so we can identify the concrete capability gaps in the existing local
  pi-goals extension (single durable goal, ephemeral reminder, no autonomy controls).

sub_questions:
  - "How does Codex (CLI + ChatGPT Codex cloud) represent a goal/plan? Is there an 'update_plan'/plan-mode tool, AGENTS.md guidance, sandbox/approval policy tied to it, and how is it persisted/surfaced across turns?"
  - "How does Claude Code structure planning and goals? TodoWrite tool, ExitPlanMode/plan mode, subagents, hooks, settings, output-style mechanics — what is the durable layer vs the per-turn layer?"
  - "What are Factory Droid 'Missions' — definition, lifecycle (spec → execute → review), autonomy levels, hand-offs, persistence, evaluation, and how do they differ from a chat session?"
  - "Across the three, what mechanics exist that pi-goals lacks: verification gates, sub-goal decomposition, autonomy/approval policies, reminders that adapt to drift, multi-agent handoff, evidence ledgers, success-criteria evaluation?"
  - "What concrete design improvements would move pi-goals from a single static reminder to a goal kernel competitive with these systems while staying small and local?"

scope:
  in_scope:
    - "Official primary docs (OpenAI, Anthropic, Factory.ai), open-source repos, system-prompt leaks where verifiable."
    - "Tooling: plan/todo tools, plan-mode, missions, hooks, subagents that touch goal state."
    - "Persistence layer: where state lives, what survives a /compact, what survives a session restart."
    - "Reminder/injection mechanics: how the agent is reminded of the goal mid-turn."
    - "Autonomy/approval policies tied to a goal (read-only / write / dangerous)."
  out_of_scope:
    - "General prompt engineering not specific to goal tracking."
    - "Pricing, business strategy of vendors."
    - "Cursor/Windsurf/Aider/Continue/Zed agents (could be a follow-up)."
    - "Building the replacement extension (separate task)."
  time_horizon: "recent — 2024-09 through 2026-05; favor latest stable docs"
  geography: "global"
  depth: "detailed"

keywords:
  primary:
    - "Codex update_plan"
    - "Codex AGENTS.md"
    - "Claude Code TodoWrite"
    - "Claude Code plan mode ExitPlanMode"
    - "Factory Droid missions"
    - "coding agent goal tracking"
  secondary:
    - "agentic plan tool"
    - "todo_write"
    - "approval_policy sandbox"
    - "subagents handoff"
    - "system reminder injection"
    - "autonomy level"
    - "spec-driven coding"
  exclude:
    - "Google Project Goals OKR"
    - "personal productivity todo apps"
    - "fitness goals"

source_preferences:
  prefer:
    - "github.com/openai/codex (source of truth for update_plan, AGENTS.md, approval policy)"
    - "docs.claude.com / docs.anthropic.com Claude Code pages"
    - "docs.factory.ai / app.factory.ai missions docs"
    - "official changelogs and release notes"
    - "well-cited reverse-engineered prompts (e.g. system-prompts-leaks repos) with clear date stamps"
  deprioritize:
    - "Medium reposts of vendor docs"
    - "Listicles comparing agents without primary citations"
  minimum_sources_per_subquestion: 2

success_criteria:
  - "Each of Codex / Claude Code / Factory Droid has at least 2 independent primary sources documenting its goal/plan/mission mechanic."
  - "Comparison table covers: representation, persistence, surfacing/reminding, verification, decomposition, autonomy policy, handoff, evidence."
  - "At least one architectural diagram per system (state lifecycle or data flow) plus a side-by-side comparison diagram."
  - "Explicit gap list against pi-goals with rank-ordered design recommendations."
  - "All cited URLs were actually fetched and contained the cited claim (sources.md is auditable)."

output:
  shape: "report + showcase HTML (charts + Mermaid diagrams)"
  audience: "the user — designing pi-goals v2; wants both rigorous text and a visual artifact"
  length_target: "full report, but punchy; HTML is the visual centerpiece"

risks_and_assumptions:
  - "Factory Droid Missions documentation may be partial / behind login; treat as REPORTED unless cross-verified."
  - "Some Claude Code internals (TodoWrite schema) are documented mainly via reverse engineering; flag claim type."
  - "Codex evolves fast; pin claims to the most recent stable docs and note the date."
  - "Pi-goals comparison is grounded in the source file just read; treat that as FACT (we own the code)."
```
