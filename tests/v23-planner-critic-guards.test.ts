/**
 * Stage D: planner-critic guards enforced by lock_plan.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan, viewPlan } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-stage-d-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
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

interface CriterionSpec {
  id: string;
  description?: string;
  verifier?: "manual" | "command";
  command?: string;
}

interface FeatureSpec {
  id: string;
  order: number;
  fulfills: string[];
  category?: "behavior" | "infrastructure";
  kind?: "impl" | "readiness" | "review" | "qa";
}

function criterionMarkdown(spec: CriterionSpec): string[] {
  const verifier = spec.verifier ?? "manual";
  return [
    `### ${spec.id} — ${spec.id}`,
    `Description: ${spec.description ?? `${spec.id} is observable.`}`,
    `Verifier: ${verifier}`,
    ...(verifier === "command" ? [`Command: ${spec.command ?? "true"}`] : [`Because: deterministic stage D probe for ${spec.id}`]),
    "",
  ];
}

function charterMarkdown(criteria: CriterionSpec[]): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "Stage D planner critic guard.",
    "",
    "## Criteria",
    "",
    ...criteria.flatMap(criterionMarkdown),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

function featureMarkdown(spec: FeatureSpec): string {
  const lines = ["---", `id: ${spec.id}`, "milestone: m1", `order: ${spec.order}`];
  if (spec.category) lines.push(`category: ${spec.category}`);
  if (spec.kind) lines.push(`kind: ${spec.kind}`);
  if (spec.fulfills.length === 0) lines.push("fulfills: []");
  else {
    lines.push("fulfills:");
    for (const id of spec.fulfills) lines.push(`  - ${id}`);
  }
  lines.push("preconditions: []", "---", "", `# ${spec.id}`, "", VALIDATION_MD);
  return lines.join("\n");
}

async function seed(
  projectDir: string,
  charterId: string,
  criteria: CriterionSpec[],
  features: FeatureSpec[],
): Promise<void> {
  await createCharter(projectDir, {
    objective: "Stage D planner critic guard",
    charterId,
    now: "2026-05-23T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(criteria), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const feature of features) {
    await writeFile(join(dir, "plan", `${feature.id}.md`), featureMarkdown(feature), "utf8");
  }
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"A".repeat(240)}\n`, "utf8");
}

async function setValCeilingOverride(projectDir: string, charterId: string): Promise<void> {
  const dir = charterDir(projectDir, charterId);
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  state.planning = { ...(state.planning ?? {}), valCeilingOverride: true };
  await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function expectLockError(projectDir: string, charterId: string): Promise<CharterToolError> {
  try {
    await lockPlan(projectDir, { charterId, now: "2026-05-23T00:01:00.000Z" });
  } catch (err) {
    expect(err).toBeInstanceOf(CharterToolError);
    return err as CharterToolError;
  }
  throw new Error("Expected lockPlan to fail");
}

function valSpecs(count: number): CriterionSpec[] {
  return Array.from({ length: count }, (_, index) => ({ id: `VAL-D-${String(index + 1).padStart(3, "0")}` }));
}

describe("Stage D: planner-critic lock_plan guards", () => {
  test("hard-fails VAL tautology when description references a feature id", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-d-tautology";
      await seed(projectDir, charterId, [
        { id: "VAL-D-TAUTOLOGY", description: "feature m1-bootstrap implemented" },
      ], [
        { id: "m1-bootstrap", order: 1, fulfills: ["VAL-D-TAUTOLOGY"] },
      ]);

      const err = await expectLockError(projectDir, charterId);
      expect(err.message).toContain("VAL-D-TAUTOLOGY description references feature ids");
      expect(err.message).toContain("describe observable behavior, not implementation features");
    });
  });

  test("does not flag plain-English feature flag text as VAL tautology", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-d-feature-flag-ok";
      await seed(projectDir, charterId, [
        { id: "VAL-D-FLAG", description: "returns 200 when feature flag enabled" },
      ], [
        { id: "m1-feature-flag", order: 1, fulfills: ["VAL-D-FLAG"] },
      ]);

      const result = await lockPlan(projectDir, { charterId, now: "2026-05-23T00:01:00.000Z" });
      expect(result.status).toBe("active");
    });
  });

  test("hard-fails self-referential bespoke verifier scripts but allows project-wide test commands", async () => {
    await withTempProject(async (projectDir) => {
      const failingId = "ch-stage-d-bespoke-verifier";
      await seed(projectDir, failingId, [
        { id: "VAL-D-VERIFY", verifier: "command", command: "scripts/verify/VAL-FOO.sh" },
      ], [
        { id: "m1-verifier", order: 1, fulfills: ["VAL-D-VERIFY"] },
      ]);

      const err = await expectLockError(projectDir, failingId);
      expect(err.message).toContain("VAL-D-VERIFY has bespoke verifier script scripts/verify/VAL-FOO.sh");
      expect(err.message).toContain("use project-wide bun test / bun run check-types instead");

      const passingId = "ch-stage-d-project-wide-verifier";
      await seed(projectDir, passingId, [
        { id: "VAL-D-VERIFY", verifier: "command", command: "bun test tests/foo.test.ts" },
      ], [
        { id: "m1-verifier", order: 1, fulfills: ["VAL-D-VERIFY"] },
      ]);

      const result = await lockPlan(projectDir, { charterId: passingId, now: "2026-05-23T00:01:00.000Z" });
      expect(result.status).toBe("active");
    });
  });

  test("hard-fails VAL ceiling over 8 unless state has planning override", async () => {
    await withTempProject(async (projectDir) => {
      const criteria = valSpecs(9);
      const features = criteria.map((criterion, index) => ({
        id: `m1-feature-${index + 1}`,
        order: index + 1,
        fulfills: [criterion.id],
      }));

      const failingId = "ch-stage-d-val-ceiling";
      await seed(projectDir, failingId, criteria, features);
      const err = await expectLockError(projectDir, failingId);
      expect(err.message).toContain("Plan declares 9 VALs (limit 8)");
      expect(err.message).toContain("Use charter_manage amend_charter to raise the ceiling with a written rationale");

      const passingId = "ch-stage-d-val-ceiling-override";
      await seed(projectDir, passingId, criteria, features);
      await setValCeilingOverride(projectDir, passingId);
      const result = await lockPlan(projectDir, { charterId: passingId, now: "2026-05-23T00:01:00.000Z" });
      expect(result.status).toBe("active");
    });
  });

  test("soft-warns on suspect 1:1 VAL to behavior-feature ratio without blocking", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-d-ratio-warn";
      await seed(projectDir, charterId, valSpecs(3), [
        { id: "m1-a", order: 1, fulfills: ["VAL-D-001"] },
        { id: "m1-b", order: 2, fulfills: ["VAL-D-002"] },
        { id: "m1-c", order: 3, fulfills: ["VAL-D-003"] },
      ]);

      const plan = await viewPlan(projectDir, { charterId });
      expect(plan.warnings).toContain("Suspect 1:1 VAL↔feature ratio. Either VALs are too granular (combine them) or features were invented to match VALs. Aim for M:N where a feature can fulfill multiple VALs.");
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-23T00:01:00.000Z" });
      expect(result.status).toBe("active");
      expect(result.warnings).toContain("Suspect 1:1 VAL↔feature ratio. Either VALs are too granular (combine them) or features were invented to match VALs. Aim for M:N where a feature can fulfill multiple VALs.");
    });
  });

  test("does not warn on M:N target shape", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-d-mn-ok";
      await seed(projectDir, charterId, valSpecs(4), [
        { id: "m1-a", order: 1, fulfills: ["VAL-D-001", "VAL-D-002"] },
        { id: "m1-b", order: 2, fulfills: ["VAL-D-003", "VAL-D-004"] },
      ]);

      const result = await lockPlan(projectDir, { charterId, now: "2026-05-23T00:01:00.000Z" });
      expect(result.status).toBe("active");
      expect(result.warnings).not.toContain("Suspect 1:1 VAL↔feature ratio. Either VALs are too granular (combine them) or features were invented to match VALs. Aim for M:N where a feature can fulfill multiple VALs.");
    });
  });

  test("soft-warns when larger plans have no infrastructure features", async () => {
    await withTempProject(async (projectDir) => {
      const warning = "No category:infrastructure features. Real plans usually have scaffolding/cleanup/setup features with empty fulfills[]. Consider whether any features fit that category instead of forcing every feature into category:behavior.";

      const warningId = "ch-stage-d-no-infra-warn";
      await seed(projectDir, warningId, valSpecs(5), [
        { id: "m1-a", order: 1, fulfills: ["VAL-D-001", "VAL-D-002"] },
        { id: "m1-b", order: 2, fulfills: ["VAL-D-003"] },
        { id: "m1-c", order: 3, fulfills: ["VAL-D-004"] },
        { id: "m1-d", order: 4, fulfills: ["VAL-D-005"] },
      ]);
      const warningResult = await lockPlan(projectDir, { charterId: warningId, now: "2026-05-23T00:01:00.000Z" });
      expect(warningResult.status).toBe("active");
      expect(warningResult.warnings).toContain(warning);

      const okId = "ch-stage-d-infra-ok";
      await seed(projectDir, okId, valSpecs(4), [
        { id: "m1-a", order: 1, fulfills: ["VAL-D-001", "VAL-D-002"] },
        { id: "m1-b", order: 2, fulfills: ["VAL-D-003"] },
        { id: "m1-c", order: 3, fulfills: ["VAL-D-004"] },
        { id: "m1-infra", order: 4, fulfills: [], category: "infrastructure", kind: "readiness" },
      ]);
      const okResult = await lockPlan(projectDir, { charterId: okId, now: "2026-05-23T00:01:00.000Z" });
      expect(okResult.status).toBe("active");
      expect(okResult.warnings).not.toContain(warning);
    });
  });
});
