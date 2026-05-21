import { describe, expect, test } from "bun:test";
import { parseFeatureMarkdown } from "../src/domain/feature-md";

function featureMarkdown(frontmatter = "", body = "# Feature"): string {
  return `---
id: f1-validation-parser
milestone: m1-data-model
order: 10
fulfills:
  - VAL-VALIDATION-PARSER
preconditions: []
${frontmatter}---

${body}
`;
}

describe("v2 feature validation parser", () => {
  test("happy-path: valid block with 2 happy + 2 edge checks parses", () => {
    const feature = parseFeatureMarkdown(featureMarkdown("kind: impl\n", `# Feature

## Validation

### Happy
- check: parses-happy
  command: bun test tests/v2-validation-parser.test.ts -t happy
- check: follows-redirect
  command: curl -s -o /dev/null -w "%{http_code}\\n" \\
    http://localhost:3000/callback \\
    | grep -q 302

### Edge
- check: rejects-expired
  command: bun test tests/v2-validation-parser.test.ts -t expired
- check: rejects-csrf
  command: bun test tests/v2-validation-parser.test.ts -t csrf
`));

    expect(feature.kind).toBe("impl");
    expect(feature.checks.happy).toEqual([
      { id: "parses-happy", command: "bun test tests/v2-validation-parser.test.ts -t happy" },
      {
        id: "follows-redirect",
        command: "curl -s -o /dev/null -w \"%{http_code}\\n\" \\\nhttp://localhost:3000/callback \\\n| grep -q 302",
      },
    ]);
    expect(feature.checks.edge).toEqual([
      { id: "rejects-expired", command: "bun test tests/v2-validation-parser.test.ts -t expired" },
      { id: "rejects-csrf", command: "bun test tests/v2-validation-parser.test.ts -t csrf" },
    ]);
  });

  test("kind-default: feature without kind: defaults to 'impl'", () => {
    const feature = parseFeatureMarkdown(featureMarkdown());

    expect(feature.kind).toBe("impl");
  });

  test("kind-readiness: 'kind: readiness' parses", () => {
    const feature = parseFeatureMarkdown(featureMarkdown("kind: readiness\n"));

    expect(feature.kind).toBe("readiness");
  });

  test("back-compat: feature without ## Validation parses with no checks", () => {
    const feature = parseFeatureMarkdown(featureMarkdown("", "# Feature\n\nNo validation block yet."));

    expect(feature.checks).toEqual({ happy: [], edge: [] });
  });

  test("duplicate-id-rejected: two happy checks with same id => parse error", () => {
    expect(() => parseFeatureMarkdown(featureMarkdown("", `# Feature

## Validation

### Happy
- check: duplicate
  command: bun test one
- check: duplicate
  command: bun test two
`))).toThrow(/duplicate validation check id/i);
  });

  test("unknown-kind-rejected: 'kind: bogus' => parse error", () => {
    expect(() => parseFeatureMarkdown(featureMarkdown("kind: bogus\n"))).toThrow(/unknown feature kind/i);
  });
});
