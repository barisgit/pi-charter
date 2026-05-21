import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { runEvaluator, type EvaluatorAssessment, type EvaluatorModelFn } from "../src/application/evaluator-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-eval-log-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, { objective: "Concurrent evaluator-log probe", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Concurrent evaluator-log probe.",
      "",
      "## Criteria",
      "",
      "### VAL-EL-001 — happy path",
      "Description: Happy path.",
      "Verifier: manual",
      "",
      "## Scope and constraints",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-EL-001\npreconditions: []\n---\n\n# F1\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T00:30:00.000Z", legacy: true });
  return dir;
}

function fakeModel(assessment: EvaluatorAssessment): EvaluatorModelFn {
  return async () => assessment;
}

describe("concurrent appendEvaluatorEntry", () => {
  test("parallel runEvaluator calls produce a well-formed rolling log (no torn writes)", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-concurrent-eval-log";
      const dir = await makeActiveCharter(projectDir, charterId);

      const model = fakeModel({
        verdict: "drifting",
        confidence: 0.7,
        reason: "VAL-EL-001 still uncovered",
        steerReminder: "Run charter_record evidence on VAL-EL-001.",
        cites: [{ criterionId: "VAL-EL-001" }],
      });

      const n = 16;
      await Promise.all(
        Array.from({ length: n }, (_, index) =>
          runEvaluator(projectDir, {
            charterId,
            trigger: "turn_end",
            modelFn: model,
            now: `2026-05-15T01:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        ),
      );

      const raw = await readFile(join(dir, "evaluator-log.jsonl"), "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);

      // Rolling window cap is 10.
      expect(lines).toHaveLength(10);

      // Every line must be valid JSON (no torn writes interleaving partial content).
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.charterId).toBe(charterId);
        expect(parsed.verdict).toBe("drifting");
        expect(typeof parsed.ts).toBe("string");
      }

      // The retained entries must be a subset of the timestamps we issued; no dupes within the kept window.
      const issuedTs = new Set(
        Array.from({ length: n }, (_, index) => `2026-05-15T01:00:${String(index).padStart(2, "0")}.000Z`),
      );
      const keptTs = lines.map((line) => JSON.parse(line).ts as string);
      for (const ts of keptTs) {
        expect(issuedTs.has(ts)).toBe(true);
      }
      expect(new Set(keptTs).size).toBe(keptTs.length);
    });
  });
});
