import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeCharter, createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff, recordEvidence } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";
import { clearHookSubscribers } from "../src/application/hooks";

// Hook subscribers are module-global; isolate this file from leaks via
// `tests/hooks.test.ts`, which only clears in its own beforeEach.
beforeEach(() => clearHookSubscribers());

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-dogfood-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const DOGFOOD_VALS = ["VAL-D-001", "VAL-D-002", "VAL-D-003"];
const CHARTER_DOG = "cha-dogfood";

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

async function seedDogfoodCharter(projectDir: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Dogfood the complete gate end-to-end",
    charterId: CHARTER_DOG,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, CHARTER_DOG);
  // Every VAL declares Verifier: command + Command: true so lockPlan passes
  // (no `manual + no Because` BLOCK). None declares Review subagent required;
  // the m4 auto-default must therefore flag every VAL at complete time.
  const criteriaLines = DOGFOOD_VALS.flatMap((id) => [
    `### ${id} — dogfood criterion`,
    "Description: trivial.",
    "Verifier: command",
    "Command: true",
    "",
  ]);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Dogfood probe.",
      "",
      "## Criteria",
      "",
      ...criteriaLines,
      "## Scope and constraints",
      "",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  // One feature per VAL, each in its own milestone so milestone_ready_for_review
  // fires per VAL after evidence flips feature-state to completed.
  for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
    const valId = DOGFOOD_VALS[idx];
    const featureId = `f${idx + 1}`;
    await writeFile(
      join(dir, "plan", `${featureId}.md`),
      [
        "---",
        `id: ${featureId}`,
        `milestone: m${idx + 1}`,
        `order: ${idx + 1}`,
        "fulfills:",
        `  - ${valId}`,
        "preconditions: []",
        "---",
        `# ${featureId}`,
        "",
        VALIDATION_MD,
      ].join("\n"),
      "utf8",
    );
  }
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"Dogfood architecture. ".repeat(12)}`, "utf8");
  await lockPlan(projectDir, { charterId: CHARTER_DOG, now: "2026-05-15T00:30:00.000Z" });
  return dir;
}

describe("dogfood complete gate (VAL-14A, VAL-14B)", () => {
  test("first complete rejects with every VAL flagged; second complete succeeds after charter-reviewer review", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedDogfoodCharter(projectDir);

      // Record implementer-only manual+because pass evidence for every VAL.
      let ts = Date.parse("2026-05-15T01:00:00.000Z");
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        const valId = DOGFOOD_VALS[idx];
        const featureId = `f${idx + 1}`;
        await recordEvidence(projectDir, {
          charterId: CHARTER_DOG,
          criterionId: valId,
          featureId,
          outcome: "pass",
          summary: `manual sign-off for ${valId}`,
          because: "manual rationale",
          recordedBy: "agent:root",
          now: new Date(ts).toISOString(),
        });
        ts += 60_000;
      }

      // Sanity: every feature flipped to completed and a milestone_ready_for_review
      // event fired for every milestone.
      const featureState0 = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        expect(featureState0.features[`f${idx + 1}`].status).toBe("completed");
      }
      const events0 = (await readFile(join(dir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const ready0 = events0.filter((event) => event.type === "milestone_ready_for_review");
      expect(ready0).toHaveLength(DOGFOOD_VALS.length);

      // VAL-14A: first complete must throw with every VAL id in the message.
      let caught: unknown;
      try {
        await completeCharter(projectDir, { charterId: CHARTER_DOG, now: "2026-05-15T02:00:00.000Z" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      for (const valId of DOGFOOD_VALS) expect(msg).toContain(valId);

      // Pin implementer session ids on every feature so the verifier handoff
      // is identity-disjoint (its subagentSessionId differs).
      const featureStatePath = join(dir, "feature-state.json");
      const fs0 = JSON.parse(await readFile(featureStatePath, "utf8"));
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        const featureId = `f${idx + 1}`;
        fs0.features[featureId] = { ...(fs0.features[featureId] ?? {}), lastWorkerSessionId: `impl-${idx + 1}` };
      }
      await writeFile(featureStatePath, `${JSON.stringify(fs0, null, 2)}\n`);

      // VAL-14B: simulate a charter-reviewer subagent for every flagged VAL.
      ts = Date.parse("2026-05-15T02:30:00.000Z");
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        const valId = DOGFOOD_VALS[idx];
        const featureId = `f${idx + 1}`;
        await applyHandoff(projectDir, {
          charterId: CHARTER_DOG,
          featureId,
          subagentSessionId: "charter-reviewer-A",
          handoffNote: `charter-reviewer review for ${valId}`,
          completedCriteria: [
            { criterionId: valId, outcome: "pass", summary: `verifier reviewed ${valId}` },
          ],
          now: new Date(ts).toISOString(),
        });
        ts += 60_000;
      }
      // applyHandoff overwrote lastWorkerSessionId to charter-reviewer-A;
      // restore the original implementer ids so identity-disjoint remains
      // satisfied (impl-N != charter-reviewer-A).
      const fs1 = JSON.parse(await readFile(featureStatePath, "utf8"));
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        fs1.features[`f${idx + 1}`].lastWorkerSessionId = `impl-${idx + 1}`;
      }
      await writeFile(featureStatePath, `${JSON.stringify(fs1, null, 2)}\n`);

      const result = await completeCharter(projectDir, { charterId: CHARTER_DOG, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });
});
