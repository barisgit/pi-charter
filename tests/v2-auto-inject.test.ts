import { describe, expect, test } from "bun:test";
import { parseFeatureMarkdown } from "../src/domain/feature-md";

function featureMarkdown(extraFrontmatter: string): string {
  return `---
id: f-legacy-auto-inject
milestone: m1
order: 1
${extraFrontmatter}fulfills:
  - VAL-LEGACY-AUTO-INJECT
preconditions: []
---

# Legacy frontmatter
`;
}

describe("v2 legacy auto-inject frontmatter", () => {
  test("review frontmatter is ignored for backwards-compatible reads", () => {
    const feature = parseFeatureMarkdown(featureMarkdown("review: definitely-not-a-current-policy\nreviewSkipRationale: old rationale\n"));

    expect(feature.id).toBe("f-legacy-auto-inject");
    expect(feature.kind).toBe("impl");
    expect(feature.fulfills).toEqual(["VAL-LEGACY-AUTO-INJECT"]);
  });

  test("targets frontmatter is ignored for backwards-compatible reads", () => {
    const feature = parseFeatureMarkdown(featureMarkdown("kind: review\ntargets:\n  - old-target\n"));

    expect(feature.kind).toBe("review");
    expect(feature.preconditions).toEqual([]);
  });
});
