import { describe, expect, test } from "bun:test";
import { trustRank } from "../src/domain/trust-rank";

describe("trustRank", () => {
  const cases: Array<{
    label: string;
    input: { recordedBy: string; source: "manual" | "verifier" | "subagent" | "hook"; hasBecause: boolean };
    expected: number;
  }> = [
    {
      label: "manual without because → 0",
      input: { recordedBy: "agent:root", source: "manual", hasBecause: false },
      expected: 0,
    },
    {
      label: "manual with because → 1",
      input: { recordedBy: "agent:root", source: "manual", hasBecause: true },
      expected: 1,
    },
    {
      label: "command (verifier) source → 2",
      input: { recordedBy: "agent:root", source: "verifier", hasBecause: false },
      expected: 2,
    },
    {
      label: "hook source → 2",
      input: { recordedBy: "agent:root", source: "hook", hasBecause: false },
      expected: 2,
    },
    {
      label: "subagent source ignores hasBecause and → 3",
      input: { recordedBy: "subagent:charter-reviewer:s", source: "subagent", hasBecause: false },
      expected: 3,
    },
    {
      label: "subagent source with because still → 3",
      input: { recordedBy: "subagent:charter-reviewer:s", source: "subagent", hasBecause: true },
      expected: 3,
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      expect(trustRank(c.input)).toBe(c.expected);
    });
  }

  test("ordering: subagent > command > manual+because > manual", () => {
    const manual = trustRank({ recordedBy: "agent:root", source: "manual", hasBecause: false });
    const manualBecause = trustRank({ recordedBy: "agent:root", source: "manual", hasBecause: true });
    const command = trustRank({ recordedBy: "agent:root", source: "verifier", hasBecause: false });
    const subagent = trustRank({ recordedBy: "subagent:charter-reviewer:s", source: "subagent", hasBecause: false });

    expect(manualBecause).toBeGreaterThan(manual);
    expect(command).toBeGreaterThan(manualBecause);
    expect(subagent).toBeGreaterThan(command);
  });
});
