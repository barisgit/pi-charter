import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import {
  amendCharter,
  completeCharter,
  createCharter,
  forceCompleteCharter,
  pauseCharter,
  resumeCharter,
} from "../src/application/service";
import {
  addFeature,
  addFeatureBatch,
  lockPlan,
  updateFeature,
} from "../src/application/plan-service";
import {
  recordEvidence,
  recordEvidenceBatch,
  verifyCriterion,
} from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";

/**
 * VAL-FAILURE-NEXTACTIONS:
 *
 * Every mutating tool throw site in service.ts, plan-service.ts, and
 * record-service.ts now throws a CharterToolError whose nextActions[] is
 * non-empty and whose `code` follows the canonical `<action>.<reason>` shape.
 * This test drives each documented failure mode end-to-end and asserts:
 *   - `err instanceof CharterToolError`
 *   - `err.nextActions.length > 0`
 *   - `err.code === '<expected>'`
 * plus the contract-level content spot-checks called out in the feature
 * spec (completion-gate failure names the failing criterion id; lock_plan
 * drift yields a charter_plan:update_feature nextAction; missing required
 * field hints name the field).
 */

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-failure-na-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function expectCharterToolError(promise: Promise<unknown>): Promise<CharterToolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof CharterToolError)) {
    throw new Error(`expected CharterToolError, got ${caught === undefined ? "no throw" : String(caught)}`);
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toBeInstanceOf(CharterToolError);
  expect(caught.nextActions.length).toBeGreaterThan(0);
  return caught;
}

const FEATURE_MD = (id: string, fulfills: string[], milestone = "m1") =>
  [
    "---",
    `id: ${id}`,
    `milestone: ${milestone}`,
    "order: 1",
    `fulfills: [${fulfills.join(", ")}]`,
    "preconditions: []",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");

async function seedPlanningCharter(
  projectDir: string,
  charterId: string,
  opts: { criteria: string[]; withBecause?: boolean } = { criteria: ["VAL-X-001"] },
): Promise<string> {
  await createCharter(projectDir, {
    objective: "failure nextActions probe",
    charterId,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  const because = opts.withBecause === false ? "" : "Because: manual probe";
  const criteriaMd = opts.criteria
    .map((id) => [`### ${id} probe`, "Verifier: manual", because, ""].filter(Boolean).join("\n"))
    .join("\n");
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "## Objective",
      "failure nextActions probe",
      "## Criteria",
      criteriaMd,
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  return dir;
}

async function seedActiveCharter(
  projectDir: string,
  charterId: string,
  criteria: string[] = ["VAL-X-001"],
): Promise<string> {
  const dir = await seedPlanningCharter(projectDir, charterId, { criteria });
  await mkdir(join(dir, "plan"), { recursive: true });
  for (let i = 0; i < criteria.length; i += 1) {
    await writeFile(join(dir, "plan", `f${i + 1}.md`), FEATURE_MD(`f${i + 1}`, [criteria[i]!]), "utf8");
  }
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
  return dir;
}

describe("service.ts — CharterToolError throw sites", () => {
  test("createCharter empty objective -> create.empty_objective with nextActions", async () => {
    await withTempProject(async (projectDir) => {
      const err = await expectCharterToolError(createCharter(projectDir, { objective: "   " }));
      expect(err.code).toBe("create.empty_objective");
      expect(err.message).toMatch(/objective/);
      // Missing required field spot-check: at least one hint names the field.
      expect(JSON.stringify(err.nextActions)).toMatch(/objective/);
    });
  });

  test("pauseCharter on terminal charter -> lifecycle.wrong_state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-pause-terminal";
      await seedActiveCharter(projectDir, charterId);
      await forceCompleteCharter(projectDir, {
        charterId,
        reason: "done",
        target: "abandoned",
        now: "2026-05-15T02:00:00.000Z",
      });
      const err = await expectCharterToolError(pauseCharter(projectDir, { charterId }));
      expect(err.code).toBe("lifecycle.wrong_state");
      expect(err.message).toMatch(/terminal/);
      // Terminal-state rejection points at amend_charter as a recovery hint.
      expect(err.nextActions.some((a) => a.tool === "charter_manage" && a.action === "amend_charter")).toBe(true);
    });
  });

  test("resumeCharter on non-paused charter -> lifecycle.wrong_state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-resume-active";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(resumeCharter(projectDir, { charterId }));
      expect(err.code).toBe("lifecycle.wrong_state");
      expect(err.message).toMatch(/Cannot resume/);
      expect(err.nextActions.some((a) => a.tool === "charter_status")).toBe(true);
    });
  });

  test("completeCharter wrong status -> complete.wrong_state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-complete-planning";
      await seedPlanningCharter(projectDir, charterId);
      const err = await expectCharterToolError(completeCharter(projectDir, { charterId }));
      expect(err.code).toBe("complete.wrong_state");
      expect(err.nextActions.some((a) => a.tool === "charter_status")).toBe(true);
    });
  });

  test("completeCharter gate-block -> complete.gate_blocked with failing criterion id in nextAction hint", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-complete-gate";
      await seedActiveCharter(projectDir, charterId, ["VAL-GATE-001", "VAL-GATE-002"]);
      const err = await expectCharterToolError(completeCharter(projectDir, { charterId }));
      expect(err.code).toBe("complete.gate_blocked");
      // Spot-check: at least one nextAction hint mentions the failing
      // criterion id literally (contract-level requirement from the spec).
      const blob = JSON.stringify(err.nextActions);
      expect(blob).toMatch(/VAL-GATE-001|VAL-GATE-002/);
      // And points at the documented recovery surface.
      expect(err.nextActions.some((a) => a.tool === "charter_record" && (a.action === "evidence" || a.action === "verify"))).toBe(true);
    });
  });

  test("forceCompleteCharter empty reason -> force_complete.empty_reason", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-force-noreason";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(forceCompleteCharter(projectDir, { charterId, reason: "  " }));
      expect(err.code).toBe("force_complete.empty_reason");
      expect(err.message).toMatch(/reason/);
      expect(JSON.stringify(err.nextActions)).toMatch(/reason/);
    });
  });

  test("forceCompleteCharter non-terminal target -> force_complete.non_terminal_target", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-force-bad-target";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        forceCompleteCharter(projectDir, {
          charterId,
          reason: "x",
          target: "planning" as unknown as "abandoned",
        }),
      );
      expect(err.code).toBe("force_complete.non_terminal_target");
      expect(err.message).toMatch(/terminal/);
    });
  });

  test("forceCompleteCharter already terminal -> force_complete.already_terminal", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-force-already";
      await seedActiveCharter(projectDir, charterId);
      await forceCompleteCharter(projectDir, {
        charterId,
        reason: "first",
        target: "abandoned",
        now: "2026-05-15T02:00:00.000Z",
      });
      const err = await expectCharterToolError(
        forceCompleteCharter(projectDir, { charterId, reason: "again", target: "abandoned" }),
      );
      expect(err.code).toBe("force_complete.already_terminal");
      expect(err.nextActions.some((a) => a.tool === "charter_manage" && a.action === "amend_charter")).toBe(true);
    });
  });

  test("amendCharter empty reason -> amend.empty_reason", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-noreason";
      await seedActiveCharter(projectDir, charterId);
      await forceCompleteCharter(projectDir, {
        charterId,
        reason: "done",
        target: "abandoned",
        now: "2026-05-15T02:00:00.000Z",
      });
      const err = await expectCharterToolError(amendCharter(projectDir, { charterId, reason: "  " }));
      expect(err.code).toBe("amend.empty_reason");
      expect(JSON.stringify(err.nextActions)).toMatch(/reason/);
    });
  });

  test("amendCharter bad target -> amend.bad_target", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-bad-target";
      await seedActiveCharter(projectDir, charterId);
      await forceCompleteCharter(projectDir, {
        charterId,
        reason: "done",
        target: "abandoned",
        now: "2026-05-15T02:00:00.000Z",
      });
      const err = await expectCharterToolError(
        amendCharter(projectDir, {
          charterId,
          reason: "x",
          target: "active" as unknown as "review",
        }),
      );
      expect(err.code).toBe("amend.bad_target");
    });
  });

  test("amendCharter non-terminal -> amend.non_terminal_charter", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-amend-active";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(amendCharter(projectDir, { charterId, reason: "x" }));
      expect(err.code).toBe("amend.non_terminal_charter");
      expect(err.message).toMatch(/terminal/);
    });
  });
});

describe("plan-service.ts — CharterToolError throw sites", () => {
  test("addFeature bad status -> add_feature.bad_status with view nextAction", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addf-bad-status";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        addFeature(projectDir, {
          charterId,
          id: "f-new",
          milestone: "m2",
          order: 1,
          fulfills: ["VAL-X-001"],
          body: "body",
        }),
      );
      expect(err.code).toBe("add_feature.bad_status");
      expect(err.nextActions.some((a) => a.tool === "charter_plan" && a.action === "view")).toBe(true);
    });
  });

  test("addFeature id collision -> add_feature.id_collision with update_feature nextAction", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addf-collision";
      const dir = await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-X-001"]), "utf8");
      const err = await expectCharterToolError(
        addFeature(projectDir, {
          charterId,
          id: "f1",
          milestone: "m1",
          order: 1,
          fulfills: ["VAL-X-001"],
          body: "body",
        }),
      );
      expect(err.code).toBe("add_feature.id_collision");
      expect(err.nextActions.some((a) => a.tool === "charter_plan" && a.action === "update_feature")).toBe(true);
    });
  });

  test("addFeature missing fulfills -> add_feature.missing_fulfills with field hint", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addf-no-fulfills";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      const err = await expectCharterToolError(
        addFeature(projectDir, {
          charterId,
          id: "f-new",
          milestone: "m1",
          order: 1,
          fulfills: [],
          body: "body",
        }),
      );
      expect(err.code).toBe("add_feature.missing_fulfills");
      // Missing required field spot-check.
      expect(JSON.stringify(err.nextActions)).toMatch(/fulfills/);
    });
  });

  test("addFeatureBatch empty -> add_feature.empty_batch", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addb-empty";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      const err = await expectCharterToolError(
        addFeatureBatch(projectDir, { charterId, features: [] }),
      );
      expect(err.code).toBe("add_feature.empty_batch");
    });
  });

  test("addFeatureBatch validation failure -> add_feature.validation_failed naming index", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addb-bad-id";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001", "VAL-X-002"] });
      const err = await expectCharterToolError(
        addFeatureBatch(projectDir, {
          charterId,
          features: [
            { id: "f1", milestone: "m1", order: 1, fulfills: ["VAL-X-001"], body: "ok" },
            { id: "bad id", milestone: "m1", order: 2, fulfills: ["VAL-X-002"], body: "ok" },
          ],
        }),
      );
      expect(err.code).toBe("add_feature.validation_failed");
      expect(err.message).toMatch(/index 1/);
    });
  });

  test("addFeatureBatch id collision -> add_feature.id_collision", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-addb-collision";
      const dir = await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-X-001"]), "utf8");
      const err = await expectCharterToolError(
        addFeatureBatch(projectDir, {
          charterId,
          features: [
            { id: "f1", milestone: "m1", order: 1, fulfills: ["VAL-X-001"], body: "ok" },
          ],
        }),
      );
      expect(err.code).toBe("add_feature.id_collision");
      expect(err.nextActions.some((a) => a.tool === "charter_plan" && a.action === "update_feature")).toBe(true);
    });
  });

  test("updateFeature bad id regex -> update_feature.bad_id", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-updf-bad-id";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      const err = await expectCharterToolError(
        updateFeature(projectDir, { charterId, id: "bad id" }),
      );
      expect(err.code).toBe("update_feature.bad_id");
    });
  });

  test("updateFeature bad status -> update_feature.bad_status", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-updf-status";
      const dir = await seedActiveCharter(projectDir, charterId);
      // Active charter; updateFeature is illegal here.
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-X-001"]), "utf8");
      const err = await expectCharterToolError(
        updateFeature(projectDir, { charterId, id: "f1", body: "x" }),
      );
      expect(err.code).toBe("update_feature.bad_status");
    });
  });

  test("updateFeature not found -> update_feature.not_found", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-updf-missing";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      const err = await expectCharterToolError(
        updateFeature(projectDir, { charterId, id: "f-missing", body: "x" }),
      );
      expect(err.code).toBe("update_feature.not_found");
      expect(err.nextActions.some((a) => a.tool === "charter_plan" && a.action === "add_feature")).toBe(true);
    });
  });

  test("lockPlan bad status -> lock_plan.bad_status", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-active";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId }));
      expect(err.code).toBe("lock_plan.bad_status");
    });
  });

  test("lockPlan drift -> lock_plan.drift with update_feature nextAction", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-drift";
      const dir = await seedPlanningCharter(projectDir, charterId, {
        criteria: ["VAL-D-001", "VAL-D-002"],
      });
      // Cover only one criterion; the other stays uncovered -> drift.
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-D-001"]), "utf8");
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId }));
      expect(err.code).toBe("lock_plan.drift");
      // Spot-check: drift hints point at charter_plan:update_feature.
      expect(
        err.nextActions.some((a) => a.tool === "charter_plan" && a.action === "update_feature"),
      ).toBe(true);
    });
  });

  test("lockPlan empty features -> lock_plan.empty_features", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-emptyf";
      await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-X-001"] });
      // No feature files written.
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId }));
      expect(err.code).toBe("lock_plan.empty_features");
    });
  });

  test("lockPlan cycle -> lock_plan.cycle", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-cycle";
      const dir = await seedPlanningCharter(projectDir, charterId, { criteria: ["VAL-C-001"] });
      await mkdir(join(dir, "plan"), { recursive: true });
      const cyc = (id: string, dep: string) =>
        [
          "---",
          `id: ${id}`,
          "milestone: m1",
          "order: 1",
          "fulfills: [VAL-C-001]",
          `preconditions:`,
          `  - ${dep}`,
          "---",
          "",
          `# ${id}`,
          "",
        ].join("\n");
      await writeFile(join(dir, "plan", "a.md"), cyc("a", "b"), "utf8");
      await writeFile(join(dir, "plan", "b.md"), cyc("b", "a"), "utf8");
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId }));
      expect(err.code).toBe("lock_plan.cycle");
      expect(err.message).toMatch(/cycle/);
    });
  });

  test("lockPlan weak verifier -> lock_plan.weak_verifier", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-weak";
      // Author criterion WITHOUT Because:
      const dir = await seedPlanningCharter(projectDir, charterId, {
        criteria: ["VAL-W-001"],
        withBecause: false,
      });
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-W-001"]), "utf8");
      const err = await expectCharterToolError(lockPlan(projectDir, { charterId }));
      expect(err.code).toBe("lock_plan.weak_verifier");
    });
  });
});

describe("record-service.ts — CharterToolError throw sites", () => {
  test("recordEvidence missing summary -> evidence.missing_summary with field hint", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-rec-nosum";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-X-001",
          outcome: "pass",
          summary: "  ",
        }),
      );
      expect(err.code).toBe("evidence.missing_summary");
      expect(JSON.stringify(err.nextActions)).toMatch(/summary/);
    });
  });

  test("recordEvidence bad status -> evidence.bad_status", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-rec-planning";
      await seedPlanningCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-X-001",
          outcome: "pass",
          summary: "ok",
          because: "manual",
        }),
      );
      expect(err.code).toBe("evidence.bad_status");
    });
  });

  test("recordEvidence unknown criterion -> evidence.unknown_criterion", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-rec-unknown";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-NOPE-999",
          outcome: "pass",
          summary: "ok",
          because: "manual",
        }),
      );
      expect(err.code).toBe("evidence.unknown_criterion");
    });
  });

  test("recordEvidence missing because (manual) -> evidence.missing_because", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-rec-nobecause";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-X-001",
          outcome: "pass",
          summary: "ok",
          source: "manual",
        }),
      );
      expect(err.code).toBe("evidence.missing_because");
      // Field-name spot-check on the recovery hint.
      expect(JSON.stringify(err.nextActions)).toMatch(/because/);
    });
  });

  test("recordEvidenceBatch empty -> evidence.empty_batch", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-recb-empty";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidenceBatch(projectDir, { charterId, entries: [] }),
      );
      expect(err.code).toBe("evidence.empty_batch");
    });
  });

  test("recordEvidenceBatch entry missing summary -> evidence.missing_summary", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-recb-nosum";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidenceBatch(projectDir, {
          charterId,
          entries: [
            { criterionId: "VAL-X-001", outcome: "pass", summary: "" },
          ],
        }),
      );
      expect(err.code).toBe("evidence.missing_summary");
    });
  });

  test("recordEvidenceBatch entry unknown criterion -> evidence.unknown_criterion", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-recb-unknown";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidenceBatch(projectDir, {
          charterId,
          entries: [
            {
              criterionId: "VAL-NOPE-999",
              outcome: "pass",
              summary: "ok",
              because: "manual",
            },
          ],
        }),
      );
      expect(err.code).toBe("evidence.unknown_criterion");
    });
  });

  test("recordEvidenceBatch entry missing because -> evidence.missing_because", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-recb-nobecause";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        recordEvidenceBatch(projectDir, {
          charterId,
          entries: [
            {
              criterionId: "VAL-X-001",
              outcome: "pass",
              summary: "ok",
              source: "manual",
            },
          ],
        }),
      );
      expect(err.code).toBe("evidence.missing_because");
    });
  });

  test("verifyCriterion bad status -> verify.bad_status", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ver-planning";
      await seedPlanningCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        verifyCriterion(projectDir, { charterId, criterionId: "VAL-X-001" }),
      );
      expect(err.code).toBe("verify.bad_status");
    });
  });

  test("verifyCriterion unknown criterion -> verify.unknown_criterion", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ver-unknown";
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        verifyCriterion(projectDir, { charterId, criterionId: "VAL-NOPE-999" }),
      );
      expect(err.code).toBe("verify.unknown_criterion");
    });
  });

  test("verifyCriterion non-command verifier -> verify.non_command_verifier", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ver-manual";
      // Active charter with manual verifier.
      await seedActiveCharter(projectDir, charterId);
      const err = await expectCharterToolError(
        verifyCriterion(projectDir, { charterId, criterionId: "VAL-X-001" }),
      );
      expect(err.code).toBe("verify.non_command_verifier");
    });
  });

  test("verifyCriterion missing command -> verify.missing_command", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ver-nocmd";
      await createCharter(projectDir, { objective: "x", charterId, now: "2026-05-15T00:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      // Author a command verifier without a Command: line.
      await writeFile(
        join(dir, "charter.md"),
        [
          "# Charter",
          "## Objective",
          "x",
          "## Criteria",
          "### VAL-CMD-001 — Command",
          "Verifier: command",
          "## Scope and constraints",
          "- none",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), FEATURE_MD("f1", ["VAL-CMD-001"]), "utf8");
      await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z", legacy: true });
      const err = await expectCharterToolError(
        verifyCriterion(projectDir, { charterId, criterionId: "VAL-CMD-001" }),
      );
      expect(err.code).toBe("verify.missing_command");
    });
  });
});
