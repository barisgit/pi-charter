import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharterConfig } from "../src/persistence/charter-config";

async function withTempAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-config-test-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeGlobalConfig(agentDir: string, content: string): Promise<void> {
  await writeFile(join(agentDir, "charter-config.json"), content, "utf8");
}

describe("charter config loader", () => {
  test("defaults-when-absent: missing file returns all defaults", async () => {
    await withTempAgentDir(async () => {
      expect(loadCharterConfig()).toEqual({
        personas: {
          plannerCritic: "",
          reviewer: "",
          qa: "",
          readinessProbe: "",
        },
        qaDir: "docs/qa",
        policy: "interactive",
      });
    });
  });

  test("override-personas: reviewer override leaves other defaults", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeGlobalConfig(agentDir, JSON.stringify({ personas: { reviewer: "my-team-reviewer" } }));

      expect(loadCharterConfig().personas).toEqual({
        plannerCritic: "",
        reviewer: "my-team-reviewer",
        qa: "",
        readinessProbe: "",
      });
    });
  });

  test("malformed-json-errors: trailing comma mentions config path", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeGlobalConfig(agentDir, `{ "policy": "interactive", }`);

      let caught: unknown;
      try {
        loadCharterConfig();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(join(agentDir, "charter-config.json"));
      expect((caught as Error).message).toContain("Malformed charter config JSON");
    });
  });

  test("schema-violation-errors: invalid policy reports field path", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeGlobalConfig(agentDir, JSON.stringify({ policy: "bogus" }));

      let caught: unknown;
      try {
        loadCharterConfig();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Invalid charter config");
      expect((caught as Error).message).toContain("/policy");
    });
  });

  test("autonomous-policy-loads: autonomous policy is returned", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeGlobalConfig(agentDir, JSON.stringify({ policy: "autonomous" }));

      expect(loadCharterConfig().policy).toBe("autonomous");
    });
  });
});
