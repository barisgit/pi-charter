/**
 * create-scaffold template (ADR-0014).
 *
 * The template carries the whole teaching load: grammar, evidence doctrine,
 * open-ended semantics. Guidance lives in HTML comments (inert to the parser,
 * deletable by the agent). The example criterion is INSIDE a comment so a
 * fresh charter has zero live criteria (= open-ended until authored).
 */

export function renderCharterTemplate(objective: string): string {
  const title = objective.split(/[.\n]/)[0].trim().slice(0, 80) || "untitled";
  return `# Charter: ${title}

<!-- This file is the single source of truth for this charter.
     You (the agent) edit it directly — there is no tool for editing
     criteria or recording evidence. The runtime re-reads it after your
     edits. Grammar the runtime parses:

       ## Objective                       — required, prose
       ## Criteria                        — required section
       ### C<n>. <title>                  — one heading per criterion
       Depends: C1, C2                    — optional line, advisory ordering only
       Evidence: pass|fail|none — <note>  — one line per criterion

     Everything else (## Scope, grouping headings, prose) is yours. -->

## Objective

${objective.trim()}

## Scope

<!-- Optional: what is in and out of bounds. Delete if not needed. -->

## Criteria

<!-- Each criterion is an observable pass condition — something you can
     prove by driving the real thing. Write the title as an assertion
     you could read aloud ("X does Y"), not a task ("do X"). Below the
     title, optionally describe HOW to verify: the command, the budget
     or threshold, known failure modes.

     Evidence rules:
     - "Evidence: none" until you have actually verified it.
     - After verifying:
         Evidence: pass — <what you ran and what it showed> (date)
         Evidence: fail — <what failed and why> (date)
     - Record real output, not intentions. Completion requires every
       criterion to have pass evidence, re-verified if source changed
       after it was recorded (the runtime tracks this).

     Evidence quality, strongest first — prefer the strongest that fits:
     1. Use it like a user would: start the real app/server, drive the
        actual flow (subagent or browser automation if needed), and save
        a screenshot or recording into this charter's work/ directory.
        Reference it from the note, e.g.
          Evidence: pass — drove checkout on dev server, order confirmed;
          recording: work/c2-checkout.webm (2026-07-02)
     2. Observe the real system: run the CLI on real input, curl the
        live endpoint; paste or save the real output.
     3. Run the checks: tests/typecheck/lint. Weakest — fine on its own
        only for criteria that are purely about code behavior.
     Before citing an artifact, inspect it yourself: open the screenshot,
     replay the recording. If it does not show the built thing working,
     the criterion is not verified.

     A charter with NO criteria is open-ended: it never completes and
     runs until paused or abandoned. Add criteria when the work becomes
     boundable.

     Example criterion (copy the shape, replace the content):

     ### C1. Checkout flow completes end to end
     Start the dev server, add an item, pay with the test card.
     Confirmation screen must show the order id.
     Evidence: none

     ### C2. No regression in the existing test suite
     Depends: C1
     Evidence: none
-->
`;
}
