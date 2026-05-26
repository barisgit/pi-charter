# pi-charter v2 — validation pass

Date: 2026-05-14
Author: Claude Code (deep-research)
Brief: `./brief.md`
Sources: `./sources.md`
Status: complete

---

## Executive summary

**Verdict on architecture: keep the v2 shape with refinements; do not rethink.** The five locked v2 primitives (durable charter + VAL-* criteria + macro-DAG of features + smart-Ralph loop + filesystem session binding + folded post-turn evaluator) sit in a genuine, largely unoccupied niche. Most production systems use a self-driven loop with an implicit prompt-or-issue contract; only Factory.ai and the AgentContract spec do pre-execution behavioural contracts with per-criterion evidence, and only Factory does it inside a managed mission FSM. The runtime landscape (LangGraph, Temporal, Restate, OpenAI Agents SDK, MCP) is converging on checkpointed state and elicitation primitives, not on contract-first objective shapes. Smart-Ralph is a real named pattern (Geoffrey Huntley, May 2025; Anthropic shipped an official Claude Code plugin Dec 2025); pi-charter's decision to put the *agent* inside that loop with a *contract* as the stop signal is an unusual and defensible combination.

**Verdict on naming: rename. `pi-missions` is taken.** `itisbryan/pi-missions` is a live, npm-published, actively maintained pi extension explicitly described as "Factory.ai-inspired mission orchestration for pi". The design overlap is severe: `/mission`, `mission_update`, `VAL-AUTH-001` style assertions, planning questionnaire, Standard/Full/Minimal modes, Mission Control overlay, milestone/feature/validation structure. Continuing under the same name would (a) confuse users, (b) embarrass both authors, (c) almost certainly trigger a rename request. The risk is collision and adoption-friction, not trademark — no Factory.ai USPTO/EUIPO mark on "Mission" was confirmed (USPTO is JS-only and could not be searched programmatically; treat as a gap, not a clean bill).

**Top three actionable refinements to fold into v2** (all single-source REPORTED or SYNTHESIS; not load-bearing without further work):

1. Emit a `contract.schema.json` and consider AgentContract YAML interop. AgentContract is the only emerging cross-vendor format with structured criterion clauses, severities, and gating; if it stabilises, pi-charter becomes interoperable cheaply.
2. Adopt LangGraph-style `interrupt()` + `Command(resume=)` semantics on top of the existing pause/resume; this is the converging primitive for durable agent state and pairs naturally with `charter:before_lock_plan`.
3. Add deterministic-then-LLM evaluator layering (regex / type / format checks before an LLM judge) per Pydantic Evals and LangSmith practice. Cheaper, fewer false-positive steers, makes the evaluator's wrong-steer risk concretely smaller.

**Recommended rename: `pi-charter`.** Accurate (binding contract + scoped mandate), no GitHub/npm collision in the pi or agent space, not generic, not Factory-collided. Fallback: `pi-objectives` (no collision but slightly more generic). Avoid: `pi-quests` (taken), anything with `mission` in the name.

---

## Research questions

The brief locked six sub-questions:

1. **Q1** — Other production systems doing mission/contract/decomposed execution
2. **Q2** — Smart-Ralph loop pattern in the wild
3. **Q3** — Contract-driven validation alternatives
4. **Q4** — Post-turn evaluator state of the art
5. **Q5** — Runtime primitives for durable agent objectives
6. **Q6** — Naming + trademark + collision

This report folds Q1 and Q5 together (system shapes) and Q2 and Q4 together (loop + critic) for readability.

---

## Findings

### Q1 + Q5 — Mission shapes and runtime primitives

**FACT.** Across roughly fifteen production agent systems and runtimes examined, three dominant primitive shapes are visible:

| Shape | Examples | Durable state | Decomposition unit | Contract primitive |
|---|---|---|---|---|
| **Checkpointed graph state** | LangGraph, Temporal, Restate | Persistent log/checkpointer; full replay on failure | Graph nodes / activities / workflows | None built-in; types or schemas as proxies |
| **Handoff + elicitation** | OpenAI Agents SDK, MCP, AutoGen | Session-scoped, in-memory by default; extensible | Agent-to-agent handoffs; elicitation events | `input_guardrails` / `output_guardrails` (OpenAI); JSON Schema via `requestedSchema` (MCP elicitation) |
| **Workflow-as-DAG** | CrewAI, Mastra, Inngest, Vercel AI SDK | Inconsistent; mostly weak persistence | Task / step / flow nodes | Tool schema as implicit contract |

**REPORTED.** Cognition Devin, Replit Agent, Google Jules, Open-Devin, and SWE-Agent all use **self-driven loops with implicit contracts** (prompt or issue serves as the acceptance surface). Claude Code's "Plan review" step and Sweep AI's "GitHub issue as acceptance contract" are the closest mainstream analogues to pre-execution contract gates, but neither is a typed per-criterion VAL-style structure.

**FACT.** Only two systems were confirmed to use **pre-execution behavioural contracts with per-criterion evidence records**: Factory.ai Missions, and the open-source AgentContract spec (a YAML-driven `.contract.yaml` schema with clauses, severities, and gating). pi-charter v2 sits in the same niche.

**SYNTHESIS — why this matters for v2.** The convergence in the runtime layer is around durability and interrupt/resume, not around acceptance criteria. pi-charter chose to layer a *contract* on top of an existing durable substrate (the pi session + filesystem state) rather than reinvent durability. That's the right call: durability is solved at the substrate level by LangGraph/Temporal/Restate, and pi has its own session model; reinventing it inside an extension would be wasted effort. The contract layer is the part where the industry is genuinely thin, and the part pi-charter adds value on. The one thing worth borrowing from LangGraph specifically is the `interrupt() + Command(resume=)` shape — it's a cleaner conceptual model than pause/resume for "stop, ask, continue", and it maps directly onto `charter:before_lock_plan` and `charter:before_complete`.

### Q2 + Q4 — Smart-Ralph loop and post-turn evaluator

**FACT.** Smart-Ralph is a named industry pattern with clear provenance:

- **Origin:** Geoffrey Huntley, ~May 2025, in his "Six-month recap of agentic coding" essay. Definition: *"Ralph is a Bash loop."* Named after the Simpsons character for persistent one-track energy.
- **Formalisation:** Anthropic shipped an official Claude Code plugin in December 2025 implementing the pattern via stop hooks (intercept session exit; re-feed prompt if completion not signalled).
- **Adoption:** Block (Goose), Vercel Labs, multiple GitHub repos, Encyclopedia of Agentic Coding Patterns (aipatternbook.com).

**FACT.** The distinguishing feature of Ralph vs. ReAct/Reflexion/AutoGPT is that **the completion signal lives outside the model** (tests, linters, a `COMPLETE` marker, a verifier). The model decides what to do; the harness decides when to stop.

**SYNTHESIS — pi-charter' position.** pi-charter v2's "agent IS the loop; contract is the stop signal" is a coherent member of the Ralph family. The novel part is using the *contract* (per-criterion fresh-evidence checks + verifier predicates) as the completion oracle, rather than a plain bash test. That is a genuine generalisation of Ralph — closer to a *typed* Ralph than the literal `while true: claude.md` shape.

**FACT.** The post-turn evaluator pattern is well-established. Reflexion (verbal RL critic, 2023) is the canonical reference; LLM-as-Judge is the SOTA framing. Pydantic Evals, LangSmith, and Claude Code's `/goal` evaluator all run cheap separate models against trajectory.

**Gaps the explorer flagged against pi-charter v2's folded legacy evaluator persona** (REPORTED, all single-source from the Q2/Q4 explorer digest):

| # | Gap | What state of the art does |
|---|---|---|
| G1 | No explicit retry-on-failure loop | Self-Refine, DSPy `Assert`, ADK `LoopAgent` re-enter after evaluator verdict |
| G2 | No hard termination from evaluator | ADK `escalate=True`; Ralph: test-pass; Claude Code: `max_steps` |
| G3 | No deterministic-then-LLM layering | Pydantic Evals + LangSmith run regex/type/format first; LLM only for nuance |
| G4 | No external completion signal | Constitutional AI flagged self-critique bias; Ralph's fix is harness-decides-done |
| G5 | No escalation path to human | SentinelGate escrow; ADK `escalate`; Agent Sentinel |
| G6 | No evaluator uncertainty/self-awareness | JudgeBench: even GPT-4o is near-random on hard tasks |
| G7 | No evaluator context-window management | Claude Code has 4-layer compression; pi-charter folded evaluator may grow unbounded |
| G8 | No multi-evaluator routing | ADK + LangGraph route to different evaluators by state |

Of these: **G3 (deterministic layering) and G4 (external completion signal) are the ones already partly addressed by v2's design** — v2's verifier-kind enum (command | prompt | hook | manual) already separates deterministic from LLM-judge, and `requireFreshEvidence` + `requireReviewSubagent` is an external completion-signal mechanism. G1, G2, G5 are deliberately *not* in v2 scope (HITL out of mission core; force-complete is the escape hatch; agent IS the loop, no retry orchestrator). G6 and G7 are real and worth tracking. G8 is over-engineering for the current scope.

### Q3 — Contract validation alternatives

**FACT.** pi-charter v2's `charter.md §Criteria` shape (markdown + VAL-* + JSON evidence + per-criterion gating flags) occupies a real niche. Only Factory.ai Missions and the AgentContract spec do *pre-execution* behavioural contracts with *per-criterion* evidence. The rest of the eval ecosystem (Inspect AI, OpenAI Evals, LangSmith, Pydantic Evals) is post-hoc dataset evaluation: you run the agent, then score outputs against a rubric.

**FACT.** No consensus on criterion vocabulary across the industry. Each system uses different terms:

| System | Criterion-unit term |
|---|---|
| Factory.ai Missions | assertion |
| AgentContract | clause |
| OpenAI Evals | grader |
| Inspect AI | scorer |
| LangSmith | evaluator |
| BAML | constraint / `@assert` |
| DSPy | assert / suggest |
| **pi-charter v2** | **criterion (`VAL-*`)** |

Our `VAL-*` prefix appears unique; no other system prefixes criterion IDs.

**REPORTED.** `requireFreshEvidence` (block completion until evidence ts > charter criteria digest update ts) is **not confirmed in any fetched source**. The closest analogues are AgentContract's `block` severity, DSPy Assert's halt-on-failure, and BAML's `@assert` error — none of which gate on evidence freshness. This appears to be a pi-charter innovation. **Confidence: medium-low.** It is also possible some closed-source enterprise system has this and we did not find it.

**FACT.** Factory.ai explicitly names a "creator-verifier" pattern with separate adversarial agents. pi-charter v2's `requireReviewSubagent` is a granular variant. No mainstream eval framework models evidence authorship as a first-class concept.

**Mid-execution amendments.** Factory.ai supports this via fix-feature loops; pi-charter supports it via `charter_manage({action: 'amend_contract'})`. The rest of the post-hoc eval ecosystem has no analogue — contracts/datasets are typically immutable per run.

**SYNTHESIS — is the markdown shape right?** Industry is converging on YAML (AgentContract) or code (DSPy, BAML, Pydantic AI), not markdown. Code/YAML wins on schema-validation and tooling; markdown wins on non-programmer accessibility. The pragmatic answer is: keep `charter.md` as the authored source of truth, and emit a `contract.schema.json` plus an AgentContract-compatible YAML projection. That way pi-charter stays human-first but interoperates with the schema-first systems that may matter in 12-24 months.

### Q6 — Naming + collision

**FACT.** `pi-missions` is taken on GitHub and npm. `itisbryan/pi-missions` is a live, actively maintained pi extension (10 stars, npm-published, last commit 2026-04-03 per repo) explicitly described as "Factory.ai-inspired mission orchestration for pi". Verified by direct fetch of the GitHub repo README. Design overlap with our v2:

| Aspect | itisbryan/pi-missions | our v2 |
|---|---|---|
| Inspiration | "Factory.ai Missions" | Factory.ai Missions |
| Slash command | `/mission <objective>` | `/charter <objective>` |
| Tool | `mission_update` | `charter_manage` |
| Validation IDs | `VAL-AUTH-001 passed` | `VAL-*` |
| Modes | Standard / Full / Minimal | full mode equivalent |
| Overlay | Mission Control overlay | (planned) status widget |
| Persistence | session entries (survive /compact) | per-project filesystem layout |

The shape is so similar that two consequences follow:

1. **A user installing both will have package-name collision.** This is a hard collision, not just a stylistic one.
2. **Naming the extension `pi-missions` would get our v2 mistaken for itisbryan's.** Embarrassing both authors and confusing users.

**FACT.** `pi-quests` is also taken. `kalindudc/pi-quests` is a live MIT-licensed pi extension ("quest-log for your pi", `/quests` command, npm-published, 6 stars).

**FACT.** "Mission" is genericising in the agent space. At least three independent systems use it as a first-class primitive: CrewAI ("a crew is a team of agents collaborating to accomplish a mission"), AgentOS (`MissionBuilder`, `MissionRunner`), Mission Protocol v2, Automatos AI ("Missions are autonomous, multi-step objectives"). Factory.ai did not invent the term; their `/missions` (plural) is the slash-command-officially confirmed by their docs.

**GAP.** Factory.ai trademark status on "Mission", "Mission Control", or "Droid" was **not confirmed**. USPTO tmsearch.uspto.gov is JavaScript-rendered and cannot be fetched programmatically; EUIPO same. The TTAB record we did fetch (case 91286884) confirms only that DROID marks belong to Lucasfilm, not Factory.ai. **This is a gap, not a clean bill.** If Factory.ai files trademark applications in the next 12-24 months, the risk surface changes.

**FACT.** `pi-charter` has no GitHub collision. The 19 results returned by GitHub repo search for `pi-charter` are all unrelated: pivotal-tracker charter stories, pie-charter pie-chart tools, project-charters in Kotlin. None of them are pi-coding-agent extensions, agent frameworks, or AI tools.

**FACT.** `pi-objectives` has no GitHub collision in the agent space. The 97 results are all Raspberry-Pi-or-unrelated: rpi-webrtc-streamer, RaspberryPi-BuildRoot, PiScope (astronomy lenses), pie-chart code. One repo (`joyreleased/pi-objectives`, 0 stars, last updated Jan 2022) exists but is empty and abandoned.

**GAP.** Could not check `pi-campaigns`, `pi-runs`, `pi-orchestrator`, `pi-plan`, `pi-pursuits` due to GitHub rate-limiting after the first two searches. Treat these as "no confirmed collision" rather than "verified clean".

### Naming options summary

| Candidate | GitHub/npm collision in pi/agent space | Accuracy to v2 design | Genericity | Verdict |
|---|---|---|---|---|
| **pi-missions** | **HARD: itisbryan/pi-missions live and similar** | High | Medium | **Do not use** |
| pi-quests | Hard: kalindudc/pi-quests live | Medium | Low | Do not use |
| **pi-charter** | None confirmed | High (binding contract + scoped mandate) | Low | **Recommended** |
| pi-objectives | None confirmed (one empty abandoned repo) | High (durable goal + milestones) | Medium | Strong fallback |
| pi-campaigns | Not verified | Medium-high (multi-phase coordinated effort) | Medium | Viable; verify before commit |
| pi-targets | Not verified | Medium (under-sells multi-phase) | Medium | Weak |
| pi-runs | Not verified | Low (no planning/validation flavour) | High | Weak |
| pi-pursuits | Not verified | Medium (loop continuation flavour) | Low | Weak (awkward as package name) |

---

## Conflicting information

- **Smart-Ralph attribution.** Geoffrey Huntley's provenance is well-attested in his own essay (S29) and the Encyclopedia of Agentic Coding Patterns (S31). The Q4 explorer's claim that Anthropic shipped an official plugin in Dec 2025 is **single-source REPORTED** through the explorer's digest; we did not directly fetch the Anthropic plugin page or its release notes. Treat the "official Anthropic plugin" claim as low-confidence until verified.

- **Factory.ai mission product naming.** Factory's official docs use `/missions` (plural) as the canonical slash command, with `/mission` (singular) as an alias. The Q1/Q5 explorer's framing of "Mission" as a singular product name is the marketing form; the implementation form is plural. Minor inconsistency, not load-bearing.

- **`itisbryan/pi-missions` last commit date.** The Q6 explorer digest reported April 3 2026; the live repo fetch shows 14 commits total with last commit metadata not directly parsed. The repo is alive and recent regardless; the exact date is not load-bearing for the verdict.

- **npm package verification.** All three npmjs.com fetches returned 403 Forbidden (Cloudflare anti-bot). Package existence is inferred from GitHub READMEs that reference the npm installation command. High-confidence the packages exist (READMEs would not document install commands for non-existent packages on an actively-developed repo) but not directly verified.

---

## Information gaps

1. **USPTO/EUIPO trademark search** — JavaScript-rendered, not programmatically fetchable. Factory.ai's mark portfolio not confirmed; the risk surface for "mission" is unquantified.
2. **npm package metadata** — version, publish date, weekly downloads for `pi-missions` / `pi-quests` not directly retrievable due to anti-bot. Doesn't change the collision verdict.
3. **GitHub collision checks for `pi-campaigns`, `pi-runs`, `pi-orchestrator`, `pi-plan`, `pi-pursuits`** — rate-limited. The recommended name (`pi-charter`) and the strong fallback (`pi-objectives`) are both verified clean.
4. **Anthropic official Ralph plugin** — REPORTED via the Q2/Q4 explorer digest; not directly verified.
5. **AgentContract spec stability** — referenced as an emerging cross-vendor standard but project maturity, adoption, and roadmap not directly verified.

---

## Confidence assessment

**Overall: medium-high.**

- **High confidence:** `pi-missions` is taken with substantial design overlap (directly verified). `pi-charter` and `pi-objectives` are collision-free in the pi/agent space (directly verified). v2's contract pattern occupies a real, sparsely-populated niche (cross-verified across Factory.ai docs + AgentContract spec + absence in mainstream eval frameworks).
- **Medium confidence:** Smart-Ralph industry adoption claims (single-source primary for the origin essay; multi-source for the pattern's existence; single-source REPORTED for the Anthropic plugin). The eight Q4 evaluator gaps (single-source REPORTED from explorer digest).
- **Low confidence:** Factory.ai trademark status (GAP). `requireFreshEvidence` being a pi-charter innovation rather than something we missed (single-source absence).

---

## Recommendations

### Architecture (keep v2 shape; consider these refinements)

1. **Emit `contract.schema.json` + AgentContract YAML projection.** Markdown stays authoritative; YAML is generated. Costs little, buys interop if AgentContract stabilises.
2. **Borrow LangGraph's `interrupt() + Command(resume=)` framing** for pause/resume nomenclature internally. Same primitives, but the conceptual model maps cleanly onto `charter:before_lock_plan` / `charter:before_complete` and aligns with how the industry talks about durable agent state.
3. **Document the deterministic-then-LLM layering** that's already implicit in verifier-kind enum (command < hook < prompt < manual). Make it explicit in the contract authoring guidance: "prefer command/hook verifiers over prompt verifiers when feasible". This addresses Q4 gap G3 without new mechanism.
4. **Track Q4 gaps G6 (evaluator self-uncertainty) and G7 (evaluator context window).** Not for v2 ship; flag in v2-brainstorm.md §16 ("What v2 deliberately leaves out") as known unknowns.

### Naming (rename now, before v2 lands)

1. **Rename `pi-missions` → `pi-charter`.** Update all artifacts: extension name, slash command (`/charter`), tools (`charter_manage` / `charter_plan` / `charter_record` / `charter_status`), hook events (`charter:before_lock_plan` etc.), kernel typename (`Charter`), file paths (`<project>/.pi/charters/<charterId>/`), CLI flags (`pi --charter-objective`, `pi --charter-resume`).
2. **Reframe the authored contract as `charter.md §Criteria`** — they're conceptually the same thing in legal/governance vocabulary, which makes the naming consistent: a charter is a binding document that authorises and bounds an undertaking.
3. **If `pi-charter` feels too corporate to you**, the strong fallback is `pi-objectives`. Both are clean; charter is more precise.
4. **Do not use** `pi-quests` (taken) or any name containing "mission".

### Verification before commit

- Run a fresh GitHub + npm + PyPI search for the chosen final name with a clean session (the rate limit on this run cut three checks short).
- If you want trademark certainty, do a manual USPTO + EUIPO search for the chosen name and for "Factory.ai mission". JavaScript databases need a human; not blocking but worth one hour.

---

## Suggested follow-up

- **AgentContract spec deep-dive.** Is it stable enough to interoperate with? Adoption signals?
- **LangGraph interrupt() pattern study.** What's the right way to map it onto pi's hook bus?
- **Empirical verifier-kind cost study.** What fraction of real VAL-* criteria can be expressed as `command` vs needing `prompt`? Calibrates the deterministic-first guidance.
- **Single-shot competitor scan** (one fetch each): Cursor's "background agent" feature, Windsurf's "long-running mode", any 2026 update from Factory.ai we haven't seen.
- **One-hour manual trademark pass** on the chosen rename plus "factory" / "droid" — completes the gap from this run.
