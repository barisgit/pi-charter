import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharterConfig } from "../src/persistence/charter-config";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-config-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(projectDir: string, content: string): Promise<void> {
  const dir = join(projectDir, ".pi", "charter");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "charter-config.json"), content, "utf8");
}

describe("v2 charter config loader", () => {
  test("defaults-when-absent: missing file returns all defaults", async () => {
    await withTempProject(async (projectDir) => {
      expect(loadCharterConfig(projectDir)).toEqual({
        personas: {
          plannerCritic: "charter-planner-critic",
          reviewer: "charter-reviewer",
          qa: "charter-qa",
          readinessProbe: "charter-readiness-probe",
        },
        qaDir: "docs/qa",
        policy: "interactive",
        personasModel: {},
      });
    });
  });

  test("override-personas: reviewer override leaves other defaults", async () => {
    await withTempProject(async (projectDir) => {
      await writeConfig(projectDir, JSON.stringify({ personas: { reviewer: "my-team-reviewer" } }));

      expect(loadCharterConfig(projectDir).personas).toEqual({
        plannerCritic: "charter-planner-critic",
        reviewer: "my-team-reviewer",
        qa: "charter-qa",
        readinessProbe: "charter-readiness-probe",
      });
    });
  });

  test("malformed-json-errors: trailing comma mentions config path", async () => {
    await withTempProject(async (projectDir) => {
      await writeConfig(projectDir, `{ "policy": "interactive", }`);

      let caught: unknown;
      try {
        loadCharterConfig(projectDir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(join(projectDir, ".pi", "charter", "charter-config.json"));
      expect((caught as Error).message).toContain("Malformed charter config JSON");
    });
  });

  test("schema-violation-errors: invalid policy reports field path", async () => {
    await withTempProject(async (projectDir) => {
      await writeConfig(projectDir, JSON.stringify({ policy: "bogus" }));

      let caught: unknown;
      try {
        loadCharterConfig(projectDir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Invalid charter config");
      expect((caught as Error).message).toContain("/policy");
    });
  });

  test("autonomous-policy-loads: autonomous policy is returned", async () => {
    await withTempProject(async (projectDir) => {
      await writeConfig(projectDir, JSON.stringify({ policy: "autonomous" }));

      expect(loadCharterConfig(projectDir).policy).toBe("autonomous");
    });
  });
});
