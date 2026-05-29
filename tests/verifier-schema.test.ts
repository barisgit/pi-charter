import { describe, expect, test } from "bun:test";
import { parseCharterMarkdown } from "../src/domain/charter-md";
import { validateVerifier } from "../src/domain/verifier";

describe("verifier schema extension", () => {
  test("verifier schema accepts subagent kind with agent and task", () => {
    const verifier = { kind: "subagent", agent: "charter-reviewer", task: "Review f3." } as const;

    const result = validateVerifier(verifier);

    expect(result).toEqual({ ok: true, value: verifier });
  });

  test("verifier schema accepts evidence-exists kind with evidenceKind", () => {
    const verifier = { kind: "evidence-exists", evidenceKind: "qa" } as const;

    const result = validateVerifier(verifier);

    expect(result).toEqual({ ok: true, value: verifier });
  });

  test("verifier schema rejects subagent kind without agent field", () => {
    const result = validateVerifier({ kind: "subagent", task: "Review f3." });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agent");
  });

  test("verifier schema rejects unknown kind", () => {
    const result = validateVerifier({ kind: "bogus" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Unknown verifier kind: bogus");
  });

  test("parser extracts Verifier: subagent block from charter.md", () => {
    const parsed = parseCharterMarkdown([
      "# Charter",
      "",
      "## Objective",
      "",
      "Verifier parser.",
      "",
      "## Criteria",
      "",
      "### VAL-SUBAGENT-001 — Subagent verifier",
      "Description: Subagent verifier parses.",
      "Verifier: subagent",
      "Agent: charter-reviewer",
      "Task: Review feature f3-verifier-schema-extension.",
      "",
    ].join("\n"));

    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0].verifier).toBe("subagent");
    expect(parsed.criteria[0].verifierSpec).toEqual({
      kind: "subagent",
      agent: "charter-reviewer",
      task: "Review feature f3-verifier-schema-extension.",
    });
  });
});
