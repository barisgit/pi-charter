import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharterConfig, resolvePersona, type CharterConfig } from "../src/persistence/charter-config";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-personas-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAllFiles(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await readAllFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ path, text: await readFile(path, "utf8") });
  }
  return out;
}

describe("v2 personas", () => {
  test("resolves-default-when-no-override", async () => {
    await withTempProject(async (projectDir) => {
      const config = loadCharterConfig(projectDir);

      expect(resolvePersona("plannerCritic", config)).toBe("charter-planner-critic");
      expect(resolvePersona("reviewer", config)).toBe("charter-reviewer");
      expect(resolvePersona("qa", config)).toBe("charter-qa");
      expect(resolvePersona("readinessProbe", config)).toBe("charter-readiness-probe");
    });
  });

  test("resolves-override-from-config", () => {
    const config: CharterConfig = {
      personas: {
        plannerCritic: "team-planner",
        reviewer: "team-reviewer",
        qa: "team-qa",
        readinessProbe: "team-readiness",
      },
      qaDir: "docs/qa",
      policy: "interactive",
      personasModel: {},
    };

    expect(resolvePersona("plannerCritic", config)).toBe("team-planner");
    expect(resolvePersona("reviewer", config)).toBe("team-reviewer");
    expect(resolvePersona("qa", config)).toBe("team-qa");
    expect(resolvePersona("readinessProbe", config)).toBe("team-readiness");
  });

  test("bundled-agent-files-exist", () => {
    for (const file of [
      "charter-planner-critic.md",
      "charter-reviewer.md",
      "charter-qa.md",
      "charter-readiness-probe.md",
    ]) {
      expect(existsSync(join(process.cwd(), "agents", file))).toBe(true);
    }
  });

  test("deprecated-verifier-not-referenced", async () => {
    const files = await readAllFiles(join(process.cwd(), "src"));
    const offenders = files
      .filter((file) => file.text.includes("charter-verifier"))
      .map((file) => file.path.replace(`${process.cwd()}/`, ""));

    expect(offenders).toEqual([]);
  });
});
