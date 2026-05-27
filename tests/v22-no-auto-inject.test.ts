import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { clearHookSubscribers } from "../src/application/hooks";
import { loadFeatureState, writeFeatureCheckState, writeFeatureState } from "../src/persistence/feature-state";

beforeEach(() => clearHookSubscribers());

const VALIDATION = [
  "## Validation",
  "",
  "### Happy",
  "- check: happy",
  "  command: true",
  "",
  "### Edge",
  "- check: edge",
  "  command: true",
  "",
].join("\n");

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v22-no-auto-inject-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(criteria: string[]): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "No auto inject.",
    "",
    "## Criteria",
    "",
    ...criteria.flatMap((id) => [
      `### ${id} — ${id}`,
      "Verifier: manual",
      `Because: concrete rationale for ${id}`,
      "",
    ]),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

interface FeatureSeed {
  id: string;
  milestone?: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  kind?: "impl" | "readiness" | "review" | "qa";
  category?: "behavior" | "infrastructure";
  body?: string;
}

function featureMarkdown(input: FeatureSeed): string {
  const milestone = input.milestone ?? "m1";
  const order = input.order ?? 1;
  const fulfills = input.fulfills ?? [`VAL-${input.id.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`];
  const preconditions = input.preconditions ?? [];
  const lines = [
    "---",
    `id: ${input.id}`,
    `milestone: ${milestone}`,
    `order: ${order}`,
  ];
  if (input.kind) lines.push(`kind: ${input.kind}`);
  if (input.category) lines.push(`category: ${input.category}`);
  lines.push(fulfills.length === 0 ? "fulfills: []" : `fulfills: [${fulfills.join(", ")}]`);
  lines.push(preconditions.length === 0 ? "preconditions: []" : `preconditions: [${preconditions.join(", ")}]`);
  lines.push("---", "", input.body ?? `# ${input.id}\n\n${input.kind && input.kind !== "impl" ? "Planner-authored non-impl gate." : VALIDATION}`);
  return lines.join("\n");
}

async function seedPlanningCharter(projectDir: string, charterId: string, features: FeatureSeed[]): Promise<string> {
  await createCharter(projectDir, { objective: "no auto inject", charterId, now: "2026-05-21T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  const criteria = [...new Set(features.flatMap((feature) => feature.fulfills ?? [`VAL-${feature.id.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`]))]
    .filter((id) => id.length > 0);
  await writeFile(join(dir, "charter.md"), charterMarkdown(criteria), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const feature of features) {
    await writeFile(join(dir, "plan", `${feature.id}.md`), featureMarkdown(feature), "utf8");
  }
  return dir;
}

async function readPlanIds(dir: string): Promise<string[]> {
  return (await readdir(join(dir, "plan")))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -3))
    .sort();
}

async function readEvents(dir: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("v2.2 no auto-inject", () => {
  test("lock_plan does not fabricate review or qa features", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v22-no-fabricate";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "f-one", fulfills: ["VAL-NO-AUTO-001"], order: 1 },
        { id: "f-two", fulfills: ["VAL-NO-AUTO-002"], order: 2 },
        { id: "f-three", fulfills: ["VAL-NO-AUTO-003"], order: 3 },
      ]);
      await mkdir(join(dir, "library"), { recursive: true });
      await writeFile(join(dir, "library", "architecture.md"), `${"Architecture note. ".repeat(20)}\n`, "utf8");

      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const ids = await readPlanIds(dir);

      expect(result.featureCount).toBe(3);
      expect(ids).toEqual(["f-one", "f-three", "f-two"]);
      expect(ids.some((id) => id.includes("review") || id.endsWith("-qa"))).toBe(false);
    });
  });

  test("feature-state row schema no longer carries auto-injected", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v22-feature-state-clean";
      const dir = join(projectDir, ".pi", "charters", charterId);
      await mkdir(dir, { recursive: true });

      await writeFeatureCheckState(dir, charterId, "f-one", "happy", {
        status: "passing",
        lastEvidenceTs: "2026-05-21T00:02:00.000Z",
      });

      const raw = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as { features: Record<string, Record<string, unknown>> };
      expect(raw.features["f-one"]["auto-injected"]).toBeUndefined();
      expect(raw.features["f-one"].autoInjected).toBeUndefined();
    });
  });

  test("record-service milestone-readiness treats all features uniformly", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v22-milestone-uniform";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "f-one", fulfills: ["VAL-UNIFORM-001"], order: 1 },
        { id: "f-one-review", kind: "review", category: "infrastructure", fulfills: [], preconditions: ["f-one"], order: 2 },
      ]);
      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-UNIFORM-001",
        featureId: "f-one",
        outcome: "pass",
        summary: "implementation complete",
        because: "manual sign-off for the implementation feature",
        now: "2026-05-21T00:02:00.000Z",
      });

      let ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(0);

      const featureState = await loadFeatureState(dir, charterId);
      featureState.features["f-one-review"] = {
        ...(featureState.features["f-one-review"] ?? { checks: {} }),
        status: "completed",
        startedAt: "2026-05-21T00:02:30.000Z",
        completedAt: "2026-05-21T00:02:45.000Z",
        checks: featureState.features["f-one-review"]?.checks ?? {},
      };
      await writeFeatureState(dir, featureState);

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-UNIFORM-001",
        featureId: "f-one",
        outcome: "pass",
        summary: "implementation still complete after review gate",
        because: "manual re-affirmation after the planner-authored review gate completed",
        now: "2026-05-21T00:03:00.000Z",
      });

      ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(1);
      expect(ready[0].criterionIds).toEqual(["VAL-UNIFORM-001"]);
    });
  });

  test("legacy auto-injected:true flag tolerated by reader", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-v22-legacy-auto-injected";
      const dir = join(projectDir, ".pi", "charters", charterId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "feature-state.json"),
        `${JSON.stringify({
          charterId,
          features: {
            "legacy-review": {
              status: "completed",
              "auto-injected": true,
              checks: { happy: { status: "passing" } },
            },
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const state = await loadFeatureState(dir, charterId);

      expect(state.features["legacy-review"].status).toBe("completed");
      expect(state.features["legacy-review"].checks.happy.status).toBe("passing");
      expect("auto-injected" in state.features["legacy-review"]).toBe(false);
    });
  });
});
