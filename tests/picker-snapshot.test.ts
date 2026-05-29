/**
 * VAL-PICKER-DATA-001..004 verifier: tests pin the data layer the picker
 * render (f5) consumes.
 *
 * Fixtures are seeded on disk under a tmpdir; we avoid using
 * `createCharterWorkspace` because that helper rewrites charter.md from a
 * template — we need precise control over H3 lines (Test 2) and over
 * arbitrary CharterStatus values (Test 3a).
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CharterStatus, LegacyCharterStatus } from "../src/domain/types";
import {
  buildPickerSnapshot,
  extractTitleFromH3,
  listAllCharters,
} from "../src/ui/picker-snapshot";

interface CharterFixture {
  charterId: string;
  name?: string;
  objective?: string;
  status: CharterStatus | LegacyCharterStatus;
  createdAt: string;
  completedAt?: string;
  terminatedAt?: string;
  charterMd?: string;
  criteriaMd?: string;
  criterionState?: Record<string, { outcome: "pass" | "fail" | "partial" }>;
  evidence?: Array<{
    workSegment?: string;
    file: string;
    criterionId: string;
    outcome: "pass" | "fail" | "partial";
    ts: string;
    recordedBy: string;
  }>;
  /** When true, do NOT write state.json (forces buildPickerSnapshot to return null). */
  omitState?: boolean;
}

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-picker-snap-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCharter(projectDir: string, f: CharterFixture): Promise<void> {
  const dir = join(projectDir, ".pi", "charters", f.charterId);
  await mkdir(dir, { recursive: true });

  if (!f.omitState) {
    const state: Record<string, unknown> = {
      charterId: f.charterId,
      name: f.name,
      objective: f.objective ?? `${f.charterId} objective`,
      status: f.status,
      createdAt: f.createdAt,
      updatedAt: f.createdAt,
    };
    if (f.completedAt) state.completedAt = f.completedAt;
    if (f.terminatedAt) state.terminatedAt = f.terminatedAt;
    await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  if (f.charterMd !== undefined) {
    await writeFile(join(dir, "charter.md"), f.charterMd, "utf8");
  } else {
    await writeFile(
      join(dir, "charter.md"),
      ["# Charter", "", "## Objective", "", f.objective ?? "n/a", ""].join("\n"),
      "utf8",
    );
  }

  if (f.criteriaMd !== undefined) {
    await writeFile(join(dir, "criteria.md"), f.criteriaMd, "utf8");
  }

  if (f.criterionState) {
    const criteria: Record<string, unknown> = {};
    for (const [id, rec] of Object.entries(f.criterionState)) {
      criteria[id] = {
        outcome: rec.outcome,
        lastEvidencePath: `work/_/evidence/${id}.json`,
        lastTs: f.createdAt,
        lastSummary: "seeded",
      };
    }
    await writeFile(
      join(dir, "criterion-state.json"),
      `${JSON.stringify({ charterId: f.charterId, criteria }, null, 2)}\n`,
      "utf8",
    );
  }

  for (const ev of f.evidence ?? []) {
    const workSegment = ev.workSegment ?? "_charter";
    const evidenceDir = join(dir, "work", workSegment, "evidence");
    await mkdir(evidenceDir, { recursive: true });
    const record = {
      charterId: f.charterId,
      criterionId: ev.criterionId,
      outcome: ev.outcome,
      summary: "seeded evidence",
      artifacts: [],
      details: {},
      source: "manual",
      recordedBy: ev.recordedBy,
      verifier: "manual",
      ts: ev.ts,
    };
    await writeFile(
      join(evidenceDir, ev.file),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

}

describe("buildPickerSnapshot", () => {
  test("assembles a full snapshot across all source files", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "snap-001";
      const criteriaMd = [
        "# Criteria",
        "",
        "## m1 First milestone",
        "",
        "### VAL-A First title",
        "Description: a.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-B Second title",
        "Description: b.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-C Third title",
        "Description: c.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-D Fourth title",
        "Description: d.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "## m2 Second milestone",
        "",
        "### VAL-E Fifth title",
        "Description: e.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-F Sixth title",
        "Description: f.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-G Seventh title",
        "Description: g.",
        "Verifier: manual",
        "Because: seeded",
        "",
      ].join("\n");

      await seedCharter(projectDir, {
        charterId,
        name: "snap",
        objective: "Drive feature X to done.",
        status: "active",
        createdAt: "2026-05-15T00:00:00.000Z",
        criteriaMd,
        criterionState: {
          "VAL-A": { outcome: "pass" },
          "VAL-B": { outcome: "pass" },
          "VAL-C": { outcome: "fail" },
          "VAL-D": { outcome: "partial" },
        },
        evidence: [
          { file: "VAL-A__1.json", criterionId: "VAL-A", outcome: "pass", ts: "2026-05-15T01:00:00.000Z", recordedBy: "agent:root" },
          { file: "VAL-B__1.json", criterionId: "VAL-B", outcome: "pass", ts: "2026-05-15T02:00:00.000Z", recordedBy: "agent:root" },
          { file: "VAL-C__1.json", criterionId: "VAL-C", outcome: "fail", ts: "2026-05-15T03:00:00.000Z", recordedBy: "agent:root" },
          { file: "VAL-D__1.json", criterionId: "VAL-D", outcome: "partial", ts: "2026-05-15T04:00:00.000Z", recordedBy: "agent:root" },
          { file: "VAL-E__1.json", criterionId: "VAL-E", outcome: "fail", ts: "2026-05-15T05:00:00.000Z", recordedBy: "agent:root" },
          { file: "VAL-F__1.json", criterionId: "VAL-F", outcome: "partial", ts: "2026-05-15T06:00:00.000Z", recordedBy: "agent:root" },
        ],
      });

      const snap = await buildPickerSnapshot(projectDir, charterId);
      expect(snap).not.toBeNull();
      if (!snap) return;

      expect(snap.charterId).toBe(charterId);
      expect(snap.header.name).toBe("snap");
      expect(snap.header.status).toBe("active");
      expect(snap.header.passCount).toBe(2);
      expect(snap.header.totalCount).toBe(7);
      expect(snap.objective).toBe("Drive feature X to done.");

      // 6 evidence records on disk → recentEvidence capped at 5, ts-desc.
      expect(snap.recentEvidence).toHaveLength(5);
      expect(snap.recentEvidence.map((r) => r.ts)).toEqual([
        "2026-05-15T06:00:00.000Z",
        "2026-05-15T05:00:00.000Z",
        "2026-05-15T04:00:00.000Z",
        "2026-05-15T03:00:00.000Z",
        "2026-05-15T02:00:00.000Z",
      ]);

      expect(snap.planTree.map((m) => m.milestoneId)).toEqual(["m1", "m2"]);
      const m1 = snap.planTree[0]!;
      expect(m1.features).toHaveLength(1);
      expect(m1.features[0]).toMatchObject({
        featureId: "m1",
        status: "in_progress",
        passCount: 2,
        totalCount: 4,
      });
      expect(m1.features[0].criteria).toEqual([
        { criterionId: "VAL-A", titleFromH3: "First title", outcome: "pass" },
        { criterionId: "VAL-B", titleFromH3: "Second title", outcome: "pass" },
        { criterionId: "VAL-C", titleFromH3: "Third title", outcome: "fail" },
        { criterionId: "VAL-D", titleFromH3: "Fourth title", outcome: "partial" },
      ]);
      const m2 = snap.planTree[1]!;
      expect(m2.features[0]).toMatchObject({
        featureId: "m2",
        status: "pending",
        passCount: 0,
        totalCount: 3,
      });
      expect(m2.features[0].criteria.find((c) => c.criterionId === "VAL-G")?.outcome).toBeNull();
    });
  });
});

describe("buildPickerSnapshot title source", () => {
  test("titleFromH3 reflects the raw H3 line, not parser fallback; extractTitleFromH3 unit cases", async () => {
    // Pure helper unit cases per spec.
    expect(extractTitleFromH3("### VAL-PRX-004 Error normalization")).toBe(
      "Error normalization",
    );
    expect(extractTitleFromH3("### VAL-X")).toBe("");
    expect(extractTitleFromH3("### VAL-Y   trimmed   ")).toBe("trimmed");

    await withTempProject(async (projectDir) => {
      const charterId = "snap-002";
      const criteriaMd = [
        "# Criteria",
        "",
        "## m1 Title milestone",
        "",
        "### VAL-A Title text",
        "Description: a.",
        "Verifier: manual",
        "Because: seeded",
        "",
        "### VAL-B",
        "Description: b.",
        "Verifier: manual",
        "Because: seeded",
        "",
      ].join("\n");

      await seedCharter(projectDir, {
        charterId,
        name: "snap2",
        status: "active",
        createdAt: "2026-05-15T00:00:00.000Z",
        criteriaMd,
      });

      const snap = await buildPickerSnapshot(projectDir, charterId);
      expect(snap).not.toBeNull();
      if (!snap) return;

      const criteria = snap.planTree[0]!.features[0]!.criteria;
      const a = criteria.find((c) => c.criterionId === "VAL-A")!;
      const b = criteria.find((c) => c.criterionId === "VAL-B")!;
      expect(a.titleFromH3).toBe("Title text");
      expect(b.titleFromH3).toBe("");
    });
  });
});

describe("listAllCharters ordering", () => {
  test("returns every charter ordered: non-terminal by createdAt desc, terminal by completedAt/terminatedAt desc", async () => {
    await withTempProject(async (projectDir) => {
      const seed = async (status: CharterStatus | LegacyCharterStatus, suffix: string, opts: { createdAt: string; completedAt?: string; terminatedAt?: string }) => {
        await seedCharter(projectDir, {
          charterId: `c-${suffix}`,
          name: suffix,
          status,
          createdAt: opts.createdAt,
          completedAt: opts.completedAt,
          terminatedAt: opts.terminatedAt,
        });
      };

      // 4 non-terminal — distinct createdAt; expected order is by createdAt desc.
      await seed("planning", "planning", { createdAt: "2026-05-10T00:00:00.000Z" });
      await seed("active", "active", { createdAt: "2026-05-13T00:00:00.000Z" });
      await seed("paused", "paused", { createdAt: "2026-05-11T00:00:00.000Z" });
      await seed("review", "review", { createdAt: "2026-05-12T00:00:00.000Z" });

      // 3 terminal — abandoned + budget_limited omit completedAt and use
      // terminatedAt instead. Terminal sort key prefers completedAt, falls
      // back to terminatedAt, falls back to createdAt.
      await seed("completed", "completed", {
        createdAt: "2026-05-01T00:00:00.000Z",
        completedAt: "2026-05-15T03:00:00.000Z",
      });
      await seed("abandoned", "abandoned", {
        createdAt: "2026-05-02T00:00:00.000Z",
        terminatedAt: "2026-05-15T02:00:00.000Z",
      });
      await seed("budget_limited", "budget", {
        createdAt: "2026-05-03T00:00:00.000Z",
        terminatedAt: "2026-05-15T01:00:00.000Z",
      });

      const rows = await listAllCharters(projectDir);
      expect(rows.map((r) => r.charterId)).toEqual([
        "c-active", // createdAt 05-13
        "c-review", // 05-12
        "c-paused", // 05-11
        "c-planning", // 05-10
        "c-completed", // completedAt 05-15T03
        "c-abandoned", // terminatedAt 05-15T02
        "c-budget", // terminatedAt 05-15T01
      ]);
    });
  });

  test("caps the terminal block at 10 (drops the 2 oldest-completedAt)", async () => {
    await withTempProject(async (projectDir) => {
      // 2 active charters with distinct createdAt.
      await seedCharter(projectDir, {
        charterId: "c-active-a",
        name: "active-a",
        status: "active",
        createdAt: "2026-05-14T00:00:00.000Z",
      });
      await seedCharter(projectDir, {
        charterId: "c-active-b",
        name: "active-b",
        status: "active",
        createdAt: "2026-05-13T00:00:00.000Z",
      });

      // 12 completed charters with strictly increasing completedAt timestamps.
      // The cap should drop the 2 OLDEST-completedAt charters (c-done-01, c-done-02).
      for (let i = 1; i <= 12; i++) {
        const idx = String(i).padStart(2, "0");
        await seedCharter(projectDir, {
          charterId: `c-done-${idx}`,
          name: `done-${idx}`,
          status: "completed",
          createdAt: "2026-05-01T00:00:00.000Z",
          completedAt: `2026-05-15T${idx}:00:00.000Z`,
        });
      }

      const rows = await listAllCharters(projectDir);
      expect(rows).toHaveLength(12); // 2 active + 10 terminal (capped)

      const ids = rows.map((r) => r.charterId);
      // 2 active first.
      expect(ids.slice(0, 2)).toEqual(["c-active-a", "c-active-b"]);
      // 10 newest-completedAt: c-done-12 .. c-done-03.
      expect(ids.slice(2)).toEqual([
        "c-done-12",
        "c-done-11",
        "c-done-10",
        "c-done-09",
        "c-done-08",
        "c-done-07",
        "c-done-06",
        "c-done-05",
        "c-done-04",
        "c-done-03",
      ]);
      // The 2 oldest-completedAt are dropped.
      expect(ids).not.toContain("c-done-01");
      expect(ids).not.toContain("c-done-02");
    });
  });
});

describe("corruption handling", () => {
  test("listAllCharters skips charter with missing state.json; buildPickerSnapshot returns null", async () => {
    await withTempProject(async (projectDir) => {
      await seedCharter(projectDir, {
        charterId: "c-good-a",
        name: "good-a",
        status: "active",
        createdAt: "2026-05-13T00:00:00.000Z",
      });
      await seedCharter(projectDir, {
        charterId: "c-good-b",
        name: "good-b",
        status: "active",
        createdAt: "2026-05-12T00:00:00.000Z",
      });
      // Corrupt: state.json missing.
      await seedCharter(projectDir, {
        charterId: "c-corrupt",
        status: "active",
        createdAt: "2026-05-14T00:00:00.000Z",
        omitState: true,
      });

      const rows = await listAllCharters(projectDir);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.charterId).sort()).toEqual(["c-good-a", "c-good-b"]);

      const snap = await buildPickerSnapshot(projectDir, "c-corrupt");
      expect(snap).toBeNull();
    });
  });
});
