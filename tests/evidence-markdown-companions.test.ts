import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordEvidenceFromFile } from "../src/application/record-service";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-evidence-md-companions-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function flatEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    criterionId: "VAL-QA",
    featureId: "VAL-QA",
    outcome: "pass",
    summary: "Evidence passed with markdown narrative.",
    because: "The evidence imports a human-readable markdown companion.",
    source: "subagent",
    recordedBy: "subagent:review:stub-session",
    ts: "2026-05-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("flat evidence markdown companions", () => {
  test("evidence record accepts relative narrativePath", () => {
    const result = validateEvidenceFile(flatEvidence({ narrativePath: "qa.md" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.narrativePath).toBe("qa.md");
  });

  test("evidence record rejects absolute narrativePath", () => {
    const result = validateEvidenceFile(flatEvidence({ narrativePath: "/tmp/qa.md" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("narrativePath must be relative");
  });

  test("evidence record rejects narrativePath outside run dir", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c301";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Markdown companion probe",
        now: "2026-05-21T10:00:00.000Z",
        criteria: [{ id: "VAL-QA", title: "QA companion", verifier: "manual" }],
      });
      const runDir = join(dir, "work", "VAL-QA", "evidence", "outside-run");
      await writeJson(join(runDir, "evidence.json"), flatEvidence({ narrativePath: "../qa.md" }));
      await writeFile(join(dir, "work", "VAL-QA", "evidence", "qa.md"), "# outside\n", "utf8");

      let err: any;
      try {
        await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: join(runDir, "evidence.json") });
      } catch (error) {
        err = error;
      }
      expect(err.code).toBe("evidence.narrative_path_invalid");
      expect(err.message).toContain("evidence run directory");
    });
  });

  test("qa.md companion lands next to evidence.json in dir-per-run", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c302";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Markdown companion probe",
        now: "2026-05-21T10:00:00.000Z",
        criteria: [{ id: "VAL-QA", title: "QA companion", verifier: "manual" }],
      });
      const runDir = join(dir, "work", "VAL-QA", "evidence", "2026-05-21T12-00-00-000Z");
      await writeJson(join(runDir, "evidence.json"), flatEvidence({ narrativePath: "qa.md" }));
      await writeFile(join(runDir, "qa.md"), "# QA narrative\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, {
        charterId,
        evidenceFile: join(runDir, "evidence.json"),
      });
      expect(result.entries[0]?.outcome).toBe("pass");
      await readFile(join(runDir, "qa.md"), "utf8");
    });
  });

  test("review.md companion lands next to evidence.json in dir-per-run", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c303";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Markdown companion probe",
        now: "2026-05-21T10:00:00.000Z",
        criteria: [{ id: "VAL-REVIEW", title: "Review companion", verifier: "manual" }],
      });
      const runDir = join(dir, "work", "VAL-REVIEW", "evidence", "2026-05-21T12-00-00-000Z");
      await writeJson(join(runDir, "evidence.json"), flatEvidence({
        criterionId: "VAL-REVIEW",
        featureId: "VAL-REVIEW",
        narrativePath: "review.md",
      }));
      await writeFile(join(runDir, "review.md"), "# Review narrative\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, {
        charterId,
        evidenceFile: join(runDir, "evidence.json"),
      });
      expect(result.entries[0]?.criterionId).toBe("VAL-REVIEW");
    });
  });

  test("deeply-nested charter dir round-trips narrativePath correctly", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c304";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Markdown companion probe",
        now: "2026-05-21T10:00:00.000Z",
        criteria: [{ id: "VAL-QA", title: "QA companion", verifier: "manual" }],
      });
      const runDir = join(dir, "work", "VAL-QA", "evidence", "2026-05-21T12-00-00-000Z");
      await writeJson(join(runDir, "evidence.json"), flatEvidence({ narrativePath: "qa.md" }));
      await writeFile(join(runDir, "qa.md"), "# nested\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, {
        charterId,
        evidenceFile: join(runDir, "evidence.json"),
      });
      expect(result.criterionId).toBe("VAL-QA");
    });
  });
});
