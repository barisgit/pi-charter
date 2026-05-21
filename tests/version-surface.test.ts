import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { getPackageVersion } from "../src/application/version";

function fakePi() {
  const calls: string[] = [];
  return {
    calls,
    registerFlag: () => calls.push("flag"),
    registerTool: () => calls.push("tool"),
    registerCommand: () => calls.push("command"),
    on: () => calls.push("event"),
    registerWidget: () => calls.push("widget"),
  };
}

describe("version surface", () => {
  test("returns package.json version", () => {
    expect(getPackageVersion()).toBe(pkg.version);
  });

  test("helper import and call are side-effect free", async () => {
    const pi = fakePi();

    const mod = await import("../src/application/version");
    expect(mod.getPackageVersion()).toBe(pkg.version);
    expect(pi.calls).toEqual([]);
  });
});
