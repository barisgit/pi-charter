import { describe, expect, test } from "bun:test";
import { CharterToolError } from "../src/application/errors";

describe("CharterToolError", () => {
  test("carries message, nextActions, optional code, and Error identity", () => {
    const nextActions = [{ tool: "charter_status" as const, hint: "h" }];
    const error = new CharterToolError("msg", { nextActions });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CharterToolError);
    expect(error.message).toBe("msg");
    expect(error.nextActions).toHaveLength(1);
    expect(error.nextActions[0]).toEqual({ tool: "charter_status", hint: "h" });
    expect(error.code).toBeUndefined();
    expect(error.name).toBe("CharterToolError");
  });

  test("exposes code when provided", () => {
    const error = new CharterToolError("msg", {
      nextActions: [{ tool: "charter_status", hint: "h" }],
      code: "X",
    });

    expect(error.code).toBe("X");
  });
});
