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
  test("charter_plan add_feature rejects the single-entry shape at the runtime guard", () => {
    // Schema boundary cannot reject this payload anymore: the flat schema (required
    // for OpenAI strict-mode compatibility — see CharterPlanParams comment) lists
    // id/milestone/order/fulfills/body as top-level Optional fields (needed for
    // update_feature). The runtime guard in the execute handler enforces the
    // legacy purge boundary by requiring a non-empty features[] array.
    const tool = registeredTools().get("charter_plan")!;
    const schema = tool.parameters;

    // The flat schema accepts the legacy payload at the boundary — this proves
    // the rejection had to move to runtime.
    expect(Check(schema as never, {
      action: "add_feature",
      id: "f-legacy",
      milestone: "m1",
      order: 1,
      fulfills: ["VAL-ONE"],
      body: "legacy single entry",
    })).toBe(true);

    // The runtime guard in registration.ts catches it with a message that
    // points the caller at the canonical features:[{...}] shape.
    const source = Bun.spawnSync({
      cmd: ["grep", "-n", "features array must be non-empty", "src/application/registration.ts"],
      stdout: "pipe",
    });
    const out = source.stdout.toString();
    expect(out).toMatch(/features array must be non-empty for charter_plan action=add_feature/);
    expect(out).toMatch(/legacy single-entry shape.*rejected/);
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

  test("parseEvidence rejects QA evidence that only uses screenshots", () => {
    expect(() => parseEvidence({
      kind: "qa",
      featureId: "f1",
      milestone: "m1",
      surfaces: ["cli"],
      outcome: "pass",
      screenshots: ["captures/legacy.png"],
      findings: [],
      summary: "Legacy QA passed.",
      because: "Legacy screenshots are no longer accepted.",
    })).toThrow(/screenshots: is no longer supported/);
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
