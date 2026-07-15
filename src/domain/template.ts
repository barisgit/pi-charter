/**
 * create-scaffold template (ADR-0014/0015).
 *
 * HTML comments carry the teaching load and are inert to the parser. Example
 * criteria stay inside the comment so a fresh charter is intentionally
 * open-ended until the agent authors real success conditions.
 */

export function renderCharterTemplate(objective: string): string {
  const title = objective.split(/[.\n]/)[0].trim().slice(0, 80) || "untitled";
  return `# Charter: ${title}

<!-- This file is the single authored source of truth for the charter.
     Edit it directly; there is no tool for editing criteria or recording
     evidence. The runtime parses only this grammar:

       ## Objective
       ## References                                      — optional durable pointers
       ## Scope                                           — optional boundaries
       ## Criteria
       ### C<n>. <concise observable title>
       <criterion body: expected behavior, boundaries, important cases>
       Depends: C1, C2                                    — optional, advisory only
       Status: pending|in-progress|blocked|pass|fail — <note>

     Unknown headings and prose are inert. Do not add a second state or
     evidence field: the Status line is the criterion's whole live record. -->

## Objective

${objective.trim()}

<!-- Make the Objective descriptive enough to preserve why the work matters,
     what outcome should exist, and the important constraints. -->

## References

<!-- Optional durable pointers only: specs, plans, handoffs, ADRs, docs, or
     relevant code paths. Delete this section when there are none. Do not use
     it for mutable progress notes; criterion Status lines own current state. -->

## Scope

<!-- Optional in-scope and out-of-scope boundaries. Delete when unnecessary. -->

## Criteria

<!-- Write independently meaningful, observable success conditions, not an
     implementation task list. A substantial charter will often need roughly
     10–20 criteria; narrow work may need fewer. Never pad the count. Use each
     body to retain semantics the title cannot: expected behavior, boundaries,
     and important cases. Tactical steps belong in pi-dag-tasks, not here.

     Status meanings:
     - pending — meaningful work has not started; the note is optional.
     - in-progress — this criterion is current work; note what is happening.
     - blocked — progress cannot continue; note the concrete blocker.
     - pass — verified; the note must say what was observed and may link an
       artifact captured at verification time under work/.
     - fail — verification failed; the note must say what failed and why.

     Prefer the strongest fitting evidence in pass/fail notes:
     1. Use it like a user and capture a screenshot/recording in work/.
     2. Observe the real system through its actual UI, CLI, or endpoint.
     3. Run tests, typecheck, or lint for code-level behavior.
     Inspect every artifact before citing it. Staleness is computed globally:
     a pass recorded before a later source change is advisory in status and
     hard-blocks completion until re-verified. A charter with no criteria is
     open-ended and can only be paused or abandoned.

     Example shape (copy and replace; this comment creates no live criteria):

     ### C1. Checkout completes with a durable order confirmation
     A shopper can complete the real checkout flow with the test card. The
     confirmation includes an order id, and declined payments remain editable.
     Status: pending

     ### C2. Existing purchase behavior remains compatible
     Existing supported purchase paths keep their documented behavior and
     pass the relevant regression suite.
     Depends: C1
     Status: pending
-->
`;
}
