import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCharterToSession } from "../src/application/binding-service";
import { addFeatureBatch, viewPlan } from "../src/application/plan-service";
import { registerCharterTools } from "../src/application/registration";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

/**
 * VAL-4: `charter_plan action=add_feature` accepts a `features: [...]` array
 * of arbitrary length. When a malformed entry sits at slot 2 of a 3-entry
 * call, zero plan/*.md files are written, plan.json is unchanged, and the
 * error names the offending index and reason.
 *
 * Legacy inline scalar shapes are covered by tests/legacy-purge.test.ts and
 * are intentionally rejected at the registration schema boundary.
 */

interface FakeTool {
  execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: () => unknown, ctx: unknown) => Promise<{ details: any }>;
}

function makeHarness(homeDir: string): { tools: Map<string, FakeTool> } {
  const tools = new Map<string, FakeTool>();
  const pi: any = {
    events: { emit() {} },
    registerTool(tool: FakeTool & { name: string }) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return ""; },
    on() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  registerCharterTools(pi, { homeDir });
  return { tools };
}

function ctx(projectDir: string, sessionId?: string) {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
}

async function callTool(tool: FakeTool, params: Record<string, unknown>, projectDir: string, sessionId?: string) {
  return tool.execute("c", params, new AbortController().signal, () => undefined, ctx(projectDir, sessionId));
}

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-batch-add-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-batch-add-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function seedPlanningCharter(projectDir: string, charterId: string): Promise<void> {
  await createCharter(projectDir, {
    objective: "Batch add_feature probe",
    charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "Batch add_feature probe",
      "## Criteria",
      "### VAL-B-001 first",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "### VAL-B-002 second",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "### VAL-B-003 third",
      "Description: covered.",
      "Verifier: manual",
      "Because: manual probe",
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function listPlanFiles(projectDir: string, charterId: string): Promise<string[]> {
  const planDir = join(charterDir(projectDir, charterId), "plan");
  try {
    return (await readdir(planDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

describe("VAL-4 batch add_feature atomicity", () => {
  test("happy path: 3 entries land, all 3 files exist, viewPlan lists all 3", async () => {
    await withTempProject(async ({ projectDir }) => {
      const charterId = "cha-batch-happy";
      await seedPlanningCharter(projectDir, charterId);

      const result = await addFeatureBatch(projectDir, {
        charterId,
        now: "2026-05-15T00:10:00.000Z",
        features: [
          { id: "f1-alpha", milestone: "m1", order: 1, fulfills: ["VAL-B-001"], body: "alpha body" },
          { id: "f2-beta", milestone: "m1", order: 2, fulfills: ["VAL-B-002"], body: "beta body" },
          { id: "f3-gamma", milestone: "m1", order: 3, fulfills: ["VAL-B-003"], body: "gamma body" },
        ],
      });

      expect(result.features.length).toBe(3);
      expect(result.features.map((f) => f.featureId)).toEqual(["f1-alpha", "f2-beta", "f3-gamma"]);
      expect(Array.isArray(result.nextActions)).toBe(true);
      expect(result.nextActions.length).toBeGreaterThan(0);

      const files = await listPlanFiles(projectDir, charterId);
      expect(files).toEqual(["f1-alpha.md", "f2-beta.md", "f3-gamma.md"]);

      const plan = await viewPlan(projectDir, { charterId });
      expect(plan.features.map((f) => f.id).sort()).toEqual(["f1-alpha", "f2-beta", "f3-gamma"]);
    });
  });

  test("all-or-nothing: invalid entry at slot 1 throws naming the index; no plan files; no feature_added events", async () => {
    await withTempProject(async ({ projectDir }) => {
      const charterId = "cha-batch-rollback";
      await seedPlanningCharter(projectDir, charterId);

      await expect(addFeatureBatch(projectDir, {
        charterId,
        features: [
          { id: "f1-ok", milestone: "m1", order: 1, fulfills: ["VAL-B-001"], body: "ok" },
          // Whitespace violates FEATURE_ID_RE (FEATURE_ID_RE is case-insensitive,
          // so uppercase alone wouldn't fail) -> validation failure at index 1.
          { id: "bad id", milestone: "m1", order: 2, fulfills: ["VAL-B-002"], body: "bad" },
          { id: "f3-ok", milestone: "m1", order: 3, fulfills: ["VAL-B-003"], body: "ok" },
        ],
      })).rejects.toThrow(/index 1/);

      // Zero plan/*.md files written (only the seeded plan/ dir exists, empty).
      expect(await listPlanFiles(projectDir, charterId)).toEqual([]);

      // No feature_added events for the batch landed in events.jsonl.
      const eventsPath = join(charterDir(projectDir, charterId), "events.jsonl");
      const events = await readFile(eventsPath, "utf8").catch(() => "");
      expect(events).not.toMatch(/"type":"feature_added"/);
    });
  });
});
