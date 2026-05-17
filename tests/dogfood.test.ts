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
      ].join("\n"),
      "utf8",
    );
  }
  await lockPlan(projectDir, { charterId: CHARTER_DOG, now: "2026-05-15T00:30:00.000Z" });
  return dir;
}

describe("dogfood complete gate (VAL-14A, VAL-14B)", () => {
  test("first complete rejects with every VAL flagged; second complete succeeds after charter-verifier review", async () => {
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

      // VAL-14B: simulate a charter-verifier subagent for every flagged VAL.
      ts = Date.parse("2026-05-15T02:30:00.000Z");
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        const valId = DOGFOOD_VALS[idx];
        const featureId = `f${idx + 1}`;
        await applyHandoff(projectDir, {
          charterId: CHARTER_DOG,
          featureId,
          subagentSessionId: "charter-verifier-A",
          handoffNote: `charter-verifier review for ${valId}`,
          completedCriteria: [
            { criterionId: valId, outcome: "pass", summary: `verifier reviewed ${valId}` },
          ],
          now: new Date(ts).toISOString(),
        });
        ts += 60_000;
      }
      // applyHandoff overwrote lastWorkerSessionId to charter-verifier-A;
      // restore the original implementer ids so identity-disjoint remains
      // satisfied (impl-N != charter-verifier-A).
      const fs1 = JSON.parse(await readFile(featureStatePath, "utf8"));
      for (let idx = 0; idx < DOGFOOD_VALS.length; idx++) {
        fs1.features[`f${idx + 1}`].lastWorkerSessionId = `impl-${idx + 1}`;
      }
      await writeFile(featureStatePath, `${JSON.stringify(fs1, null, 2)}\n`);

      const result = await completeCharter(projectDir, { charterId: CHARTER_DOG, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });

  test("legacy lock_plan sub-test: missing Verifier: blocks without legacy flag, defers to complete with legacy:true", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-dogfood-legacy";
      await createCharter(projectDir, {
        objective: "Legacy migration probe",
        charterId,
        now: "2026-05-15T00:00:00.000Z",
      });
      const dir = charterDir(projectDir, charterId);
      // Legacy charter: VALs lack Verifier: entirely. parseCharterMarkdown
      // emits a `missing-verifier` warning per VAL. lockPlan without legacy
      // must BLOCK; lockPlan with `legacy: true` must pass.
      await writeFile(
        join(dir, "charter.md"),
        [
          "# Charter",
          "",
          "## Objective",
          "",
          "Legacy probe.",
          "",
          "## Criteria",
          "",
          "### VAL-LEG-1 — first legacy",
          "Description: old-style criterion with no verifier line.",
          "",
          "### VAL-LEG-2 — second legacy",
          "Description: also old-style.",
          "",
          "## Scope and constraints",
          "",
          "- none",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(
        join(dir, "plan", "f1.md"),
        [
          "---",
          "id: f1",
          "milestone: m1",
          "order: 1",
          "fulfills:",
          "  - VAL-LEG-1",
          "preconditions: []",
          "---",
          "# f1",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(dir, "plan", "f2.md"),
        [
          "---",
          "id: f2",
          "milestone: m2",
          "order: 2",
          "fulfills:",
          "  - VAL-LEG-2",
          "preconditions: []",
          "---",
          "# f2",
          "",
        ].join("\n"),
        "utf8",
      );

      // Without legacy: lockPlan rejects citing the missing Verifier (parsed
      // as default verifier=manual; the weak-verifier BLOCK fires).
      await expect(
        lockPlan(projectDir, { charterId, now: "2026-05-15T00:30:00.000Z" }),
      ).rejects.toThrow(/weak verifier|VAL-LEG/i);

      // With legacy: true, lockPlan passes; the BLOCK is deferred to complete.
      const lock = await lockPlan(projectDir, {
        charterId,
        now: "2026-05-15T00:31:00.000Z",
        legacy: true,
      });
      expect(lock.status).toBe("active");

      // Try to complete: subsequent gate must reject. With only manual evidence
      // (and recordedBy=agent:root by default), the trust gate blocks. The
      // important thing for VAL-14A's legacy sub-test is that complete is
      // BLOCKED rather than silently letting the legacy charter through.
      for (const valId of ["VAL-LEG-1", "VAL-LEG-2"]) {
        await recordEvidence(projectDir, {
          charterId,
          criterionId: valId,
          featureId: valId === "VAL-LEG-1" ? "f1" : "f2",
          outcome: "pass",
          summary: `legacy ${valId}`,
          because: "legacy manual rationale",
          recordedBy: "agent:root",
          now: "2026-05-15T01:00:00.000Z",
        });
      }
      await expect(
        completeCharter(projectDir, { charterId, now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/VAL-LEG-1|VAL-LEG-2|low-trust/i);
    });
  });
});
