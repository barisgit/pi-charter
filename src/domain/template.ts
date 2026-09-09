export function renderCharterTemplate(objective: string): string {
  return `# Objective

${objective.trim()}

<!-- Keep the Objective substantial and explicitly bounded: state the outcome,
     why it matters, and important constraints. This file is the authored source
     of truth; lifecycle tools do not edit its content. -->

## References

<!-- Optional durable links to specs, plans, ADRs, docs, or code. Delete this
     section when there are none. -->

## Scope

<!-- Optional in-scope and out-of-scope boundaries. Delete when unnecessary. -->

## Phases

1. Explore phases

<!-- Add, split, rename, or finish phases as the work becomes understood:

     1. Explore phases — done
        Findings and durable links may live in this indented body.
     2. Build the bounded outcome — current
     3. Verify through the real product — upcoming

     Status suffixes are optional: upcoming | current | done. When no phase is
     explicitly current, the first unfinished unmarked phase is current and
     other unmarked phases are upcoming. Phases organize the work; they do not
     gate completion and have no evidence schema, freshness, or dependencies.

     For user-visible verification, capture screenshots or recordings at the
     time of verification under work/ and link them from the relevant phase
     body. REPORT.md later curates already-linked evidence; never fabricate
     retroactive evidence for the report. -->
`;
}
