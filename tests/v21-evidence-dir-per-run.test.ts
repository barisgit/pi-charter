import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { createCharter, getCharterStatus, loadFeatureEvidence } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-v21-evidence-dir-"));
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

const CHARTER_MD = [
  "# Charter",
  "",
  "## Objective",
  "",
  "Evidence dir-per-run probe.",
  "",
  "## Criteria",
  "",
  "### VAL-EVIDENCE-DIR-PER-RUN — Evidence layout",
  "Description: Evidence writes use one run directory per evidence record.",
  "Verifier: manual",
  "Because: test fixture rationale",
  "",
  "### VAL-EVIDENCE-DIR-EDGE — Evidence edge",
  "Description: Evidence collision and reader edge cases are supported.",
  "Verifier: manual",
  "Because: test fixture rationale",
  "",
  "## Scope and constraints",
  "",
  "- Keep evidence records append-only.",
  "",
].join("\n");

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Evidence dir-per-run probe",
    charterId,
    now: "2026-05-21T09:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), CHARTER_MD, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"Evidence layout fixture. ".repeat(12)}\n`, "utf8");
  await writeFile(
    join(dir, "plan", "f2-evidence-dir-per-run.md"),
    [
      "---",
      "id: f2-evidence-dir-per-run",
      "milestone: m1-schema",
      "order: 1",
      "fulfills:",
      "  - VAL-EVIDENCE-DIR-PER-RUN",
      "  - VAL-EVIDENCE-DIR-EDGE",
      "preconditions: []",
      "---",
      "",
      "# Evidence dir per run",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-21T09:10:00.000Z" });
  return dir;
}

function stamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("v2.1 evidence dir-per-run", () => {
  test("dir-per-run layout: writes evidence.json inside <ts> dir", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d201";
      const dir = await makeActiveCharter(projectDir, charterId);
      const now = "2026-05-21T12:00:00.000Z";

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        featureId: "f2-evidence-dir-per-run",
        outcome: "pass",
        summary: "dir-per-run evidence stored",
        because: "the writer returned a run-directory evidence path",
        now,
      });

      expect(result.path).toBe(join("work", "f2-evidence-dir-per-run", "evidence", stamp(now), "evidence.json"));
      const evidenceDirEntries = await readdir(join(dir, "work", "f2-evidence-dir-per-run", "evidence"));
      expect(evidenceDirEntries).toContain(stamp(now));
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.criterionId).toBe("VAL-EVIDENCE-DIR-PER-RUN");
      expect(stored.ts).toBe(now);
    });
  });

  test("same-second timestamp collision uses ts-N suffix", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d203";
      const dir = await makeActiveCharter(projectDir, charterId);
      const now = "2026-05-21T12:00:01.000Z";

      const first = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        featureId: "f2-evidence-dir-per-run",
        outcome: "pass",
        summary: "first same-second record",
        because: "first writer gets the base timestamp directory",
        now,
      });
      const second = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-EDGE",
        featureId: "f2-evidence-dir-per-run",
        outcome: "pass",
        summary: "second same-second record",
        because: "second writer gets a suffixed timestamp directory",
        now,
      });

      expect(first.path).toBe(join("work", "f2-evidence-dir-per-run", "evidence", stamp(now), "evidence.json"));
      expect(second.path).toBe(join("work", "f2-evidence-dir-per-run", "evidence", `${stamp(now)}-1`, "evidence.json"));
      expect(JSON.parse(await readFile(join(dir, second.path), "utf8")).criterionId).toBe("VAL-EVIDENCE-DIR-EDGE");
    });
  });

  test("non-JSON artifact coexists in run dir with evidence.json", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000d204";
      const dir = await makeActiveCharter(projectDir, charterId);
      const featureId = "f2-evidence-dir-per-run";
      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-EVIDENCE-DIR-PER-RUN",
        featureId,
        outcome: "pass",
        summary: "record with sibling artifact",
        artifacts: ["capture.png"],
        because: "non-json artifacts are allowed beside evidence.json",
        now: "2026-05-21T12:00:02.000Z",
      });
      const runDir = dirname(join(dir, result.path));
      await writeFile(join(runDir, "capture.png"), "not really an image", "utf8");

      const runEntries = await readdir(runDir);
      expect(runEntries.sort()).toEqual(["capture.png", "evidence.json"]);
      const records = await loadFeatureEvidence(dir, featureId);
      expect(records).toHaveLength(1);
      expect(records[0]!.path).toBe(result.path);
    });
  });
});
