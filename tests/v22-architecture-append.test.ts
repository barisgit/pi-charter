import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { overwriteAtAmend, appendDiscovered, writeAtPlanning } from "../src/application/architecture-writer";
import { lockPlan } from "../src/application/plan-service";
import { amendCharter, createCharter } from "../src/application/service";
import { architectureMarkdownPath } from "../src/application/architecture-gate";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-architecture-append-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const CHARTER_MD = [
  "# Charter",
  "",
  "## Objective",
  "Test architecture append lifecycle.",
  "",
  "## Criteria",
  "",
  "### VAL-ARCH-APPEND Architecture append works",
  "Verifier: manual",
  "Because: deterministic service-level test is sufficient",
  "",
  "## Scope and constraints",
  "",
  "- Keep architecture body frozen while active.",
  "",
].join("\n");

const FEATURE_MD = [
  "---",
  "id: f-arch-append",
  "milestone: m1",
  "order: 1",
  "fulfills: [VAL-ARCH-APPEND]",
  "preconditions: []",
  "---",
  "",
  "# Architecture append feature",
  "",
  "## Validation",
  "",
  "### Happy",
  "- check: smoke-happy",
  "  command: true",
  "",
  "### Edge",
  "- check: smoke-edge",
  "  command: true",
  "",
].join("\n");

async function makePlanningCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Test architecture append lifecycle",
    charterId,
    now: "2026-05-21T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), CHARTER_MD, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f-arch-append.md"), FEATURE_MD, "utf8");
  return dir;
}

async function makeActiveCharter(projectDir: string, charterId: string, architectureBody: string): Promise<string> {
  const dir = await makePlanningCharter(projectDir, charterId);
  await writeAtPlanning(projectDir, charterId, architectureBody);
  await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
  return dir;
}

async function readArchitecture(projectDir: string, charterId: string): Promise<string> {
  return readFile(architectureMarkdownPath(projectDir, charterId), "utf8");
}

async function expectCharterToolError(promise: Promise<unknown>): Promise<CharterToolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CharterToolError);
    return error as CharterToolError;
  }
  throw new Error("Expected CharterToolError");
}

function countDiscoveredHeadings(markdown: string): number {
  return markdown.match(/^## Discovered$/gm)?.length ?? 0;
}

describe("v2.2 architecture append during active", () => {
  test("architecture append-during-active", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-append-active";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nStable body.\n");

      await appendDiscovered(projectDir, charterId, "- Found while active.");

      expect(await readArchitecture(projectDir, charterId)).toBe("# Architecture\n\nStable body.\n\n## Discovered\n\n- Found while active.\n");
    });
  });

  test("body frozen during active", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-body-frozen";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nOriginal body.\n");

      const error = await expectCharterToolError(writeAtPlanning(projectDir, charterId, "# Architecture\n\nRewritten body.\n"));

      expect(error.message).toContain("planning");
      expect(await readArchitecture(projectDir, charterId)).toBe("# Architecture\n\nOriginal body.\n");
    });
  });

  test("amend permits full overwrite", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-amend-overwrite";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nOriginal body.\n");
      await appendDiscovered(projectDir, charterId, "- Active note.");
      await amendCharter(projectDir, {
        charterId,
        reason: "architecture needs replanning",
        target: "planning",
        now: "2026-05-21T00:02:00.000Z",
      });

      await overwriteAtAmend(projectDir, charterId, "# Architecture\n\nReplacement body.\n");

      expect(await readArchitecture(projectDir, charterId)).toBe("# Architecture\n\nReplacement body.\n");
    });
  });

  test("append creates Discovered section if missing", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-create-discovered";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nBody without discovered section.\n");

      await appendDiscovered(projectDir, charterId, "- New discovery.");
      const markdown = await readArchitecture(projectDir, charterId);

      expect(countDiscoveredHeadings(markdown)).toBe(1);
      expect(markdown).toBe("# Architecture\n\nBody without discovered section.\n\n## Discovered\n\n- New discovery.\n");
    });
  });

  test("wrong-level Discovered heading rejected with clear error", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-wrong-level";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nBody.\n\n### Discovered\n\n- Wrong level.\n");

      const error = await expectCharterToolError(appendDiscovered(projectDir, charterId, "- Should not append."));

      expect(error.message).toContain("## Discovered");
      expect(error.message).toContain("### Discovered");
      expect(await readArchitecture(projectDir, charterId)).toBe("# Architecture\n\nBody.\n\n### Discovered\n\n- Wrong level.\n");
    });
  });

  test("multiple appends concatenate within section", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-multiple-appends";
      await makeActiveCharter(projectDir, charterId, "# Architecture\n\nBody.\n\n## Discovered\n\n- First.\n");

      await appendDiscovered(projectDir, charterId, "- Second.");
      await appendDiscovered(projectDir, charterId, "- Third.");
      const markdown = await readArchitecture(projectDir, charterId);

      expect(countDiscoveredHeadings(markdown)).toBe(1);
      expect(markdown).toBe("# Architecture\n\nBody.\n\n## Discovered\n\n- First.\n\n- Second.\n\n- Third.\n");
    });
  });
});
