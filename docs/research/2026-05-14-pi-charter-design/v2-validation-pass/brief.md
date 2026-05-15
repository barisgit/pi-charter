# Research brief — pi-charter v2 design validation pass

Date: 2026-05-14
Author: Claude Code (deep-research)
Status: scoping complete, search next

## Main question

I want to understand whether the pi-charter v2 design (Factory-droid-inspired: durable mission with VAL-* contract + macro-DAG of features + smart-Ralph loop + post-turn evaluator + filesystem session binding) is the right architectural shape today, or whether there are alternative industry approaches landing in 2025-2026 that would yield a materially better extension — and whether using the name "pi-charter" has any trademark, naming-collision, or product-confusion risk.

## Sub-questions

1. **Sub-Q1 — Mission/contract style approaches.** Beyond Factory Droid, what other production systems use a *durable mission* + *VAL-style validation contract* + *worker-droid-style decomposed execution*? Examples to confirm or refute: Cognition Devin sessions, Cursor agents, Windsurf cascade, OpenAI Operator/computer-use, Anthropic Claude Code agentic plans, Replit Agent, Sweep AI, Aider plans, AutoGPT/AgentGPT/BabyAGI lineage, Google Jules.

2. **Sub-Q2 — Smart-Ralph loop pattern.** Ralph Wiggum / smart-Ralph (cheap persistent loop driven by guidelines + system-prompt reminders rather than a clever scheduler) — is this idea live in industry, and what are the named variants and tradeoffs? Compare against: ReAct, Reflexion, Voyager, AutoGPT planner, LangGraph state machines, OpenAI Swarm/Agents SDK, CrewAI flows, Google ADK, Microsoft AutoGen, Pydantic AI graph.

3. **Sub-Q3 — Contract-driven validation alternatives.** What approaches exist for *behavioral assertions / VAL-* style contracts*? Compare to: Pydantic Evals, OpenAI Evals, Anthropic eval frameworks, DSPy assertions/suggestions, LangSmith evaluations, behavior-driven dev tools, formal-spec systems (TLA+, Alloy), schema-first agent dev. Specifically: are there published patterns of "agent self-attests against typed assertions with per-criterion evidence records"?

4. **Sub-Q4 — Post-turn evaluator pattern.** Cheap separate model judging agent trajectory each turn — what's the state of art and named variants? Compare to: Reflexion, self-refine, critic-actor patterns, OpenAI safety reviewer, Anthropic's constitutional AI critic loop, Claude Code `/goal` evaluator, "judge model" patterns from RLHF/RLAIF lineage.

5. **Sub-Q5 — Goal/charter tracking + workflow primitives in agent runtimes.** What primitive shapes are leading runtimes settling on for durable agent objectives? Compare to: LangGraph `Command` + `Send`, OpenAI Agents SDK `Runner` + `Handoffs`, AutoGen `GroupChat` + termination, CrewAI `Crew` + `Task` + `flow`, Pydantic AI `Graph` + nodes, Inngest agent kit, Temporal-style durable agent workflows (Restate, Inngest, Temporal Cloud agents), MCP elicitation/sampling, Anthropic Skills primitives.

6. **Sub-Q6 — Name conflict for "pi-missions" / "missions" and candidate rename `pi-charter`.**
   - Trademark surface: does anyone hold a trademark on "missions" in agent/AI/dev tools space? Particularly Factory.ai for "Mission" / "Mission Control" / "Droid Missions" / "Droid".
   - Product collisions: which other agent/dev products use "mission(s)" as their core primitive name (Factory, Replit Missions?, Cursor?, GitHub Copilot Workspaces, GitLab Duo?), and how confusing would naming our extension `pi-missions` be, and whether `pi-charter` is cleaner?
   - Pi ecosystem: any existing pi-* extension named missions or near-collisions.

## Scope boundaries

- **In scope:** agent runtimes, agent-IDE tools, AI coding assistants, autonomous-agent frameworks; primitive names ("mission", "goal", "task", "plan", "contract", "workflow"); validation/evaluation patterns for agents; durable workflow tooling adjacent to agents.
- **Out of scope:** general LLM model comparisons; non-agent dev tools; aerospace/military "mission" software; trademark filings in jurisdictions outside US/EU/UK unless a major vendor.
- **Time horizon:** strong preference for 2024-Q3 onward (last ~18 months); historical context only when it clarifies provenance of a primitive.
- **Geography:** global; English-language primary sources.
- **Depth:** comprehensive on Sub-Q1, Q5, Q6 (architecturally load-bearing); detailed on Q2-Q4.

## Source preferences

- **High priority:** vendor docs, GitHub repos (READMEs, ADRs, source for primitive names), engineering blog posts from the vendors themselves, USPTO/EUIPO trademark search, conference talks (transcripts).
- **Medium priority:** practitioner write-ups with code, Hacker News + Lobsters threads with vendor founders/engineers responding, well-cited industry surveys.
- **Deprioritize:** SEO listicles, "Top 10 agent frameworks" content farms, Medium reposts of vendor blogs, anything undated.

## Success criteria

The report is done when:

1. Every sub-question has at least one well-sourced answer OR an explicit gap statement.
2. For Sub-Q1 (mission alternatives): a comparison table covering ≥6 named systems, with their decomposition primitive, validation primitive, loop driver, and durable-state shape — enough to answer "is pi-charter v2 still the right shape or is there a clearly better one we're missing?".
3. For Sub-Q6 (naming): trademark status confirmed for Factory.ai's "Droid"/"Mission" usage; at least 5 other tools using "mission(s)" identified or absence confirmed; concrete recommendation (keep "pi-missions" / rename to `pi-charter` / rename to X).
4. Specific gap-vs-state-of-art list: ≥3 design ideas worth folding into pi-charter v2, each with a citation and a one-line "why this would help us".
5. At least one named alternative architectural shape (e.g. "Temporal-style durable workflow for agent missions") evaluated against pi-charter v2 with explicit reject-or-fold verdict.

## Output shape

Single `report.md` in this folder with:

- Executive summary leading with verdict (keep pi-charter shape with refinements / rename / rethink).
- Per-sub-question findings with claim-type labels.
- "What pi-charter v2 is missing / could fold in" actionable list.
- Naming verdict + recommendation.
- Conflicting information section.
- Information gaps.

Plus updated `sources.md` log.

## Assumed constraints (for autonomous run)

- We are not redesigning v2 in this pass; we are validating whether it's the right shape and finding gaps/risks.
- Naming change is on the table; user has explicitly raised it.
- Single-author repo; trademark concerns are reputational + collision-risk, not licensing.
