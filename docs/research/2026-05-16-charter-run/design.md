# charter_run design — exploration doc

Status: **exploration**. No locked decisions. This doc enumerates the design
space so we can pick deliberately before any code lands.

Author: dogfood-driven; user-stated requirements at end of m2511–m2515.

---

## 1. What we're trying to build

A single tool the main agent calls **once** to hand off charter execution. After
the call, the main agent has no control: the runner pulls features from the DAG,
dispatches a configurable subagent chain per feature, gates feature completion
on chain success + criteria evidence, and continues until the charter is done or
fatally stuck.

User's words: *"agent calls run, has no control, resolves from DAG what can run
in parallel and runs fixer → reviewer → qa → verifier or some user-configurable
chain"*.

Wishlist on the tool surface:
- main agent specifies **sync | async**.
- main agent (potentially) specifies **worktree + worktree setup script**.
- runner resolves DAG parallelism.
- per-feature loop is configurable; default is `fixer → reviewer → qa →
  charter-verifier (loop)`.

This doc is intentionally scoped to **structure and configuration shape**. The
runtime/engine is mentioned only where it forces a structural choice.

---

## 2. What we already have to build on

| Thing | Status | Notes |
| --- | --- | --- |
| DAG resolver (`drift.readyNext[]`) | shipped | already filters by `preconditions` + non-terminal status |
| Async bridge (`subagent:async-*` → events) | shipped | `feature_started` / `feature_completed` / `feature_failed` already keyed off `pi-charter.featureId` metadata |
| `charter-verifier` persona | shipped | per-criterion, records evidence |
| `charter-planner-critic` persona | shipped | adversarial planner |
| `lock_plan` planDigest | shipped | snapshot of the DAG at lock time |
| Hook bus (`charter:before_*`) | shipped | can veto state transitions |
| pi-subagents chain format | external | `.chain.md` files + inline `chain` arg on `subagent({...})` |
| pi-subagents `spawnRaw` | external | TS API via captured `SubagentExposedAPI`; bypasses LLM tool surface |

The async bridge is the load-bearing primitive. Anything we build dispatches
subagents tagged with `pi-charter.featureId` + `pi-charter.criterionId` and lets
the existing event handler keep the projection up to date.

---

## 3. The pi-subagents chain format (what we'd reuse or compete with)

Quick read from `~/Programming_local/Projects/pi-extensions/pi-subagents/`:

**File location**: `~/.pi/agent/agents/*.chain.md` or `<project>/.pi/agents/*.chain.md`.

**File shape** (markdown with frontmatter + H2-separated steps):

```
---
name: build-and-verify
description: Standard fixer→reviewer→qa→verifier chain.
---

## fixer
model: anthropic/claude-sonnet-4-6
reads: src/**/*.ts
output: artifacts/fixer.md

Implement the feature described in {task}. Address all VAL-* criteria in scope.

## reviewer
model: anthropic/claude-sonnet-4-6

Review {previous} for correctness and regression risk.

## qa
Build, lint, test. Report any failures with reproduction steps.

## charter-verifier
Verify the feature against its VAL-* criteria. Record evidence.
```

**Step config keys**: `output | reads | model | skills | progress`. The task
body is everything below the first blank line in each H2 section.

**Inline form** (already used in `subagent` tool descriptions):
```ts
subagent({ chain: [
  { agent: "fixer", task: "..." },
  { parallel: [{ agent: "reviewer", task: "..." }, { agent: "qa", task: "..." }] },
  { agent: "charter-verifier", task: "..." }
]})
```

**Variables** documented in pi-subagents help: `{task}` = original input,
`{previous}` = prior step's stdout, `{chain_dir}` = shared artifact dir.

What pi-subagents chains **do not** have today (relevant to us):
- No loop / retry-until-pass semantics.
- No completion gate beyond "all steps exited 0".
- No notion of "feature" or "criterion".
- No structured handoff envelope back to a caller.

We will need at least loop semantics. Whether we get them by extending pi-subagents'
chain format or by layering our own runner on top is a real decision (see §6).

---

## 4. Layers of structure (where chain defs could live)

This is the first big decision. Five plausible homes:

### 4.1 Option A — User `.chain.md` in repo (pi-subagents native)

Charter doesn't define a chain format. User drops `.pi/agents/charter-build.chain.md`
in their project. `charter_run` reads a `runChain: <name>` field from `charter.md`
frontmatter (or `state.json`), looks it up via pi-subagents discovery, dispatches.

**Pros**:
- Zero new format. Anything pi-subagents grows for free comes along.
- One discovery path for the user.
- The user already knows how to author these from working with pi-subagents.

**Cons**:
- Couples charter to pi-subagents availability (today this is OK — bridge already
  required).
- pi-subagents chains have no loop primitive. Verifier-loop has to be
  implemented somewhere — likely on the charter side as outer orchestration.
- Discovery surface is wide (user + project + bundled). Hard to predict which
  chain wins on a given machine.

### 4.2 Option B — Charter-managed inline config

`charter.md` (or a sibling `charter-run.md`) carries the chain inline:

```md
## Run config
chain:
  - agent: fixer
    task: Implement {featureId}. Address {fulfills}.
  - agent: reviewer
  - agent: qa
  - agent: charter-verifier
    loop_until: pass
    max_attempts: 3
```

`charter_run` parses this directly. No pi-subagents `.chain.md` lookup.

**Pros**:
- Self-contained. The charter ships with its own execution policy.
- We control the loop/gate primitives.
- One file to read, one file to review in planner-critic.

**Cons**:
- New format the user must learn. Doesn't reuse pi-subagents tooling.
- Either we re-implement chain execution, or we still call pi-subagents'
  `spawnRaw` per step (likely yes — we shouldn't reinvent stream handling).

### 4.3 Option C — Charter-managed `.chain.md` (same format, different home)

Same on-disk format as pi-subagents `.chain.md`, but lives at
`.pi/charters/<id>/run/<chainName>.chain.md` and is loaded by us, not by
pi-subagents' discovery.

**Pros**:
- Reuses the format (no relearning).
- Self-contained per charter.
- Editable by the planner-critic, generatable by `charter_plan`-style helpers.
- Doesn't pollute pi-subagents' global namespace.

**Cons**:
- Same loop-primitive gap as A.
- Two reader paths for `.chain.md` in the ecosystem (user-side & charter-side)
  with slightly different semantics — risk of confusion.

### 4.4 Option D — Bundled-only with named overrides

Ship one or two opinionated chains in `pi-charter/chains/`:
`default.chain.md` (fixer→reviewer→qa→verifier-loop) and maybe
`fast.chain.md` (fixer→verifier-loop). User selects with `runChain: fast` in
charter.md. User can override with their own `.chain.md` only when really needed.

**Pros**:
- Zero config for 90% of cases — "it just works".
- Tight quality bar on the default chains.
- Easy to evolve over time (just patch the bundled file).

**Cons**:
- Less flexible if a user really wants a different shape.
- "Opinionated default" pressure: we have to actually be opinionated about what
  the right loop is.

### 4.5 Option E — Smarter charter-managed chain (data, not markdown)

Chain lives as structured data in `state.json` or a sibling JSON, populated by
`charter_run action=configure_chain` or by the planner-critic. No markdown
format at all on this side.

**Pros**:
- Tooling can read/write it without prose parsing.
- Subagent personas can mutate it (e.g. planner-critic might tighten the chain
  before lock_plan).
- No format-confusion risk with pi-subagents.

**Cons**:
- Loses human readability. `git diff` of `.json` is worse than `.chain.md`.
- Yet another schema to design.

### 4.6 Recommendation (not locked)

**A blend: D + escape hatch to A/C.**

- Ship `pi-charter/chains/default.chain.md` (reused `.chain.md` format).
- `charter_run` looks for chain in priority order:
  1. `charter.md` frontmatter `runChain: <name>` if set, resolved via
     pi-subagents discovery (so user `.chain.md` works).
  2. `.pi/charters/<id>/run/<name>.chain.md` (charter-local override).
  3. Bundled `pi-charter/chains/default.chain.md`.
- Loop semantics are charter-managed: a step can declare `loop_until: <agent>`
  and `max_attempts: N` in its `.chain.md` config block. pi-subagents itself
  doesn't have to understand it; we drive the loop on the charter side and call
  `spawnRaw` per step.

That gives:
- A familiar format (`.chain.md`).
- A "just works" default.
- A managed-data override path for power users.
- Loop primitives we own.

But it's a real choice — Options B/D alone would be simpler if we're willing to
take the format hit, and Option A alone is the least new code (at the cost of
no loop primitive).

---

## 5. Chain unit & scope (what gets a chain assigned to it?)

Independent of where chains live, we have to decide what a chain attaches to.

### 5.1 Charter-wide (one chain for the whole charter)

Simplest. `charter_run` reads one chain, applies it to every feature in the DAG.

**Pros**: trivial config, predictable.
**Cons**: features have different shapes — a "docs feature" doesn't need a fixer
step; a "ffi-helpers feature" doesn't need a reviewer.

### 5.2 Per-feature override

Default chain for the charter, plus `runChain: <name>` on a per-feature basis in
the feature's frontmatter.

**Pros**: targeted; matches feature heterogeneity.
**Cons**: harder to audit; planner-critic has to verify chain-feature pairings.

### 5.3 By verifier kind

Map: feature's criteria's `verifier:` kind (command / hook / prompt / manual) →
chain. E.g. command-verified features get `fixer→verifier-loop` (no need for
qa), prompt-verified features get the full chain.

**Pros**: derives chain from existing data; no extra config.
**Cons**: a feature can fulfill criteria with mixed verifier kinds; needs
fallback rules.

### 5.4 Recommendation (not locked)

**Default = charter-wide, with optional per-feature `runChain:` override.**

5.3 sounds clever but feature → criteria → verifierKind is a many-to-many; not
worth the precision until we see real charters where it matters.

---

## 6. Loop & gate semantics

The wishlist case: `fixer → reviewer → qa → charter-verifier-loop`. Means the
verifier can fail and the chain restarts at fixer (or some earlier point) up to
N times. This is the single biggest gap vs pi-subagents' linear chain.

### 6.1 Variants

#### V1 — Outer retry (whole chain restarts on verifier fail)

```
attempt:
  fixer → reviewer → qa → verifier
  if verifier == fail: retry from start (max N)
  if verifier == pass: feature_done
```

Simple to reason about. Wasteful when fixer's work is already fine and only the
verifier disagreed on a small thing.

#### V2 — Targeted loop (verifier → fixer → verifier)

```
fixer → reviewer → qa → loop:
  verifier
  if pass: feature_done
  if fail: fixer → verifier  (max N)
```

Closer to the user's stated wish. Skips reviewer/qa on retries (assumed: fixer
small patches don't need re-review). Risk: small patches break something
reviewer would have caught.

#### V3 — Configurable hold points

`.chain.md` step declares `loop_target: <earlier-step-name>`:

```
## charter-verifier
loop_target: fixer
max_attempts: 3
```

V2 is the special case of `loop_target: fixer`. V1 is `loop_target: <first step>`.

**Pros**: user picks the tradeoff per chain.
**Cons**: another knob.

### 6.2 Gate semantics

What counts as "step failed"?

- **Subprocess exit code** (existing async bridge signal). Trivial.
- **Subagent returned a `verdict: fail` in its summary**. Requires a structured
  return shape.
- **Verifier-specific**: only `charter-verifier` failure triggers loop; other
  steps failing is fatal.

The `charter-verifier` persona today returns `Verified <criterionId>: <outcome>
— <summary>` and records evidence directly. We don't read its output text — we
read the recorded evidence. So gate signal = "criterion-state.json shows pass
for every criterion in this feature's `fulfills[]`".

That's actually clean: **the gate is the existing criterion-state projection**,
not the subagent's exit code. Loop until projection says pass, or N attempts
exhausted.

### 6.3 Recommendation (not locked)

- Gate signal = **criterion-state projection for this feature's `fulfills[]`**.
  Not exit codes, not subagent summaries.
- Loop = V3 (configurable hold points), with V2 as the bundled default.
- `max_attempts` default 3; configurable per chain.

---

## 7. `charter_run` tool surface

Even with all the above pending, the tool shape is roughly:

```ts
charter_run({
  charterId: string,         // optional if exactly one active charter
  mode?: "sync" | "async",   // default async
  worktree?: {               // optional
    create: boolean,         // create new worktree (vs reuse cwd)
    setup?: string,          // shell snippet run after worktree creation
    keepOnFailure?: boolean, // don't tear down if run fails
  },
  features?: string[],       // optional subset; default = all readyNext features
                              // recursively until DAG drains
  chain?: string,            // optional override of resolved chain name
})
```

**Sync mode**: tool returns when the run terminates (success / fatal stall /
budget exceeded). LLM sees the final status.

**Async mode**: tool returns a `runId` immediately. Async bridge events fire as
features complete. Main agent can call `charter_status` to poll.

**Worktree**: optional. The runner can shell out to `git worktree add`, run
`setup` (e.g. `bun install`), spawn subagents with their cwd set to the
worktree, and `git worktree remove` on success. This is mostly orthogonal to the
chain question — the chain runs the same way; only the cwd shifts.

### 7.1 Decisions still open in §7

- **Do we allow per-call overrides for chain, or is it always resolved from
  config?** Recommendation: yes, allow `chain:` override for ad-hoc runs.
- **Should `features:` accept a milestone label?** Only worth it if we keep
  milestones. See §9.
- **What does `charter_run` do if the charter is `planning`?** Recommendation:
  hard-fail with "lock_plan first". Reuse the existing FSM gate.

---

## 8. Worktree integration

User's wishlist mentions `worktree + worktree setup script`. Three plausible
shapes:

### 8.1 Per-run worktree

`charter_run({ worktree: { create: true } })` creates **one** worktree, all
parallel features run inside it. Simple but parallel features can collide on
the same files.

### 8.2 Per-feature worktree

Every dispatched feature gets its own worktree (`.worktrees/<featureId>-<runId>`).
Parallel features are fully isolated. Verifier-loops re-enter the same
worktree.

**Pros**: clean parallelism story. Setup script runs once per worktree.
**Cons**: N × worktree disk cost. Setup script (e.g. `bun install`) runs N times
unless we cache.

### 8.3 Worktree per parallel group

Hybrid: serial-step features share the charter cwd; parallel-group features
each get their own worktree.

**Pros**: pays the worktree cost only when parallelism needs it.
**Cons**: harder mental model.

### 8.4 Recommendation (not locked)

**Per-feature worktree as default for parallel branches; reuse cwd for serial
runs.** Mostly because dogfood charters have shown features touching overlapping
files often — even when `preconditions[]` says serial.

Open: who decides which features run parallel? See §9.

---

## 9. Parallelism resolution

User wants the runner to pull from the DAG and run in parallel where possible.
The DAG is `preconditions[]` per feature. Two parallel-resolution policies:

### 9.1 Strict — only features whose preconditions are all `feature_completed`

Run sequentially-when-required, in parallel only when truly independent.

### 9.2 Optimistic — features whose preconditions are at least `feature_started`

Lets later features start while earlier ones are verifying. Higher throughput;
risk of cascade-rework if early feature fails.

### 9.3 Worker pool sizing

- Hard concurrency cap (e.g. `max_parallel: 3` in charter config).
- Cap = number of ready features (no cap).
- Cap derived from `subagent({async: true})` slot count.

### 9.4 Recommendation (not locked)

Strict + configurable cap (`max_parallel: 3` default). Optimistic mode is an
opt-in future knob.

This also closes the milestone question: **we don't need milestones for
parallelism — the DAG already tells us.** Milestones could come back as a UX
grouping in the widget, but the runner doesn't need them.

---

## 10. Failure modes (what the doc has to answer)

Before any code:

1. **Chain step subagent crashes / OOMs** — runner sees `feature_failed`. Retry
   step N times? Mark feature stuck? Recommendation: retry-step 1×, then mark
   feature `stuck` and continue with other ready features (run doesn't die on
   one bad feature).
2. **Verifier-loop exhausts `max_attempts`** — mark feature `stuck`, record an
   evidence entry with `outcome: fail`, surface in `charter_status` drift, run
   continues with other features.
3. **All ready features stuck** — runner terminates with "fatally stuck"
   status; charter stays `active`; main agent can re-call `charter_run` after
   intervention.
4. **Worktree merge conflict on `git worktree remove`** — leave worktree, surface
   path in the run summary, charter stays `active`.
5. **Charter paused mid-run** — runner aborts pending dispatches, lets in-flight
   features finish, terminates.
6. **Main agent calls `charter_run` while another run is in flight** — error
   with the current runId.

---

## 11. What gets persisted

Per-run on disk under `.pi/charters/<id>/runs/<runId>/`:

- `run.json` — `{ runId, startedAt, endedAt?, mode, chainName, worktreeRoot?,
  features[], status }`.
- `feature-attempts.jsonl` — one line per attempt (which step, which agent,
  exit, duration, evidence-recorded).
- `worktree.json` — if worktrees used.

events.jsonl gains:
- `run_started { runId, chainName, features[] }`
- `run_completed { runId, status, durationMs }`
- `attempt_started { runId, featureId, step }`
- `attempt_completed { runId, featureId, step, exitCode }`

Feature/criterion state projection unchanged — driven by existing
`feature_started/completed/failed` and evidence events.

---

## 12. Decisions that block implementation (must resolve before code)

In rough priority:

1. **§4 — chain home**: A vs C vs D-with-escape. Locks the on-disk format.
2. **§6 — loop semantics**: pick V1, V2, or V3. Locks the runner's core loop.
3. **§5 — chain scope**: charter-wide-only, or per-feature override allowed.
4. **§7 — sync default vs async default**: probably async (charter is a
   long-running thing) but worth confirming.
5. **§9 — strict vs optimistic parallelism**: probably strict + cap.
6. **§8 — worktree default**: per-feature vs per-run.
7. **§3 — extend pi-subagents `.chain.md` parser with `loop_until` keys, or
   handle loop on our side and treat pi-subagents chain as linear**: this is the
   only cross-extension contract change candidate.

---

## 13. Decisions deferred (won't block initial cut)

- Milestone field future. Run logic doesn't need it; widget grouping might want
  it. Decide after run lands.
- Optimistic parallelism mode.
- Cross-feature shared `chain_dir` artifact reuse.
- TUI approver hook for run start (`charter:before_run` candidate event).
- Auto-applied handoff envelopes from subagent summaries (current `NEXT.md`
  open ladder item).
- Whether `charter_run` is one new tool or an action on `charter_manage`.
  Likely new tool — `charter_manage` is lifecycle FSM; run is dispatcher.

---

## 14. Tradeoffs summary table

| Decision | Cheapest | Most flexible | My pick (advisory) |
| --- | --- | --- | --- |
| Chain home (§4) | A (pi-subagents native) | C (charter-local `.chain.md`) | D with A/C escape |
| Chain scope (§5) | Charter-wide | Per-feature override | Charter-wide + per-feature override |
| Loop (§6) | V1 outer retry | V3 configurable | V3, default V2 |
| Gate (§6.2) | Exit code | Criterion projection | Criterion projection |
| Sync/async (§7) | Sync | Both | Async default |
| Worktree (§8) | None | Per-feature | Per-feature default, opt-out |
| Parallelism (§9) | Strict, cap=1 | Optimistic, unbounded | Strict, cap=3 |
| pi-subagents extension (§3) | None | Loop keys in chain format | None — loop on our side |

---

## 15. Open questions for the user

Things this doc cannot resolve alone:

1. **Chain home (§4)** — do you want `.chain.md` files visible/editable in the
   repo, or chain inline in `charter.md`, or both-with-a-default?
2. **Loop policy (§6)** — V2 (your stated wish) or V3 (let chain author pick)?
3. **Worktree default (§8)** — should `charter_run` create worktrees by default,
   or opt-in via the `worktree:` arg?
4. **`fixer` is currently a generic pi-subagents persona** — do we want a
   `charter-fixer` persona bundled with charter, or reuse pi-subagents' `fixer`?
   Same for `reviewer` / `qa`. (Recommendation: reuse pi-subagents personas for
   `fixer / reviewer / qa`, bundle only charter-specific personas.)
5. **Does the run need a `.chain.md` extension to pi-subagents** (e.g. our own
   `loop_until` key), or do we keep loop logic entirely charter-side? Affects
   whether pi-subagents grows a new feature.

---

## 16. What this doc does not cover

- Widget redesign (separate thread; queued behind run design).
- pi-reminders bridge (separate thread; deferred).
- pi-dag-tasks merge (mentioned in m2438 as an aside; not in scope here).
- Detailed runner state machine (write after §12 resolves).
- Test plan (write after structure locks).
