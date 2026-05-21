import { describe, expect, test } from "bun:test";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";

const ARTIFACT_KINDS = [
  "screenshot",
  "video",
  "playwright_trace",
  "har",
  "terminal_capture",
  "console_log",
  "server_log",
  "http_trace",
  "dom_snapshot",
  "a11y_audit",
  "diff",
  "file",
] as const;

function qaEvidence(artifacts: Array<{ kind: typeof ARTIFACT_KINDS[number]; path: string; caption?: string }>) {
  return {
    kind: "qa",
    featureId: "f1-artifacts-schema",
    milestone: "m1-schema",
    surfaces: ["typed qa evidence schema"],
    outcome: "pass",
    artifacts,
    findings: [],
    summary: "QA artifact evidence shape is valid.",
    because: "The QA record uses the v2.1 artifacts array shape.",
  };
}

describe("v2.1 qa artifacts schema", () => {
  test("accepts every artifact kind", () => {
    const result = validateEvidenceFile(qaEvidence(ARTIFACT_KINDS.map((kind) => ({
      kind,
      path: `captures/${kind}.txt`,
    }))));

    expect(result.ok).toBe(true);
  });

  test("accepts relative path", () => {
    const result = validateEvidenceFile(qaEvidence([
      { kind: "screenshot", path: "captures/homepage.png" },
    ]));

    expect(result.ok).toBe(true);
  });

  test("accepts empty artifacts array", () => {
    const result = validateEvidenceFile(qaEvidence([]));

    expect(result.ok).toBe(true);
  });

  test("rejects absolute path", () => {
    const result = validateEvidenceFile(qaEvidence([
      { kind: "screenshot", path: "/tmp/homepage.png" },
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("artifact path must be relative");
  });

  test("rejects legacy screenshots field", () => {
    const result = validateEvidenceFile({
      kind: "qa",
      featureId: "f1-artifacts-schema",
      milestone: "m1-schema",
      surfaces: ["typed qa evidence schema"],
      outcome: "pass",
      screenshots: ["captures/legacy.png"],
      findings: [],
      summary: "Legacy screenshots field should fail.",
      because: "QA evidence must migrate to artifacts[].",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("qa evidence uses legacy screenshots[] field; migrate to artifacts:[{kind, path, caption?}]");
  });

  test("rejects parent-dir escape", () => {
    const result = validateEvidenceFile(qaEvidence([
      { kind: "screenshot", path: "captures/../secret.png" },
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must not contain '..' segments");
  });

  test("rejects caption over 280 chars", () => {
    const result = validateEvidenceFile(qaEvidence([
      { kind: "screenshot", path: "captures/homepage.png", caption: "a".repeat(281) },
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("280");
  });

  test("accepts unicode caption", () => {
    const result = validateEvidenceFile(qaEvidence([
      { kind: "screenshot", path: "captures/homepage.png", caption: "Validated 日本語 caption with emoji 😊" },
    ]));

    expect(result.ok).toBe(true);
  });
});
