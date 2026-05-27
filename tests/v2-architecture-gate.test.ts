import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { createCharter, getCharterStatus } from "../src/application/service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-architecture-gate-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(count: number): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "Test architecture gate.",
    "",
    "## Criteria",
    "",
    ...Array.from({ length: count }, (_, index) => {
      const id = criterionId(index);
      return [`### ${id} — Criterion ${index + 1}`, "Verifier: manual", `Because: concrete rationale for ${id}`, ""];
    }).flat(),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

const VALIDATION_MD = [
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

function featureMarkdown(index: number): string {
  const id = `f${index + 1}`;
  return [
    "---",
    `id: ${id}`,
    "milestone: m1",
    `order: ${index + 1}`,
    `fulfills: [${criterionId(index)}]`,
    "preconditions: []",
    "---",
    "",
    `# ${id}`,
    "",
    VALIDATION_MD,
  ].join("\n");
}

function criterionId(index: number): string {
  return `VAL-ARCH-${String(index + 1).padStart(3, "0")}`;
}

async function seedPlanningCharter(projectDir: string, charterId: string, featureCount: number): Promise<string> {
  await createCharter(projectDir, { objective: "architecture gate", charterId, now: "2026-05-21T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(featureCount), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (let index = 0; index < featureCount; index += 1) {
    await writeFile(join(dir, "plan", `f${index + 1}.md`), featureMarkdown(index), "utf8");
  }
  if (featureCount > 8) {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    state.planning = { ...(state.planning ?? {}), valCeilingOverride: true };
    await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  return dir;
}

async function writeArchitecture(dir: string, content: string): Promise<string> {
  const libraryDir = join(dir, "library");
  await mkdir(libraryDir, { recursive: true });
  const path = join(libraryDir, "architecture.md");
  await writeFile(path, content, "utf8");
  return path;
}

async function expectLockError(projectDir: string, charterId: string): Promise<CharterToolError> {
  try {
    await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
  } catch (err) {
    expect(err).toBeInstanceOf(CharterToolError);
    return err as CharterToolError;
  }
  throw new Error("Expected lockPlan to fail");
}

describe("v2 architecture gate", () => {
  test("locks-with-architecture-md-for-large-charter", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-large-present";
      const dir = await seedPlanningCharter(projectDir, charterId, 10);
      await writeArchitecture(dir, `# Architecture\n\n${"A".repeat(220)}`);

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.architecturePresent).toBe(true);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });

      expect(result.status).toBe("active");
    });
  });

  test("fails-without-architecture-md-for-large-charter", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-large-missing";
      const dir = await seedPlanningCharter(projectDir, charterId, 10);
      const expectedPath = join(dir, "library", "architecture.md");

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.architecturePresent).toBe(false);
      const err = await expectLockError(projectDir, charterId);

      expect(err.code).toBe("lock_plan.missing_architecture");
      expect(err.message).toContain(expectedPath);
    });
  });

  test("fails-with-tiny-architecture-md", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-large-tiny";
      const dir = await seedPlanningCharter(projectDir, charterId, 10);
      const expectedPath = await writeArchitecture(dir, "x".repeat(50));

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.architecturePresent).toBe(false);
      const err = await expectLockError(projectDir, charterId);

      expect(err.code).toBe("lock_plan.missing_architecture");
      expect(err.message).toContain(expectedPath);
    });
  });

  test("locks-without-architecture-for-small-charter", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-arch-small-missing";
      await seedPlanningCharter(projectDir, charterId, 2);

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.architecturePresent).toBe(false);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });

      expect(result.status).toBe("active");
    });
  });
});
