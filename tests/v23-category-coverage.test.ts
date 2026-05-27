/**
 * Stage C: `category: behavior | infrastructure` and the tightened lock_plan
 * coverage gate. This file is the named verifier for the new rules:
 *   (a) Every VAL-* must be claimed by AT LEAST ONE feature (orphan VAL).
 *   (b) No VAL-* may be claimed by MORE THAN ONE feature (duplicate VAL).
 *   (c) A `category:behavior` feature must claim AT LEAST ONE VAL.
 *       `category:infrastructure` features are exempt from (a)'s symmetric
 *       check on the feature side — i.e. they MAY have empty fulfills.
 *
 * Frontmatter defaults: when `category:` is omitted, the parser uses `behavior`.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-stage-c-"));
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

function charterMarkdown(criteria: string[]): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "Stage C category coverage gate.",
    "",
    "## Criteria",
    "",
    ...criteria.flatMap((id) => [
      `### ${id} — ${id}`,
      "Verifier: manual",
      `Because: deterministic stage C probe for ${id}`,
      "",
    ]),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

interface FeatureSpec {
  id: string;
  order: number;
  fulfills: string[];
  category?: "behavior" | "infrastructure";
  // kind:readiness lets infrastructure features skip the impl-only validation
  // shape gate without needing happy/edge blocks.
  kind?: "impl" | "readiness" | "review" | "qa";
  validation?: boolean;
}

function featureMarkdown(spec: FeatureSpec): string {
  const lines = ["---", `id: ${spec.id}`, "milestone: m1", `order: ${spec.order}`];
  if (spec.category) lines.push(`category: ${spec.category}`);
  if (spec.kind) lines.push(`kind: ${spec.kind}`);
  if (spec.fulfills.length === 0) lines.push("fulfills: []");
  else {
    lines.push("fulfills:");
    for (const v of spec.fulfills) lines.push(`  - ${v}`);
  }
  lines.push("preconditions: []", "---", "", `# ${spec.id}`, "");
  if (spec.validation ?? true) lines.push(VALIDATION_MD);
  return lines.join("\n");
}

async function seed(
  projectDir: string,
  charterId: string,
  criteria: string[],
  features: FeatureSpec[],
): Promise<void> {
  await createCharter(projectDir, {
    objective: "Stage C category coverage gate",
    charterId,
    now: "2026-05-21T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(criteria), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const feature of features) {
    await writeFile(join(dir, "plan", `${feature.id}.md`), featureMarkdown(feature), "utf8");
  }
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

describe("Stage C: category + tightened lock_plan coverage gate", () => {
  test("happy: behavior features cover every VAL + 1 infrastructure feature with empty fulfills -> lock_plan transitions to active", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-c-happy";
      await seed(projectDir, charterId, ["VAL-C-001", "VAL-C-002"], [
        { id: "f-cover-a", order: 1, fulfills: ["VAL-C-001"] },
        { id: "f-cover-b", order: 2, fulfills: ["VAL-C-002"] },
        // category:infrastructure + kind:readiness so the impl-only validation
        // shape gate doesn't fire and the empty-fulfills carve-out applies.
        { id: "f-infra-gate", order: 3, fulfills: [], category: "infrastructure", kind: "readiness", validation: false },
      ]);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      expect(result.status).toBe("active");
      expect(result.featureCount).toBe(3);
    });
  });

  test("orphan VAL: 2 criteria declared, only 1 covered -> lock_plan throws naming the orphan VAL", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-c-orphan";
      await seed(projectDir, charterId, ["VAL-C-001", "VAL-C-ORPHAN"], [
        { id: "f-only", order: 1, fulfills: ["VAL-C-001"] },
      ]);
      const err = await expectLockError(projectDir, charterId);
      expect(err.code).toBe("lock_plan.drift");
      expect(err.message).toContain("no feature claims");
      expect(err.message).toContain("VAL-C-ORPHAN");
    });
  });

  test("duplicate VAL: two features both fulfill VAL-C-001 -> lock_plan throws with both feature ids", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-c-dup";
      await seed(projectDir, charterId, ["VAL-C-001"], [
        { id: "f-claim-a", order: 1, fulfills: ["VAL-C-001"] },
        { id: "f-claim-b", order: 2, fulfills: ["VAL-C-001"] },
      ]);
      const err = await expectLockError(projectDir, charterId);
      expect(err.code).toBe("lock_plan.duplicate_fulfills");
      expect(err.message).toContain("duplicate VAL claims");
      expect(err.message).toContain("VAL-C-001");
      expect(err.message).toContain("f-claim-a");
      expect(err.message).toContain("f-claim-b");
    });
  });

  test("behavior + empty fulfills: default category with fulfills:[] -> lock_plan throws orphan-feature", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-c-empty-behavior";
      await seed(projectDir, charterId, ["VAL-C-001"], [
        // Covers VAL so the orphan-VAL drift doesn't mask this case.
        { id: "f-cover", order: 1, fulfills: ["VAL-C-001"] },
        // Omitted category defaults to behavior and MUST fail with empty fulfills.
        { id: "f-empty-behavior", order: 2, fulfills: [] },
      ]);
      const err = await expectLockError(projectDir, charterId);
      expect(err.code).toBe("lock_plan.drift");
      expect(err.message).toContain("category:behavior features with empty fulfills");
      expect(err.message).toContain("f-empty-behavior");
    });
  });

  test("infrastructure + empty fulfills: category:infrastructure with fulfills:[] -> lock_plan transitions to active", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "ch-stage-c-empty-infra";
      await seed(projectDir, charterId, ["VAL-C-001"], [
        { id: "f-cover", order: 1, fulfills: ["VAL-C-001"] },
        // category:infrastructure + kind:readiness so validation-shape gate doesn't fire.
        { id: "f-infra", order: 2, fulfills: [], category: "infrastructure", kind: "readiness", validation: false },
      ]);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      expect(result.status).toBe("active");
      expect(result.featureCount).toBe(2);
    });
  });
});
