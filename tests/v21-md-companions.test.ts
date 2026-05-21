import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidenceFromFile } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-v21-md-companions-"));
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

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Markdown companion probe",
    charterId,
    now: "2026-05-21T10:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Markdown companion probe.",
      "",
      "## Criteria",
      "",
      "### VAL-QA — QA companion",
      "Description: QA evidence records a markdown companion.",
      "Verifier: manual",
      "",
      "### VAL-REVIEW — Review companion",
      "Description: Review evidence records a markdown companion.",
      "Verifier: manual",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"Markdown companion fixture. ".repeat(12)}\n`, "utf8");
  await writeFeature(dir, "f-qa", "VAL-QA");
  await writeFeature(dir, "f-review", "VAL-REVIEW");
  await lockPlan(projectDir, { charterId, now: "2026-05-21T10:10:00.000Z", legacy: true });
  return dir;
}

async function writeFeature(dir: string, featureId: string, criterionId: string): Promise<void> {
  await writeFile(
    join(dir, "plan", `${featureId}.md`),
    `---\nid: ${featureId}\nmilestone: m1\norder: 1\nfulfills:\n  - ${criterionId}\npreconditions: []\n---\n\n# ${featureId}\n\n${VALIDATION_MD}`,
    "utf8",
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function qaEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "qa",
    featureId: "f-qa",
    milestone: "m1",
    surfaces: ["charter_record evidenceFile"],
    outcome: "pass",
    artifacts: [],
    findings: [],
    summary: "QA passed with markdown narrative.",
    because: "The QA evidence imports a human-readable markdown companion.",
    ...overrides,
  };
}

function reviewEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "review",
    featureId: "f-review",
    round: 1,
    reviewedAt: "2026-05-21T11:05:00.000Z",
    subagentSessionId: "review-session-md",
    outcome: "pass",
    blockingIssues: [],
    nonBlockingNotes: [],
    summary: "Review passed with markdown narrative.",
    because: "The review evidence imports a human-readable markdown companion.",
    ...overrides,
  };
}

describe("v2.1 markdown evidence companions", () => {
  test("evidence record accepts relative narrativePath", () => {
    const result = validateEvidenceFile(qaEvidence({ narrativePath: "qa.md" }));

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "qa") expect(result.value.narrativePath).toBe("qa.md");
  });

  test("evidence record rejects absolute narrativePath", () => {
    const result = validateEvidenceFile(qaEvidence({ narrativePath: "/tmp/qa.md" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("narrativePath must be relative");
  });

  test("evidence record rejects narrativePath outside run dir", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c301";
      const dir = await makeActiveCharter(projectDir, charterId);
      const runDir = join(dir, "work", "f-qa", "evidence", "outside-run");
      await writeJson(join(runDir, "qa.json"), qaEvidence({ narrativePath: "../qa.md" }));
      await writeFile(join(dir, "work", "f-qa", "evidence", "qa.md"), "# outside\n", "utf8");

      let err: any;
      try {
        await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: join(runDir, "qa.json") });
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
      const dir = await makeActiveCharter(projectDir, charterId);
      const runDir = join(dir, "work", "f-qa", "evidence", "qa-run");
      await writeJson(join(runDir, "qa.json"), qaEvidence());
      await writeFile(join(runDir, "qa.md"), "# QA narrative\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: join(runDir, "qa.json") });

      expect(result.entries[0]!.path).toBe(join("work", "f-qa", "evidence", "qa-run", "evidence.json"));
      expect(await readFile(join(runDir, "qa.md"), "utf8")).toBe("# QA narrative\n");
      const stored = JSON.parse(await readFile(join(dir, result.entries[0]!.path), "utf8"));
      expect(stored.narrativePath).toBe("qa.md");
      expect(stored.details.typedEvidence.narrativePath).toBe("qa.md");
    });
  });

  test("review.md companion lands next to evidence.json in dir-per-run", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000c303";
      const dir = await makeActiveCharter(projectDir, charterId);
      const runDir = join(dir, "work", "f-review", "evidence", "review-run");
      await writeJson(join(runDir, "review.json"), reviewEvidence());
      await writeFile(join(runDir, "review.md"), "# Review narrative\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: join(runDir, "review.md") });

      expect(result.entries[0]!.path).toBe(join("work", "f-review", "evidence", "review-run", "evidence.json"));
      expect(await readFile(join(runDir, "review.md"), "utf8")).toBe("# Review narrative\n");
      const stored = JSON.parse(await readFile(join(dir, result.entries[0]!.path), "utf8"));
      expect(stored.narrativePath).toBe("review.md");
      expect(stored.recordedBy).toBe("subagent:charter-reviewer:review-session-md");
    });
  });

  test("deeply-nested charter dir round-trips narrativePath correctly", async () => {
    await withTempProject(async (rootDir) => {
      const projectDir = join(rootDir, "deep", "nested", "project");
      await mkdir(projectDir, { recursive: true });
      const charterId = "00000000-0000-4000-8000-00000000c304";
      const dir = await makeActiveCharter(projectDir, charterId);
      const runDir = join(dir, "work", "f-qa", "evidence", "deep-run");
      await writeJson(join(runDir, "qa.json"), qaEvidence({ narrativePath: "qa.md" }));
      await writeFile(join(runDir, "qa.md"), "# Deep QA narrative\n", "utf8");

      const result = await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: join(runDir, "qa.json") });

      expect(result.entries[0]!.path).toBe(join("work", "f-qa", "evidence", "deep-run", "evidence.json"));
      const stored = JSON.parse(await readFile(join(dir, result.entries[0]!.path), "utf8"));
      expect(stored.narrativePath).toBe("qa.md");
      expect(stored.details.typedEvidence.narrativePath).toBe("qa.md");
    });
  });
});
