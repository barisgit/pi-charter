import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyCriterion } from "../src/application/record-service";
import type { EvidenceFile } from "../src/domain/evidence-schemas";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-evidence-exists-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FEATURE_ID = "f-evidence-exists";
const CRITERION_ID = "VAL-EVIDENCE-EXISTS";

function stamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

async function writeEvidenceRecord(
  dir: string,
  options: { kind: "command" | "review" | "qa" | "readiness"; ts: string; layout?: "dir" | "legacy" },
): Promise<string> {
  const layout = options.layout ?? "dir";
  const relativePath = layout === "dir"
    ? join("work", FEATURE_ID, "evidence", stamp(options.ts), "evidence.json")
    : join("work", FEATURE_ID, "evidence", `${CRITERION_ID}__${stamp(options.ts)}.json`);
  const source = options.kind === "command" ? "verifier" : "subagent";
  const record = {
    criterionId: CRITERION_ID,
    featureId: FEATURE_ID,
    outcome: "pass",
    summary: `${options.kind} evidence`,
    source,
    recordedBy: source === "subagent" ? "subagent:review:stub-session" : "agent:root",
    ts: options.ts,
    details: { evidenceKind: options.kind },
  };
  await mkdir(dirname(join(dir, relativePath)), { recursive: true });
  await writeFile(join(dir, relativePath), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return relativePath;
}

describe("evidence-exists verifier dispatch", () => {
  test("evidence-exists verifier kind passes when matching evidence is present", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e501";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence-exists verifier probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [{
          id: CRITERION_ID,
          title: "Evidence exists",
          verifier: "evidence-exists",
          evidenceKind: "review",
          command: "sh -c 'exit 97'",
        }],
      });
      const evidencePath = await writeEvidenceRecord(dir, {
        kind: "review",
        ts: "2026-05-21T12:00:00.000Z",
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-21T12:30:00.000Z",
      });

      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.command).toBe("evidence-exists:review");
      expect(result.stdout).toContain(evidencePath);
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.details.matchingRecords).toHaveLength(1);
      expect(stored.source).toBe("verifier");
    });
  });

  test("evidence-exists verifier kind fails when no evidence", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e502";
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence-exists verifier probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [{
          id: CRITERION_ID,
          title: "Evidence exists",
          verifier: "evidence-exists",
          evidenceKind: "review",
        }],
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-21T12:30:00.000Z",
      });

      expect(result.outcome).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No review evidence found");
    });
  });

  test("evidence-exists with freshSince filters stale evidence", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e503";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence-exists verifier probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [{
          id: CRITERION_ID,
          title: "Evidence exists",
          verifier: "evidence-exists",
          evidenceKind: "review",
          freshSince: "2026-05-21T12:00:00.000Z",
        }],
      });
      await writeEvidenceRecord(dir, { kind: "review", ts: "2026-05-21T11:59:59.000Z" });

      const staleResult = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-21T12:30:00.000Z",
      });
      expect(staleResult.outcome).toBe("fail");

      const freshPath = await writeEvidenceRecord(dir, { kind: "review", ts: "2026-05-21T12:00:00.000Z" });
      const freshResult = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-21T12:31:00.000Z",
      });

      expect(freshResult.outcome).toBe("pass");
      expect(freshResult.stdout).toContain(freshPath);
    });
  });

  test("evidence-exists rejects wrong evidenceKind", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e505";
      const dir = await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Evidence-exists verifier probe",
        now: "2026-05-21T09:00:00.000Z",
        criteria: [{
          id: CRITERION_ID,
          title: "Evidence exists",
          verifier: "evidence-exists",
          evidenceKind: "review",
        }],
      });
      await writeEvidenceRecord(dir, { kind: "qa", ts: "2026-05-21T12:00:00.000Z" });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-21T12:30:00.000Z",
      });

      expect(result.outcome).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No review evidence found");
    });
  });
});
