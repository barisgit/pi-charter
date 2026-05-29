import { describe, expect, test } from "bun:test";
import { Check } from "typebox/value";
import { registerCharterTools } from "../src/application/registration";
import { parseEvidence } from "../src/domain/evidence-schemas";

interface FakeTool {
  parameters: unknown;
  execute?: (...args: unknown[]) => unknown;
}

function registeredTools(): Map<string, FakeTool> {
  const tools = new Map<string, FakeTool>();
  const pi: any = {
    events: { emit() {} },
    registerTool(tool: FakeTool & { name: string }) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return ""; },
    on() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  registerCharterTools(pi);
  return tools;
}

describe("legacy carrier purge", () => {
  test("removed planning tool is not registered on the public surface", () => {
    expect(registeredTools().has("charter_plan")).toBe(false);
  });

  test("charter_record evidence rejects the single-entry shape at the schema boundary", () => {
    const schema = registeredTools().get("charter_record")!.parameters;

    expect(Check(schema as never, {
      action: "evidence",
      criterionId: "VAL-ONE",
      outcome: "pass",
      summary: "legacy single entry",
      because: "single-entry fields are no longer accepted",
    })).toBe(false);
  });

  test("parseEvidence rejects legacy typed QA evidence", () => {
    expect(() => parseEvidence({ kind: "qa", featureId: "f1", outcome: "pass", summary: "x", ts: "2026-01-01T00:00:00.000Z" })).toThrow(/Legacy typed evidence/i);
  });

  test("purged legacy symbols are absent from src", () => {
    const symbols = [
      "LEGACY_QA_BRIEFS_DIR",
      "isLegacyQaEvidence",
      "legacy?: boolean",
      "input.legacy",
      "single-entry shape is deprecated",
      "legacy qa/ briefs dir is deprecated",
      "qa evidence uses deprecated screenshots",
      "<criterionId>__",
      "legacy flat",
      "normalizeLegacyQaEvidence",
      "warnedLegacyQaScreenshots",
    ];

    for (const symbol of symbols) {
      const result = Bun.spawnSync({ cmd: ["grep", "-RIn", symbol, "src"], stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, `${symbol}: ${result.stdout.toString()}`).toBe(1);
    }
  });
});
