import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { isSubagentRecordedBy } from "../src/application/service";

const BUNDLED_PERSONA_SYMBOLS = [
  "charter-reviewer",
  "charter-qa",
  "charter-planner-critic",
  "charter-readiness-probe",
  "charter-verifier",
  "registerCharterPersonas",
];

describe("bundled personas removed", () => {
  test("bundled agents/ persona directory is absent", async () => {
    await expect(access(join(import.meta.dir, "..", "agents"))).rejects.toThrow();
  });

  test("runtime src/*.ts has no hardcoded bundled persona names", () => {
    for (const symbol of BUNDLED_PERSONA_SYMBOLS) {
      const result = Bun.spawnSync({
        cmd: ["grep", "-RIn", "--include=*.ts", symbol, "src"],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${symbol}: ${result.stdout.toString()}`).toBe(1);
    }
  });

  test("SKILL.md does not instruct invoking bundled charter personas", async () => {
    const skill = await Bun.file(join(import.meta.dir, "..", "skills", "pi-charter", "SKILL.md")).text();
    for (const symbol of BUNDLED_PERSONA_SYMBOLS.slice(0, 5)) {
      expect(skill).not.toContain(symbol);
    }
    expect(skill).toMatch(/user-owned subagents|your own review subagents/i);
  });

  test("isSubagentRecordedBy accepts any subagent agent name", () => {
    expect(isSubagentRecordedBy("subagent:my-team-reviewer:session-1")).toBe(true);
    expect(isSubagentRecordedBy("subagent:fixer:session-2")).toBe(true);
    expect(isSubagentRecordedBy("agent:root")).toBe(false);
    expect(isSubagentRecordedBy("subagent:only-one-colon")).toBe(false);
  });

});
