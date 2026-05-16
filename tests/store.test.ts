import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, createCharterWorkspace, loadCharterState } from "../src/infrastructure/store";
import { parseCharterMarkdown, renderInitialCharterMarkdown } from "../src/domain/charter-md";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("charter filesystem store", () => {
  test("createCharterWorkspace creates the project-local charter skeleton", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharterWorkspace(projectDir, {
        charterId: "00000000-0000-4000-8000-000000000001",
        objective: "Implement OAuth callback handling",
        now: "2026-05-15T00:00:00.000Z",
      });

      expect(created.charterId).toBe("00000000-0000-4000-8000-000000000001");
      expect(created.state.status).toBe("planning");
      expect(created.state.objective).toBe("Implement OAuth callback handling");
      expect(created.charterDir).toBe(join(projectDir, ".pi", "charters", created.charterId));

      const reloaded = await loadCharterState(created.charterDir);
      expect(reloaded.objective).toBe("Implement OAuth callback handling");
      expect(reloaded.status).toBe("planning");

      const charterMd = await readFile(join(created.charterDir, "charter.md"), "utf8");
      expect(charterMd).toContain("## Objective");
      expect(charterMd).toContain("Implement OAuth callback handling");

      const events = await readFile(join(created.charterDir, "events.jsonl"), "utf8");
      expect(events).toContain("charter_created");

      const index = await readFile(join(projectDir, ".pi", "charters", "index.json"), "utf8");
      expect(index).toContain(created.charterId);
    });
  });
});

describe("appendEvent concurrency", () => {
  test("parallel appendEvent calls preserve every event without ENOENT", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharterWorkspace(projectDir, {
        charterId: "00000000-0000-4000-8000-000000000099",
        objective: "concurrency probe",
        now: "2026-05-15T00:00:00.000Z",
      });
      const dir = created.charterDir;
      // 12 parallel appends — mirrors the dogfood case of 6 charter_plan add_feature
      // calls racing on events.jsonl tmp-rename and read-modify-write.
      const events = Array.from({ length: 12 }, (_, i) => ({
        type: "feature_added" as const,
        ts: `2026-05-15T00:00:00.${String(i).padStart(3, "0")}Z`,
        charterId: created.charterId,
        featureId: `f${i}`,
        milestone: "m1",
        fulfills: ["VAL-1"],
      }));
      await Promise.all(events.map((e) => appendEvent(dir, e)));
      const raw = await readFile(join(dir, "events.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      // 1 charter_created + 12 feature_added
      expect(lines).toHaveLength(13);
      const featureIds = lines
        .map((line) => JSON.parse(line))
        .filter((e) => e.type === "feature_added")
        .map((e) => e.featureId)
        .sort();
      expect(featureIds).toEqual(events.map((e) => e.featureId).sort());
    });
  });
});

describe("renderInitialCharterMarkdown", () => {
  test("initial template parses cleanly and surfaces the example criterion", () => {
    const md = renderInitialCharterMarkdown("Probe objective");
    const parsed = parseCharterMarkdown(md);
    expect(parsed.objective).toBe("Probe objective");
    // The worked example must round-trip so agents can copy its shape.
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0]).toMatchObject({
      id: "VAL-EXAMPLE",
      verifier: "manual",
      requireFreshEvidence: false,
    });
  });
});

describe("charter.md parser", () => {
  test("parseCharterMarkdown extracts objective, criteria, and constraints", () => {
    const parsed = parseCharterMarkdown(`# Charter: OAuth callback\n\n## Objective\n\nImplement OAuth callback handling.\n\n## Criteria\n\n### VAL-AUTH-001 — Callback validates state\n\nDescription: Invalid state is rejected.\nVerifier: command\nFresh evidence required: true\nReview subagent required: false\n\n### VAL-AUTH-002 — Tokens are persisted\n\nDescription: Successful callback stores provider tokens.\nVerifier: manual\n\n## Scope and constraints\n\n- Do not change provider configuration.\n- Keep existing sessions valid.\n`);

    expect(parsed.objective).toBe("Implement OAuth callback handling.");
    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.criteria[0]).toMatchObject({
      id: "VAL-AUTH-001",
      title: "Callback validates state",
      verifier: "command",
      requireFreshEvidence: true,
      requireReviewSubagent: false,
    });
    expect(parsed.criteria[1]).toMatchObject({
      id: "VAL-AUTH-002",
      title: "Tokens are persisted",
      verifier: "manual",
    });
    expect(parsed.constraints).toEqual([
      "Do not change provider configuration.",
      "Keep existing sessions valid.",
    ]);
  });
});
