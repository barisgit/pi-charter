# Ralph-loop design for pi-charter

Status: **accepted for f1-f5 implementation**
Date: 2026-05-16
Charter: `c5875f08-c905-4430-bd54-d8696686edb7` (`pi-charter-improvements-v1`)

This document decides the Ralph-loop architecture for the current dogfood charter. It is intentionally narrower than `docs/research/2026-05-16-charter-run/design.md`: no `charter_run`, no batch dispatch, no worker scheduler, and no multi-feature runner. The root agent remains the loop driver.

## 1. Current constraints

Live implementation facts this design must preserve:

- Session binding is one charter per root session today: `~/.pi/agent/sessions/<sessionId>/charter.json` points at one `{ projectDir, charterId }`.
- The evaluator is wired on Pi `turn_end` in `registerCharterEvaluator`; there is no separate idle hook.
- The evaluator steers only. Completion is gated by `completeCharter` evidence checks and decision-control hooks.
- Terminal and dormant statuses already skip evaluator work: `completed`, `abandoned`, `paused`, and `budget_limited`.
- Same-verdict dedup is already 120s and should remain the first-loop safety valve.
- `Budget` supports `{ tokens?, wallclockMs?, turns? }`, but enforcement is not currently implemented.
- Async subagent attribution is event based: tagged `subagent:async-*` events append `feature_started`, `feature_completed`, or `feature_failed`; evidence still lands through `charter_record` / handoff application.

## 2. Decision summary

| Area | Decision |
| --- | --- |
| Re-prompt trigger | Use `turn_end` evaluator verdicts as the only Ralph trigger in this charter. Actionable verdicts send a steer with `triggerTurn: true`; non-actionable verdicts do not. |
| Re-prompt content | Reuse the evaluator reminder shape: verdict/confidence, one-sentence reason, one next-turn instruction, and criterion/feature cites. Do not inject full status dumps. |
| Idle detection | Treat an eligible `turn_end` for the bound charter as the idle point. No wallclock idle timer in f1-f5. |
| Termination | Stop re-prompting on completed, abandoned, paused, budget-limited, user interruption, same-verdict cooldown, max turns, or max wallclock. Completion itself remains evidence-gated. |
| Ralph / reminders / evaluator | Layered channels: evaluator/Ralph is immediate and can trigger continuation; reminders bridge is periodic, model-free, and never required for loop progress. |
| Evaluator cadence | One model call at most per eligible root `turn_end`, with existing 60s timeout and 120s same-verdict send dedup; skip empty planning states. |
| Long-running subagents | Parent does not block. It may work on independent ready features; otherwise it should wait for async completion and then apply handoff/evidence. |
| Multi-charter future | f1-f5 remain one-bound-charter-per-session. Future multi-charter support must arbitrate to at most one triggered continuation per turn and carry charterId in every message. |
| Cost/turn ceiling | Default ceiling is 20 Ralph-triggered continuation turns or 4h wallclock per charter, overridable through `charter_manage(create).budget`. Token budget is advisory until Pi exposes usage accounting. |
| f1-f5 VAL list | Confirmed. No charter amendments are required before implementing f1-f5. |

## 3. Re-prompt trigger (VAL-R2)

### Chosen option

The Ralph re-prompt trigger is the existing post-turn evaluator path:

1. Pi fires `turn_end`.
2. `registerCharterEvaluator` resolves the active session binding.
3. It loads the bound charter state and skips terminal/dormant statuses.
4. It builds evaluator context and runs the model only when the state is worth evaluating.
5. It sends the evaluator reminder through `pi.sendMessage(..., { deliverAs: "steer", triggerTurn })`.
6. `triggerTurn` is true only for actionable verdicts:
   - `blocked`
   - `drifting`
   - `ready_to_complete`
7. `triggerTurn` is false for:
   - `on_track`
   - `unclear`
   - any skipped/deduped verdict
   - any paused, budget-limited, completed, or abandoned charter

Planning charters are eligible only once they have useful planning material: parsed criteria and at least one planned feature or evidence signal. Empty planning states skip the model entirely.

### Rejected alternatives

- **Separate wallclock idle timer**: rejected for f1-f5. Pi already gives a reliable `turn_end` beat and the charter explicitly notes `turn_end` is the idle hook. A timer would add races with user typing, subagent completion, and session shutdown without solving the immediate dogfood bug.
- **Auto-spawn scheduler / `charter_run`**: rejected and out of scope. The ADR says the agent is the loop. The current charter also explicitly defers `charter_run` and batch dispatch.
- **Always trigger after every evaluator result**: rejected because `on_track` and repeated verdicts would create noisy or infinite loops.
- **Manual-only continuation**: rejected because the dogfood failure is that actionable evaluator verdicts can warn without continuing the root agent.

## 4. Re-prompt content (VAL-R3)

### Chosen content strategy

Use the existing evaluator reminder format and keep it small:

```text
legacy evaluator persona (<verdict>, confidence <0.00>):
<one-sentence reason>
Next turn: <one concrete instruction>
Cites: <criterionId and/or featureId>
```

The message should guide the agent by naming exactly one next move whenever possible: inspect status, start a ready feature, record evidence, run a verifier, apply a handoff, pause, or complete after evidence gates pass. It must cite a `criterionId` or `featureId` when charter-scoped; invalid uncited steers should be treated as non-actionable.

The content is the same whether `triggerTurn` is true or false. The trigger flag controls loop continuation; the content controls what the agent sees.

### Rejected alternatives

- **Full `charter_status` dump in every steer**: rejected for context hygiene. The agent can call `charter_status` when needed; the steer only needs enough to pick the next move.
- **Reminder-only text without verdict/cites**: rejected because the agent cannot distinguish drift, blockage, or ready-to-complete situations.
- **Hidden trigger with no displayed message**: rejected because the root agent and user need an audit trail for why the loop continued.

## 5. Idle detection rule (VAL-R4)

### Chosen rule

For f1-f5, pi-charter defines an idle opportunity as an eligible `turn_end` for the currently bound root session.

A `turn_end` is eligible when all of these are true:

1. The root session has a session id.
2. The session has a reverse binding record with `projectDir` and `charterId`.
3. The charter state loads successfully.
4. Status is not `completed`, `abandoned`, `paused`, or `budget_limited`.
5. The charter is either:
   - `active`; or
   - `planning` with non-empty parsed criteria and enough plan material to make a lock-plan nudge useful.
6. The evaluator is not suppressed by empty-planning skip logic, max-turn/max-wallclock ceiling, or same-verdict dedup.

Edge cases:

- **No binding**: do nothing. Do not scan for active charters from the hook.
- **Deleted charter directory**: do nothing and let widget/session-binding recovery handle stale pointers.
- **Multiple active charters in the project**: ignore; the session binding chooses one charter today.
- **Model misconfiguration**: warn once and do not trigger.
- **Planning with no criteria or no plan**: skip the evaluator; no useful steer exists yet.
- **Terminal/dormant states**: skip before model cost and before any send.

### Rejected alternatives

- **Project-wide active-charter scan on every turn**: rejected because it can attach the wrong charter in multi-charter/worktree scenarios.
- **Wallclock-based "no activity for N seconds"**: rejected for this charter because Pi does not expose a dedicated idle event and timers would fight user control.

## 6. Loop termination conditions (VAL-R5)

The Ralph loop stops re-prompting under these conditions:

1. **Completion gate green and terminal transition done**: after `charter_manage complete` succeeds, status becomes `completed`; evaluator skips terminal state on subsequent turns. A `ready_to_complete` verdict may trigger one continuation toward completion, but never completes the charter itself.
2. **User Esc / interruption**: user control wins. If the user interrupts a generated continuation, pi-charter must not fight with a background timer. The charter remains active unless the user or agent records a pause. The next normal user/agent turn may resume via `charter_status`.
3. **Pause**: `paused` status suppresses evaluator model calls and triggerTurn.
4. **Budget-limited**: `budget_limited` status suppresses evaluator model calls and triggerTurn.
5. **Abandoned**: `abandoned` status suppresses evaluator model calls and triggerTurn.
6. **Same-verdict cooldown**: if the prior evaluator entry has the same verdict within 120 seconds, suppress both steer text and `triggerTurn`.
7. **Max Ralph-triggered turn cap**: default 20 triggered continuations per charter, overridden by `budget.turns` when provided.
8. **Max wallclock cap**: default 4 hours from `state.createdAt`, overridden by `budget.wallclockMs` when provided.

Completion remains separate from Ralph termination. Evidence, freshness, `requireReviewSubagent`, and `charter:before_complete` hooks are the only completion gates.

## 7. Ralph, reminders, and evaluator relationship (VAL-R6)

### Chosen architecture: layered channels

Use two independent channels:

1. **Evaluator/Ralph channel**
   - Runs from the `turn_end` evaluator.
   - Uses model-backed trajectory reasoning.
   - Can call `sendMessage` with `triggerTurn: true` for actionable verdicts.
   - Highest priority because it is specific to the latest drift snapshot.

2. **Reminders bridge channel**
   - Registers one model-free reminder per active charter through event-bus pub/sub.
   - Fires on create/lock, clears on complete/force-complete.
   - Re-injects periodically using a named cadence constant, default 8 turns.
   - Must no-op when `pi-reminders` is absent.
   - Does not gate completion and does not replace evaluator steering.

Priority/rate rules:

- Terminal and paused states suppress both channels.
- Evaluator same-verdict dedup suppresses Ralph continuation and steer text.
- Reminder cadence is independent and lower priority; it should provide ambient context, not force an agent turn.
- If both channels are visible near the same turn, evaluator steer is the authoritative next-move instruction.

### Rejected alternatives

- **Merge reminders into evaluator**: rejected because reminders are model-free ambient context, while evaluator is trajectory reasoning with citation rules.
- **Use reminders as the active Ralph trigger**: rejected because `pi-reminders` is optional and must no-op when absent.

## 8. Evaluator cadence (VAL-R7)

### Chosen cadence

Keep evaluator cadence tied to `turn_end` for f1-f5:

- Default frequency: at most one evaluator model call per eligible root `turn_end`.
- Hard per-call cap: existing `EVAL_TIMEOUT_MS = 60_000` and `EVAL_MAX_TOKENS = 4096` remain the call ceiling.
- Hard send cap: same-verdict dedup suppresses both steer and `triggerTurn` for 120 seconds.
- Hard loop cap: default 20 Ralph-triggered continuations per charter, overridable by `budget.turns`.
- Planning skip: do not call the model for empty criteria or empty-plan/no-evidence planning states.
- Dormant skip: do not call the model for paused, budget-limited, completed, or abandoned charters.

This design does not decouple evaluator execution onto a separate timer. If future work decouples evaluator cadence from Ralph continuation, the invariant should remain: evaluator may reason more often than Ralph triggers, but Ralph may trigger at most once per root turn and only for one bound charter.

### Rejected alternatives

- **Evaluate every N seconds**: rejected because there is no idle event and model calls could happen while the user is typing or while a subagent is still producing evidence.
- **Evaluate only on explicit `charter_status` calls**: rejected because it fails to catch post-turn drift after the agent ignored the charter.
- **Disable model and rely only on deterministic drift**: rejected for this charter because evaluator steering is already shipped and the dogfood failure is in its loop behavior.

## 9. Long-running subagent behavior (VAL-R8)

The parent loop does not synchronously wait inside pi-charter.

When a long-running async subagent is active:

1. The root agent starts it with `metadata` including `pi-charter.projectDir`, `pi-charter.charterId`, and usually `pi-charter.featureId` / `pi-charter.criterionId`.
2. `subagent:async-started` records an audit event and the widget may show an in-flight row.
3. The parent agent may continue only with independent safe work: recon, another ready feature with satisfied preconditions, or local verification that cannot conflict with the child.
4. If no independent safe work exists, the parent should stop issuing speculative work and wait for async completion rather than spin the Ralph loop.
5. `subagent:async-complete` records success/failure in `events.jsonl`; this is audit/progress signal, not evidence by itself.
6. Criteria progress happens only after `charter_record handoff_apply`, `charter_record evidence`, or `charter_record verify` writes evidence.
7. The next evaluator/status turn should steer toward applying the handoff or investigating failure.

This preserves the current subagent bridge: metadata attributes child work, events make progress visible, and evidence remains append-only and explicit.

## 10. Multi-charter future-proofing (VAL-R9)

f1-f5 support exactly one bound charter per root session. The implementation should not pretend to support more.

Future multi-charter support must add an explicit binding list and an arbitration rule. The future-safe rule is:

- Evaluate each bound charter independently by `charterId`.
- Emit at most one `triggerTurn: true` continuation per root turn.
- Prioritize, in order: blocked charter with active user attention, ready-to-complete charter, drifting charter with stale/no evidence, then lowest remaining budget.
- Every steer must include the charter display name or id.
- Every event, handoff, reminder, and widget row must filter by `charterId`.

Immediate f1-f5 guardrails:

- Keep using the current session binding as the single source of charter identity.
- Do not scan all active charters from `turn_end`.
- Keep metadata keys charter-scoped.
- Do not implement multi-charter runner behavior inside this charter.

## 11. Cost and turn ceiling (VAL-R10)

### Default ceiling

Per charter, default Ralph-loop ceilings are:

- `turns`: 20 Ralph-triggered continuation turns.
- `wallclockMs`: 14,400,000 ms (4 hours) from `state.createdAt`.
- `tokens`: advisory only until Pi exposes reliable per-extension token accounting.

### Override mechanism

Use the existing create budget field:

```ts
charter_manage({
  action: "create",
  objective,
  budget: {
    turns: 40,
    wallclockMs: 8 * 60 * 60 * 1000,
    tokens: 500_000,
  },
})
```

If `budget.turns` or `budget.wallclockMs` is present, it overrides the default. If only `tokens` is present, pi-charter should surface it in status/reminders but cannot enforce it until token usage is available.

For f1-f5, the manual design requirement is satisfied by this policy. Full persistent enforcement of turn counters and wallclock budget is not part of the implementation criteria in the current charter; add a future VAL if enforcement becomes required.

## 12. Final f1-f5 VAL list (VAL-R11)

The existing f1-f5 VAL list is confirmed and implementation may begin after this design doc is reviewed and evidence is recorded.

No charter amendments are required before f1-f5:

- **f1 Ralph loop**: VAL-1 through VAL-6 correctly test actionable verdict continuation, non-actionable suppression, terminal/dormant suppression, and same-verdict dedup.
- **f2 evaluator skip/quiet planning**: VAL-7 through VAL-9 correctly test empty planning skips and non-empty planning evaluation in `tests/evaluator.test.ts`.
- **f3 widget ticker**: VAL-10 through VAL-12 correctly test a 5s elapsed ticker coexisting with the 120ms spinner and being cleared on dispose.
- **f4 skill tighten**: VAL-13 through VAL-22 correctly test short description, delegation guidance, and task hygiene.
- **f5 reminders bridge**: VAL-23 through VAL-29 correctly test event-bus-only reminder registration, unregister, text, cadence constant, and no-op behavior.

Known follow-ups outside this charter:

- Persistent enforcement of Ralph turn/wallclock ceilings.
- Multi-charter binding and arbitration.
- `charter_run` / batch dispatch.
- Filtering in-flight widget subagents by `charterId` if multi-charter sessions are introduced.
