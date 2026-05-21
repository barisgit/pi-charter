import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { addFeature, lockPlan } from "../src/application/plan-service";
import { parseCharterMarkdown } from "../src/domain/charter-md";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v2-qa-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "",
    "Ship QA scaffolding.",
    "",
    "## Criteria",
    "",
    "### VAL-QA-001 — QA scaffolding works",
    "Verifier: manual",
    "Because: this test exercises the scaffold contract.",
    "",
    "## Scope and constraints",
    "",
    "- Stay charter-scoped.",
    "",
  ].join("\n");
}

async function seedPlanningCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Ship QA scaffolding",
    charterId,
    now: "2026-05-21T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(), "utf8");
  await addFeature(projectDir, {
    charterId,
    id: "f1-qa-scaffold",
    milestone: "m1",
    order: 1,
    fulfills: ["VAL-QA-001"],
    body: "Charter-scoped QA scaffold.",
    now: "2026-05-21T00:01:00.000Z",
  });
  return dir;
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path), await Bun.file(path).text());
      }
    }
  }

  await walk(root);
  return files;
}

describe("v2 QA scaffolding", () => {
  test("parses qa readiness sections", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "Ship QA.",
      "",
      "## QA",
      "- auth: exercise login.",
      "",
      "Details stay as markdown.",
      "",
      "## Readiness",
      "- database seeded.",
      "- test user available.",
      "",
      "## Criteria",
      "",
      "### VAL-QA-001 — Done",
      "Verifier: manual",
      "Because: author note.",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.qaSection).toBe("- auth: exercise login.\n\nDetails stay as markdown.\n");
    expect(parsed.readinessSection).toBe("- database seeded.\n- test user available.\n");
  });

  test("qa dir scaffolded", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-qa-scaffold";
      await createCharter(projectDir, {
        objective: "Ship QA scaffold",
        charterId,
        now: "2026-05-21T00:00:00.000Z",
      });

      const entries = await readdir(join(projectDir, ".pi", "charters", charterId, "qa"));
      expect(entries).toEqual([]);
      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.qaBriefs).toEqual([]);
    });
  });

  test("status lists briefs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-qa-briefs";
      const dir = await seedPlanningCharter(projectDir, charterId);
      await writeFile(join(dir, "qa", "dashboard.md"), "# Dashboard QA\n", "utf8");
      await writeFile(join(dir, "qa", "auth.md"), "# Auth QA\n", "utf8");
      await writeFile(join(dir, "qa", "notes.txt"), "ignored\n", "utf8");

      const status = await getCharterStatus(projectDir, { charterId });

      expect(status.qaBriefs).toEqual(["auth", "dashboard"]);
    });
  });

  test("no repo writes during planning", async () => {
    await withTempProject(async (projectDir) => {
      await mkdir(join(projectDir, "docs", "qa"), { recursive: true });
      await writeFile(join(projectDir, "README.md"), "baseline\n", "utf8");
      await writeFile(join(projectDir, "docs", "qa", "existing.md"), "do not touch\n", "utf8");
      const before = await snapshotFiles(projectDir);

      const charterId = "cha-no-repo-writes";
      await seedPlanningCharter(projectDir, charterId);
      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:02:00.000Z" });

      const after = await snapshotFiles(projectDir);
      const changedOutsideCharters = [...after].filter(([path, contents]) => {
        if (path.startsWith(join(".pi", "charters"))) return false;
        return before.get(path) !== contents;
      });
      const removedOutsideCharters = [...before.keys()].filter((path) => {
        if (path.startsWith(join(".pi", "charters"))) return false;
        return !after.has(path);
      });

      expect(changedOutsideCharters).toEqual([]);
      expect(removedOutsideCharters).toEqual([]);
    });
  });

  test("missing qa section tolerated", () => {
    const parsed = parseCharterMarkdown(charterMarkdown());

    expect(parsed.qaSection).toBeUndefined();
    expect(parsed.readinessSection).toBeUndefined();
    expect(parsed.criteria).toHaveLength(1);
  });
});
