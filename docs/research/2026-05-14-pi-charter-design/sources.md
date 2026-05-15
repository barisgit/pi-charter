# Codex goal/plan tracking — sources log
> Appended 2026-05-14

---

- [1] codex-rs/protocol/src/plan_tool.rs + codex-rs/core/src/tools/handlers/plan.rs + PR #10124 (todo_write rename) — openai/codex (GitHub) — accessed 2026-05-14 — Primary source: exact tool schema fields (UpdatePlanArgs, PlanItemArg, StepStatus), handler logic, wire event name. Cross-verified against PR #10124 commit chain. — https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs, https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan.rs, https://github.com/openai/codex/pull/10124

- [2] PR #4769 (Plan Mode: read-only iterative planning Shift+Tab) + docs/agents_md.md — openai/codex (GitHub) — published 2025-10-05 — accessed 2026-05-14 — Primary source: Plan Mode toggle, Shift+Tab, read-only sandbox, /plan-model, TUI rendering of PlanUpdate as checklist, transcript persistence across plan submissions. — https://github.com/openai/codex/pull/4769, https://github.com/openai/codex/blob/main/docs/agents_md.md

- [3] Issue #19749 (Session-scoped active todo reminders for update_plan) — openai/codex (GitHub) — published 2026-04-27 — accessed 2026-05-14 — Primary source: active_todo_list proposal, pending reminder injection, session state gap, resume restoration of unfinished todos. Open issue; proposed but not shipped. — https://github.com/openai/codex/issues/19749

- [4] PR #1497 (/compact command) + Issues #4924, #11325 (auto-compaction) — openai/codex (GitHub) — published 2025-07-10 / 2025-10-08 / 2026-02-10 — accessed 2026-05-14 — Primary source: /compact lifecycle (summarize transcript, replace history), auto-compact in latest models, intent to deprecate manual /compact. — https://github.com/openai/codex/pull/1497, https://github.com/openai/codex/issues/4924, https://github.com/openai/codex/issues/11325

- [5] Issue #18920 (plan rendering gap after assistant response) — openai/codex (GitHub) — published 2026-04-22 — accessed 2026-05-14 — Primary source: task list disappears from TUI after assistant responds; rendering lifecycle gap; team unable to reproduce. Open issue. — https://github.com/openai/codex/issues/18920

- [6] Agent approvals & security — OpenAI Developers — accessed 2026-05-14 — Primary source: sandbox modes (read-only/workspace-write/danger-full-access), approval policies (on-request/unless-trusted/never), Auto preset, full-auto flag, plan mode read-only sandbox interaction. — https://developers.openai.com/codex/agent-approvals-security

- [7] Custom instructions with AGENTS.md — OpenAI Developers — accessed 2026-05-14 — Primary source: hierarchical loading rules (global → repo root → CWD), precedence order, AGENTS.override.md, project_doc_max_bytes limit (32 KiB), CODEX_HOME override, concatenation/override semantics. — https://developers.openai.com/codex/guides/agents-md

- [8] Follow a goal use case — OpenAI Developers — accessed 2026-05-14 — Primary source: /goal experimental feature, durable stopping condition, validation loop, checkpointing, progress log, plan.md workflow, how /goal differs from one-shot prompts. — https://developers.openai.com/codex/use-cases/follow-goals

- [9] AGENTS.md (repo root) — openai/codex (GitHub) — accessed 2026-05-14 — Primary source: repo-level AGENTS.md is internal Rust tooling guidance (not user-facing product docs). — https://github.com/openai/codex/blob/main/AGENTS.md

- [10] chatgpt.com/codex (ChatGPT Codex cloud) — OpenAI — accessed 2026-05-14 — GATED: returned 403 Forbidden. Could not verify cloud vs. CLI differences for plan/goal mechanics. — https://chatgpt.com/codex

# Claude Code goal/plan/todo — sources
> Appended 2026-05-14

- [11] /goal command — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: /goal lifecycle, evaluator (small fast model post-turn), prompt-based Stop hook implementation, 4000-char condition limit, "◎ /goal active" indicator, restoration on --resume (turn/timer/token reset), aliases (clear/stop/off/reset/none/cancel), /clear removes goal, -p non-interactive. — https://docs.claude.com/en/docs/claude-code/goal
- [12] Tools reference — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: complete tool inventory. Key entries: EnterPlanMode / ExitPlanMode, Agent (subagent), Task family (TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TaskOutput-deprecated), TodoWrite (deprecated, SDK/-p still uses it; env CLAUDE_CODE_ENABLE_TASKS=1), Monitor, Skill. — https://docs.claude.com/en/docs/claude-code/tools
- [13] Hooks reference — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: complete hook event list including TaskCreated, TaskCompleted, SubagentStart, SubagentStop, Stop, StopFailure, PreCompact, PostCompact, SessionStart, SessionEnd, InstructionsLoaded, PermissionRequest/Denied, prompt-based Stop hooks (the mechanism /goal is built on). — https://docs.claude.com/en/docs/claude-code/hooks
- [14] Permission modes — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: default/acceptEdits/plan/auto/dontAsk/bypassPermissions; plan mode = reads only + ExitPlanMode tool to present plan for approval; Shift+Tab cycle. — https://docs.claude.com/en/docs/claude-code/permission-modes
- [15] Scheduled tasks (/loop) — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: /loop fixed/dynamic intervals, session-scoped tasks, restored on --resume if unexpired (7-day expiry), Monitor tool. — https://docs.claude.com/en/docs/claude-code/scheduled-tasks
- [16] Sub-agents — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: built-in Explore/Plan/general-purpose, Plan subagent gathers context during plan mode (no nesting), per-subagent permissions and skills, Agent tool. — https://docs.claude.com/en/docs/claude-code/sub-agents
- [17] Commands reference — Anthropic Claude Code Docs — accessed 2026-05-14 — Primary source: /agents, /plan, /loop, /goal, /tasks, /branch, /fork, /compact, /clear, /resume, /background, /batch, /rewind. — https://docs.claude.com/en/docs/claude-code/commands

# Codex /goal experimental — FACT-level sources
> Appended 2026-05-14 (supersedes the previously REPORTED /goal coverage)

- [g1] How OpenAI Codex implements the `/goal` slash command — `patleeman` GitHub gist — published 2026-05-09, last updated 2026-05-12 — accessed 2026-05-14 — PRIMARY technical source: cites the exact 5-PR stack (#18073 persistence, #18074 app-server API, #18075 model tools, #18076 core runtime, #18077 TUI UX), file paths (`state/src/runtime/goals.rs`, `core/src/goals.rs`, migration `0029_thread_goals.sql`, `templates/goals/{continuation,budget_limit}.md`), SQLite schema, `Feature::Goals` flag, JSON-RPC method names, `GoalRuntimeEvent` enum variants, `ThreadGoal` shape, model tool surface and constraints, `goal_id` UUID stale-update protection, `Semaphore(1)` accounting guard, no-tool continuation suppression, plan-mode bypass. Author cites openai/codex by `etraut-openai`. — https://gist.github.com/patleeman/b1b5768393f9bf2f60865b1defeeb819
- [g2] Slash commands in Codex CLI — OpenAI Developers — accessed 2026-05-14 — Primary source: `/goal` entry "Set or view an experimental goal for a long-running task", inline syntax, `features.goals` enablement, lifecycle subcommands `pause`/`resume`/`clear`. — https://developers.openai.com/codex/guides/slash-commands/
- [g3] Codex CLI /goal: Enable the Ralph Loop — Mehmet Baykar (blog) — published 2026-05-08 — accessed 2026-05-14 — Secondary: `codex features enable goals` enablement path, version requirement (0.128.0+), CLI/TUI-only constraint, autonomous-loop framing, restart-required behavior. — https://mehmetbaykar.com/posts/enable-goal-mode-in-codex-cli/
- [g4] Document the /goal CLI command and Goals lifecycle in slash-command docs — openai/codex Issue #20536 — published 2026-05-01 — accessed 2026-05-14 — Primary: confirms `/goal` exists in codex-cli 0.128.0 via local string verification; documents TUI status labels `pursuing`/`paused`/`achieved`/`unmet`/`budget-limited`. — https://github.com/openai/codex/issues/20536
- [g5] Codex macOS app should natively support `/goal` like Codex CLI — openai/codex Issue #22049 — published 2026-05-10 — accessed 2026-05-14 — Primary: confirms `/goal` is CLI-only as of 0.130.0; macOS app shows "No commands"; documents CLI lifecycle (`set/view/pause/resume/clear`). — https://github.com/openai/codex/issues/22049
- [g6] `/goal` slash command does not work in 0.128.0 — openai/codex Issue #20591 — published 2026-05-01 — accessed 2026-05-14 — Primary: feature flag default-off behavior; `[features] goals = true` workaround; OpenAI staff comment that the feature is still "under development". — https://github.com/openai/codex/issues/20591
