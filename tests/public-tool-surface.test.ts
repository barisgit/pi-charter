import { describe, expect, test } from "bun:test";
import { registerCharterTools } from "../src/application/registration";

describe("public tool API", () => {
  test("registers exactly charter, charter_record, and charter_status", () => {
    const names: string[] = [];
    const pi: any = {
      events: { emit() {} },
      registerTool(desc: { name: string }) {
        names.push(desc.name);
      },
      registerFlag() {},
      on() {},
    };
    registerCharterTools(pi);
    expect(names.sort()).toEqual(["charter", "charter_record", "charter_status"]);
    expect(names).not.toContain("charter_manage");
    expect(names).not.toContain("charter_plan");
  });

  test("charter lifecycle schema exposes only create/pause/resume/complete/abandon", () => {
    const registered: Array<{ name: string; parameters: { properties: { action: { enum: string[] } } } }> = [];
    const pi: any = {
      events: { emit() {} },
      registerTool(desc: any) {
        registered.push(desc);
      },
      registerFlag() {},
      on() {},
    };
    registerCharterTools(pi);
    const charter = registered.find((tool) => tool.name === "charter")!;
    expect(charter.parameters.properties.action.enum.sort()).toEqual([
      "abandon",
      "complete",
      "create",
      "pause",
      "resume",
    ]);
  });

  test("charter_record schema exposes only evidence and verify", () => {
    const registered: Array<{ name: string; parameters: { properties: { action: { enum: string[] } } } }> = [];
    const pi: any = {
      events: { emit() {} },
      registerTool(desc: any) {
        registered.push(desc);
      },
      registerFlag() {},
      on() {},
    };
    registerCharterTools(pi);
    const record = registered.find((tool) => tool.name === "charter_record")!;
    expect(record.parameters.properties.action.enum.sort()).toEqual(["evidence", "verify"]);
  });
});
