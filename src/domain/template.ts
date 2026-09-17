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

<!-- Phases are optional. Add them only when they help explain the route. -->
`;
}
