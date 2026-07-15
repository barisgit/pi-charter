---
title: pi-charter unified Status redesign
read_minutes: 8
theme: dark
---

{% hero kicker="pi-charter · ADR-0015 redesign" title="One authored Status line now carries the charter from intent to verified outcome." meta="<b>Audience</b> pi-charter users and maintainers · <b>Scope</b> design, runtime, prompts, examples" %}
The redesign restores durable meaning to substantial charters without restoring ceremony: richer authored context enters once, one criterion record changes over time, and every runtime surface projects that same model at the right level of detail.
{% /hero %}

{% brief verdict="The redesign unified criterion activity and evidence, then carried richer charter meaning through runtime, widget, dashboard, Ralph, and reports." why="The old Evidence-only line could prove an outcome but could not say what was pending, active, or blocked; terse criteria also converged on tactical task lists." next="Use the compact widget to answer what is happening now, `/charters` to understand the whole contract, and the scaffold examples to author criteria with durable semantics." /%}

{% section claim="The criterion model now has one source of truth instead of two competing records." %}
A criterion now owns exactly one authored line: `Status: pending|in-progress|blocked|pass|fail — <note>`. The value describes current activity or verification outcome; the note carries blocker context or the observation that justifies pass/fail. Staleness remains computed rather than becoming another authored flag.

{% compare %}
{% side label="Before · outcome-only" %}
```markdown
### C1. Checkout works
Evidence: none
```

The file could not distinguish untouched, active, or blocked work. Adding activity elsewhere would create competing truth.
{% /side %}
{% side label="After · one evolving record" after=true %}
```markdown
### C1. Checkout completes with an order id
A shopper can complete the real flow; declined payments remain editable.
Status: in-progress — exercising the dev checkout
```

The same line later becomes pass or fail with the observation.
{% /side %}
{% /compare %}

{% depth title="Exact status semantics" %}
- `pending`: meaningful work has not started; note optional.
- `in-progress`: current work; note says what is happening.
- `blocked`: work cannot advance; note gives the concrete blocker.
- `pass`: verified; note must say what was observed and may link `work/` artifacts.
- `fail`: verification failed; note says what failed and why.

Any non-pass blocks completion. Only pass can become stale. `Depends:` remains advisory.
{% /depth %}

{% take id="status-model" prompt="Does one Status line feel sufficient for both activity and verified outcomes?" /%}
{% /section %}

{% section claim="The runtime is now one rich-content pipeline from charter.md to every projection." wide=true %}
The parser retains Objective, optional References and Scope, criterion titles, bodies, dependencies, statuses, and notes. Snapshots and journal events use that same model; services add computed freshness and legal actions; each consumer selects only the detail it needs.

{% diagram kind="flow" hot="status service" caption="The accent marks the shared projection boundary; no UI invents a second criterion model." wide=true %}
charter.md: authored contract
parser: tolerant rich grammar
snapshot + journal: lifecycle history + status sequence
status service: content + counts + blockers + freshness + nextActions
Ralph: condensed steering
widget: current work + compact progress
dashboard: full charter + history
REPORT.md: curated outcome
charter.md -> parser -> snapshot + journal -> status service
status service -> Ralph
status service -> widget
status service -> dashboard
status service -> REPORT.md
{% /diagram %}

The storage boundary also normalizes old `evidence`/`evidenceSeq` sidecars to `status`/`statusSeq` without resetting freshness. New journal fields are `status.value` and `status.note`; old `evidence.status` rows still contribute to failure history.

```ts {% file="src/application/service.ts" hl="1-8" %}
interface CriterionStatusView {
  id: string
  title: string
  body: string
  status: "pending" | "in-progress" | "blocked" | "pass" | "fail"
  note: string
  stale: boolean
  depends: string[]
}
```

{% depth title="Completion and freshness stayed strict" %}
Completion still requires at least one criterion, every criterion at fresh pass, a non-empty pass note, and a curated `REPORT.md`. Global sequence-counter staleness remains advisory during work and a hard rejection at completion. The charter still records evidence; it never runs verification itself.
{% /depth %}

{% take id="runtime-flow" prompt="Is any projection still carrying information that belongs in a different layer?" /%}
{% /section %}

{% section claim="The widget is compact while the dashboard is comprehensive." wide=true %}
The compact widget answers one question: what is happening now? It prioritizes `in-progress`, then `blocked`, `fail`, and `pending`, labels the row as Current, Blocked, or Next, and keeps progress width-safe. The `/charters` dashboard answers the larger question: what does this charter mean and why is it not complete?

{% img src="assets/pi-charter-dashboard.jpg" frame="browser" url="pi /charters" caption="The dashboard now shows authored context, five criterion states, notes, dependencies, stale pass, and recent transitions in one read-only surface." /%}

{% compare %}
{% side label="Compact widget" %}
- lifecycle and elapsed time
- pass/active/pending progress
- one current or next criterion
- Ralph countdown when active

It deliberately omits Objective, References, Scope, and bodies.
{% /side %}
{% side label="Full dashboard" after=true %}
- Objective, References, and Scope
- substantive criterion bodies
- status, note, dependency, stale marker
- completion blockers and progress
- recent status transitions and terminal report
{% /side %}
{% /compare %}

{% aside caution=true %}
The screenshot also exposes follow-up polish: criterion rows still inherit an eight-column inset from the removed hierarchical plan renderer, blocked and fail share a red cross, very wide terminals need a stronger reading measure, and repeated recent-status rows should be deduplicated. Those are presentation defects, not model gaps.
{% /aside %}

{% take id="ui-hierarchy" prompt="Does the widget/dashboard split match how you inspect work in practice?" /%}
{% /section %}

{% section claim="The scaffold is richer while its guidance remains non-coercive." %}
The create template carries the grammar and evidence doctrine inside inert HTML comments. A fresh charter has zero live placeholders, so examples can teach a realistic shape without producing fake criteria. The guidance encourages enough semantic detail to survive compaction or handoff while explicitly rejecting padding, word counts, and implementation-task decomposition.

```diff {% title="What the scaffold teaches now" %}
@@ authored contract @@
- ## Objective
- ## Criteria
- ### C<n>. <title>
- Evidence: pass|fail|none — <note>
+ ## Objective
+ ## References                         # optional durable pointers
+ ## Scope                              # optional boundaries
+ ## Criteria
+ ### C<n>. <concise observable title>
+ <expected behavior, boundaries, important cases>
+ Depends: C1, C2                       # optional, advisory
+ Status: pending|in-progress|blocked|pass|fail — <note>
```

The prompt layer repeats only what is needed at decision time. Tool guidance says to edit charter.md and its Status lines. Ralph reports five-way counts, the top blocker, stale passes, repeated failures, and one next criterion. The skill explains when to use a charter, how to separate durable criteria from pi-dag-tasks, and how to curate `REPORT.md` from evidence already captured during verification.

{% depth title="The examples changed in four important ways" %}
1. Objectives explain why the outcome matters and name important constraints.
2. References point to durable specs, plans, handoffs, ADRs, docs, or code—not mutable progress.
3. Criteria pair concise observable titles with bodies that preserve behavior and boundaries.
4. Substantial work is gently guided toward roughly 10–20 natural criteria, with explicit instructions never to pad the count.

The examples do not introduce `Verify by:`, milestones, feature decomposition, or another evidence/activity field.
{% /depth %}

{% take id="prompt-guidance" prompt="Would these examples make you author better criteria without feeling over-prescriptive?" /%}
{% /section %}

{% section claim="Compatibility and tests make the redesign adoptable without a migration ceremony." %}
Existing `Evidence: pass|fail|none — <note>` lines remain readable only as a legacy input alias; `none` maps to pending and canonical Status wins if both appear. Old storage and journal shapes normalize at their boundaries, while all new scaffolds, runtime projections, docs, and examples expose Status exclusively.

{% chart kind="bar" title="Final automated verification" hot="passing tests" caption="The accent marks the complete passing suite after the independent review fix." %}
passing tests: 89
failing tests: 0
source files with parallel Evidence model: 0
{% /chart %}

The complete suite passed 89 tests across 11 files with 552 assertions, plus TypeScript checking and `git diff --check`. Independent review approved the redesign after identifying one dashboard-history bug: historical rows borrowed the current note. The implementation now pairs value and note events by criterion and sequence, with a regression test.

{% depth title="Where the decision is recorded" %}
- `docs/adr/0015-unify-criterion-status-and-evidence.md`
- `CONTEXT.md`
- `docs/implementation/`
- `skills/pi-charter/SKILL.md`
- `src/domain/template.ts`
- `src/domain/charter-file.ts`
{% /depth %}

{% take id="compatibility" prompt="Is the legacy-read/new-write boundary clear enough to remove migration anxiety?" /%}
{% /section %}
