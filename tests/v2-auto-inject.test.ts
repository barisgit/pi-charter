import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";
import { parseFeatureMarkdown, type FeatureDefinition } from "../src/domain/feature-md";
import { loadFeatureState } from "../src/persistence/feature-state";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-auto-inject-"));
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
    "Test auto-injection.",
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

interface FeatureSeed {
  id: string;
  milestone?: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  kind?: "impl" | "readiness" | "review" | "qa";
  review?: "required" | "skip";
  targets?: string[] | string;
  reviewSkipRationale?: string;
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
  if (input.review) lines.push(`review: ${input.review}`);
  if (input.reviewSkipRationale !== undefined) lines.push(`reviewSkipRationale: '${input.reviewSkipRationale}'`);
  if (input.targets !== undefined) {
    if (Array.isArray(input.targets)) {
      lines.push("targets:");
      for (const target of input.targets) lines.push(`  - ${target}`);
    } else {
      lines.push(`targets: ${input.targets}`);
    }
  }
  lines.push(fulfills.length === 0 ? "fulfills: []" : `fulfills: [${fulfills.join(", ")}]`);
  lines.push(preconditions.length === 0 ? "preconditions: []" : `preconditions: [${preconditions.join(", ")}]`);
  lines.push("---", "", input.body ?? `# ${input.id}\n\n${input.kind && input.kind !== "impl" ? "" : VALIDATION}`);
  return lines.join("\n");
}

async function seedPlanningCharter(projectDir: string, charterId: string, features: FeatureSeed[]): Promise<string> {
  await createCharter(projectDir, { objective: "auto inject", charterId, now: "2026-05-21T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  const criteria = [...new Set(features.flatMap((feature) => feature.fulfills ?? [`VAL-${feature.id.toUpperCase().replace(/[^A-Z0-9]/g, "-")}`]))];
  await writeFile(join(dir, "charter.md"), charterMarkdown(criteria), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const feature of features) {
    await writeFile(join(dir, "plan", `${feature.id}.md`), featureMarkdown(feature), "utf8");
  }
  return dir;
}

async function readPlanFeatures(dir: string): Promise<FeatureDefinition[]> {
  const planDir = join(dir, "plan");
  const entries = await readdir(planDir);
  const features: FeatureDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    features.push(parseFeatureMarkdown(await readFile(join(planDir, entry), "utf8")));
  }
  return features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
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

describe("v2 auto-inject", () => {
  test("injects-review: impl with default review yields a kind:review feature targeting it", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-injects-review";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "f-impl", fulfills: ["VAL-AUTO-001"] },
      ]);

      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const features = await readPlanFeatures(dir);
      const review = features.find((feature) => feature.id === "m1-review-f-impl");

      expect(review?.kind).toBe("review");
      expect(review?.targets).toEqual(["f-impl"]);
      expect(review?.preconditions).toEqual(["f-impl"]);
      expect(review?.body).toContain("Auto-injected review of f-impl; uses charter-reviewer persona.");
      const featureState = await loadFeatureState(dir, charterId);
      expect(featureState.features["m1-review-f-impl"]).toEqual({ checks: {} });
    });
  });

  test("injects-qa-per-milestone: milestone with 2 impls and no qa yields 1 kind:qa", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-injects-qa";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "f-one", fulfills: ["VAL-AUTO-001"], order: 1 },
        { id: "f-two", fulfills: ["VAL-AUTO-002"], order: 2 },
      ]);

      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const qas = (await readPlanFeatures(dir)).filter((feature) => feature.kind === "qa" && feature.milestone === "m1");

      expect(qas).toHaveLength(1);
      expect(qas[0].id).toBe("m1-qa");
      expect(qas[0].preconditions).toEqual(["f-one", "f-two"]);
      expect(qas[0].body).toContain("Auto-injected milestone QA; uses charter-qa persona.");
    });
  });

  test("preserves-planner-review: planner-authored kind:review for implX is kept; no duplicate generated", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-preserves-review";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "implx", fulfills: ["VAL-AUTO-001"], order: 1 },
        {
          id: "custom-review",
          kind: "review",
          targets: ["implx"],
          fulfills: [],
          order: 2,
          body: "Planner-authored review body stays exactly here.",
        },
      ]);

      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const features = await readPlanFeatures(dir);
      const reviews = features.filter((feature) => feature.kind === "review" && feature.targets.includes("implx"));

      expect(reviews.map((feature) => feature.id)).toEqual(["custom-review"]);
      expect(reviews[0].body).toBe("Planner-authored review body stays exactly here.");
    });
  });

  test("skip-rationale: impl with review:skip + rationale generates no review", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-skip-rationale";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        {
          id: "f-skip",
          fulfills: ["VAL-AUTO-001"],
          review: "skip",
          reviewSkipRationale: "trivial bug fix, no logic",
        },
      ]);

      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const reviews = (await readPlanFeatures(dir)).filter((feature) => feature.kind === "review");

      expect(reviews).toEqual([]);
    });
  });

  test("skip-without-rationale-fails: review:skip without rationale fails lock with the specified error", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-skip-no-rationale";
      await seedPlanningCharter(projectDir, charterId, [
        { id: "f-skip", fulfills: ["VAL-AUTO-001"], review: "skip" },
      ]);

      const err = await expectLockError(projectDir, charterId);

      expect(err.code).toBe("lock_plan.review_skip_missing_rationale");
      expect(err.message).toContain("f-skip");
    });
  });

  test("no-review-for-readiness: kind:readiness feature gets no review", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-readiness-no-review";
      const dir = await seedPlanningCharter(projectDir, charterId, [
        { id: "f-ready", kind: "readiness", fulfills: ["VAL-AUTO-001"], body: "Readiness only." },
      ]);

      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      const features = await readPlanFeatures(dir);

      expect(features.filter((feature) => feature.kind === "review")).toEqual([]);
      expect(features.filter((feature) => feature.kind === "qa")).toEqual([]);
    });
  });
});
