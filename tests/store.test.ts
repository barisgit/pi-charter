import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, createCharterWorkspace, loadCharterState, loadParsedCharter } from "../src/infrastructure/store";
import { parseCharterMarkdown, renderInitialCharterMarkdown, renderInitialCriteriaMarkdown } from "../src/domain/charter-md";

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
      expect(created.state.status).toBe("active");
      expect(created.state.objective).toBe("Implement OAuth callback handling");
      expect(created.charterDir).toBe(join(projectDir, ".pi", "charters", created.charterId));

      const reloaded = await loadCharterState(created.charterDir);
      expect(reloaded.objective).toBe("Implement OAuth callback handling");
      expect(reloaded.status).toBe("active");

      const charterMd = await readFile(join(created.charterDir, "charter.md"), "utf8");
      expect(charterMd).toContain("## Objective");
      expect(charterMd).toContain("Implement OAuth callback handling");
      expect(charterMd).toContain("## Mission Boundaries (NEVER VIOLATE)");
      expect(charterMd).toContain("## Commands");
      expect(charterMd).not.toContain("## Criteria");

      const criteriaMd = await readFile(join(created.charterDir, "criteria.md"), "utf8");
      expect(criteriaMd).toContain("# Criteria for Untitled");
      expect(criteriaMd).toContain("## m0-example");
      expect(criteriaMd).toContain("### VAL-EXAMPLE");

      const { existsSync } = await import("node:fs");
      expect(existsSync(join(created.charterDir, "work"))).toBe(true);
      expect(existsSync(join(created.charterDir, "plan"))).toBe(false);
      expect(existsSync(join(created.charterDir, "plan.json"))).toBe(false);
      expect(existsSync(join(created.charterDir, "feature-state.json"))).toBe(false);
      expect(existsSync(join(created.charterDir, "qa-briefs"))).toBe(false);

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
  test("initial split templates parse cleanly and surface the example criterion", () => {
    const md = renderInitialCharterMarkdown("Probe objective", "probe-charter");
    const criteriaMd = renderInitialCriteriaMarkdown("probe-charter");
    const parsed = parseCharterMarkdown(md, { criteriaMarkdown: criteriaMd });
    expect(parsed.objective).toBe("Probe objective");
    expect(parsed.commands).toEqual({
      lint: "<e.g. bun run lint>",
      test: "<e.g. bun test>",
      typecheck: "<e.g. bun run check-types>",
    });
    // The worked example must round-trip so agents can copy its shape.
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.milestones).toHaveLength(1);
    expect(parsed.milestones[0]?.id).toBe("m0-example");
    expect(parsed.criteria[0]).toMatchObject({
      id: "VAL-EXAMPLE",
      verifier: "command",
      requireFreshEvidence: false,
      requireReviewSubagent: false,
    });
  });
});

describe("loadParsedCharter", () => {
  test("prefers sibling criteria.md over legacy charter.md Criteria section", async () => {
    await withTempProject(async (projectDir) => {
      const dir = projectDir;
      await writeFile(join(dir, "charter.md"), [
        "# Charter",
        "",
        "## Objective",
        "",
        "Split criteria probe.",
        "",
        "## Criteria",
        "",
        "### VAL-OLD — Old inline criterion",
        "Description: This should be ignored when criteria.md exists.",
        "Verifier: command",
        "Command: echo old",
        "",
        "## Scope and constraints",
        "",
        "- Keep old layout readable.",
      ].join("\n"));
      await writeFile(join(dir, "criteria.md"), [
        "# Criteria for split probe",
        "",
        "## VAL-NEW New split criterion",
        "Split criteria.md assertions are authoritative.",
        "",
        "Verifier: command",
        "Command: echo new",
        "RequireFreshEvidence: true",
        "RequireReviewSubagent: false",
      ].join("\n"));

      const parsed = await loadParsedCharter(dir);
      expect(parsed.criteria.map((criterion) => criterion.id)).toEqual(["VAL-NEW"]);
      expect(parsed.criteria[0]).toMatchObject({
        title: "New split criterion",
        description: "Split criteria.md assertions are authoritative.",
        command: "echo new",
        requireFreshEvidence: true,
        requireReviewSubagent: false,
      });
    });
  });

  test("falls back to charter.md Criteria when criteria.md is absent", async () => {
    await withTempProject(async (projectDir) => {
      const dir = projectDir;
      await writeFile(join(dir, "charter.md"), `# Charter\n\n## Objective\n\nLegacy single-file probe.\n\n## Criteria\n\n### VAL-LEGACY — Legacy criterion\nDescription: Legacy criteria remain readable.\nVerifier: command\nCommand: echo legacy\n`);

      const parsed = await loadParsedCharter(dir);
      expect(parsed.criteria).toHaveLength(1);
      expect(parsed.criteria[0]).toMatchObject({
        id: "VAL-LEGACY",
        title: "Legacy criterion",
        description: "Legacy criteria remain readable.",
        command: "echo legacy",
      });
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
