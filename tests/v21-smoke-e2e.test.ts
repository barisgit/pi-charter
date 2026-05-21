import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidenceFromFile } from "../src/application/record-service";
import { createCharter, getCharterStatus, loadFeatureEvidence } from "../src/application/service";
import type { QaEvidence } from "../src/domain/evidence-schemas";
import { charterDir } from "../src/infrastructure/store";

const CHARTER_ID = "00000000-0000-4000-8000-00000000e201";
const FEATURE_ID = "feat-smoke";
const CRITERION_ID = "VAL-SMOKE-E2E";
const RUN_STAMP = "2026-05-21T13-00-00-000Z";
const RECORD_TS = "2026-05-21T13:00:00.000Z";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-v21-smoke-e2e-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

async function makeActiveCharter(projectDir: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Smoke e2e probe",
    charterId: CHARTER_ID,
    now: "2026-05-21T12:50:00.000Z",
  });
  const dir = charterDir(projectDir, CHARTER_ID);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Smoke e2e probe.",
      "",
      "## Criteria",
      "",
      `### ${CRITERION_ID} — Smoke e2e`,
      "Description: QA smoke records artifacts and markdown narrative.",
      "Verifier: manual",
      "",
      "## Scope and constraints",
      "",
      "- Use only throwaway tmpdir evidence.",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"Smoke fixture. ".repeat(20)}\n`, "utf8");
  await writeFile(
    join(dir, "plan", `${FEATURE_ID}.md`),
    [
      "---",
      `id: ${FEATURE_ID}`,
      "milestone: m1-smoke",
      "order: 1",
      "fulfills:",
      `  - ${CRITERION_ID}`,
      "preconditions: []",
      "---",
      "",
      "# Smoke feature",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId: CHARTER_ID, now: "2026-05-21T12:55:00.000Z", legacy: true });
  return dir;
}

function qaEvidence(): QaEvidence {
  return {
    kind: "qa",
    featureId: FEATURE_ID,
    milestone: "m1-smoke",
    surfaces: ["charter_record evidenceFile"],
    outcome: "pass",
    artifacts: [
      { kind: "terminal_capture", path: "artifacts/terminal_capture.cast", caption: "Terminal capture smoke" },
      { kind: "screenshot", path: "artifacts/screenshot.png", caption: "Screenshot smoke" },
    ],
    findings: [],
    summary: "QA smoke passed with artifacts and markdown narrative.",
    because: "The smoke evidence exercises dir-per-run artifacts and qa.md import.",
    narrativePath: "qa.md",
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function setupRecordedSmoke(projectDir: string) {
  const dir = await makeActiveCharter(projectDir);
  const runDir = join(dir, "work", FEATURE_ID, "evidence", RUN_STAMP);
  const evidence = qaEvidence();

  await mkdir(join(runDir, "artifacts"), { recursive: true });
  await writeFile(join(runDir, "artifacts", "terminal_capture.cast"), "terminal smoke\n", "utf8");
  await writeFile(join(runDir, "artifacts", "screenshot.png"), "png smoke\n", "utf8");
  await writeJson(join(runDir, "qa.json"), evidence);
  await writeFile(join(runDir, "qa.md"), "# QA smoke narrative\n", "utf8");

  const result = await recordEvidenceFromFile(projectDir, {
    charterId: CHARTER_ID,
    evidenceFile: join(runDir, "qa.json"),
    now: RECORD_TS,
  });

  return { dir, runDir, evidence, result };
}

describe("v2.1 smoke e2e", () => {
  test("smoke produces qa.json and qa.md in dir-per-run layout", async () => {
    await withTempProject(async (projectDir) => {
      const { dir, runDir, result } = await setupRecordedSmoke(projectDir);

      expect(result.entries[0]!.path).toBe(join("work", FEATURE_ID, "evidence", RUN_STAMP, "evidence.json"));
      await expect(pathExists(join(runDir, "qa.json"))).resolves.toBe(true);
      await expect(pathExists(join(runDir, "qa.md"))).resolves.toBe(true);
      await expect(pathExists(join(dir, result.entries[0]!.path))).resolves.toBe(true);
    });
  });

  test("smoke records at least one non-screenshot artifact kind", async () => {
    await withTempProject(async (projectDir) => {
      const { runDir } = await setupRecordedSmoke(projectDir);
      const stored = JSON.parse(await readFile(join(runDir, "qa.json"), "utf8")) as QaEvidence;

      expect(stored.artifacts.some((artifact) => artifact.kind !== "screenshot")).toBe(true);
      expect(stored.artifacts.map((artifact) => artifact.kind)).toContain("terminal_capture");
    });
  });

  test("smoke artifacts paths point at files that actually exist", async () => {
    await withTempProject(async (projectDir) => {
      const { evidence, runDir } = await setupRecordedSmoke(projectDir);

      for (const artifact of evidence.artifacts) {
        await expect(pathExists(join(runDir, artifact.path))).resolves.toBe(true);
      }
    });
  });

  test("smoke drift reader surfaces narrativePath for qa.md", async () => {
    await withTempProject(async (projectDir) => {
      const { dir } = await setupRecordedSmoke(projectDir);

      const records = await loadFeatureEvidence(dir, FEATURE_ID);
      expect(records).toHaveLength(1);
      expect(records[0]!.record.narrativePath).toBe("qa.md");
      expect((records[0]!.record.details as { typedEvidence?: QaEvidence }).typedEvidence?.narrativePath).toBe("qa.md");
      await expect(getCharterStatus(projectDir, { charterId: CHARTER_ID })).resolves.toMatchObject({
        drift: { uncovered: [] },
      });
    });
  });
});
