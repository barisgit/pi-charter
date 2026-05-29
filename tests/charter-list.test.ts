import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  charterDir,
  chartersRoot,
  createCharterWorkspace,
  loadCharterState,
  writeCharterState,
  writeJsonAtomic,
} from "../src/infrastructure/store";
import type { CharterStatus, LegacyCharterStatus } from "../src/domain/types";
import { listActiveCharters } from "../src/application/service";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-list-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed a charter and force its state.json to a particular status. */
async function seedCharter(
  projectDir: string,
  opts: {
    suffix: string;
    name?: string;
    objective: string;
    status: CharterStatus | LegacyCharterStatus;
    /** When true, charter.md is rewritten to contain `count` VAL criteria. */
    criteriaCount?: number;
    /** When provided, force this many criterion outcomes to `pass`. */
    passCount?: number;
  },
): Promise<string> {
  const charterId = `00000000-0000-4000-8000-0000000000${opts.suffix.padStart(2, "0")}`;
  const now = "2026-05-15T00:00:00.000Z";
  const created = await createCharterWorkspace(projectDir, {
    charterId,
    name: opts.name,
    objective: opts.objective,
    now,
  });
  if (opts.status !== "active") {
    const state = await loadCharterState(created.charterDir);
    await writeJsonAtomic(join(created.charterDir, "state.json"), { ...state, status: opts.status, updatedAt: now });
  }
  if (opts.criteriaCount !== undefined) {
    const ids = Array.from({ length: opts.criteriaCount }, (_, i) => `VAL-${i + 1}`);
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      opts.objective,
      "",
      "## Criteria",
      "",
      ...ids.flatMap((id) => [
        `### ${id} ${id} title`,
        "Description: probe.",
        "Verifier: manual",
        "Fresh evidence required: false",
        "",
      ]),
    ].join("\n");
    await writeFile(join(created.charterDir, "charter.md"), md, "utf8");
  }
  if (opts.passCount !== undefined && opts.passCount > 0) {
    const criteria: Record<string, unknown> = {};
    for (let i = 0; i < opts.passCount; i++) {
      criteria[`VAL-${i + 1}`] = {
        outcome: "pass",
        lastEvidencePath: `work/_charter/evidence/VAL-${i + 1}.json`,
        lastTs: now,
        lastSummary: "seeded pass",
      };
    }
    await writeJsonAtomic(join(created.charterDir, "criterion-state.json"), {
      charterId,
      criteria,
    });
  }
  return charterId;
}

describe("listActiveCharters", () => {
  test("returns [] when the project has no index.json", async () => {
    await withTempProject(async (projectDir) => {
      expect(await listActiveCharters(projectDir)).toEqual([]);
    });
  });

  test("returns one entry per non-terminal charter, filters by live state.status, drops corrupt entries", async () => {
    await withTempProject(async (projectDir) => {
      // 4 non-terminal statuses, each with a small criteria/pass setup.
      const planningId = await seedCharter(projectDir, {
        suffix: "01",
        name: "planner",
        objective: "planning charter",
        status: "planning",
        criteriaCount: 3,
        passCount: 0,
      });
      const activeId = await seedCharter(projectDir, {
        suffix: "02",
        name: "active-one",
        objective: "active charter",
        status: "active",
        criteriaCount: 4,
        passCount: 2,
      });
      const reviewId = await seedCharter(projectDir, {
        suffix: "03",
        // intentionally no name to exercise the slice fallback
        objective: "review charter",
        status: "review",
        criteriaCount: 2,
        passCount: 1,
      });
      const pausedId = await seedCharter(projectDir, {
        suffix: "04",
        name: "paused-one",
        objective: "paused charter",
        status: "paused",
        criteriaCount: 5,
        passCount: 5,
      });

      // Terminal charter (must be excluded).
      await seedCharter(projectDir, {
        suffix: "05",
        name: "done",
        objective: "completed charter",
        status: "completed",
        criteriaCount: 1,
        passCount: 1,
      });

      // Corrupt charter: state.json deleted after creation.
      const corruptId = await seedCharter(projectDir, {
        suffix: "06",
        name: "corrupt",
        objective: "corrupt charter",
        status: "active",
      });
      await unlink(join(charterDir(projectDir, corruptId), "state.json"));

      // Stale-index case: index.json says "active" but state.json says "completed".
      const staleId = await seedCharter(projectDir, {
        suffix: "07",
        name: "stale",
        objective: "stale index charter",
        status: "active", // index.json was written with this on createCharterWorkspace
      });
      // Flip state.json to completed, then hand-edit the index so it claims
      // `active` for this id — the exact stale-index regression the charter
      // spec calls out: writeCharterState never updates the index, so the
      // index `status` field can drift arbitrarily. listActiveCharters must
      // trust state.status, not the index.
      const staleState = await loadCharterState(charterDir(projectDir, staleId));
      staleState.status = "completed";
      await writeCharterState(charterDir(projectDir, staleId), staleState);
      const indexPath = join(chartersRoot(projectDir), "index.json");
      const indexParsed = JSON.parse(await readFile(indexPath, "utf8")) as {
        charters: Array<{ charterId: string; status: string } & Record<string, unknown>>;
      };
      for (const row of indexParsed.charters) {
        if (row.charterId === staleId) row.status = "active";
      }
      await writeJsonAtomic(indexPath, indexParsed);

      // Sanity: the on-disk index now lies about the stale charter.
      const indexRaw = await readFile(indexPath, "utf8");
      expect(indexRaw).toContain(`"charterId": "${staleId}"`);
      expect(indexRaw).toMatch(/"charterId":\s*"00000000-0000-4000-8000-000000000007"[\s\S]*?"status":\s*"active"/);

      const rows = await listActiveCharters(projectDir);
      const ids = rows.map((r) => r.charterId).sort();
      expect(ids).toEqual([planningId, activeId, reviewId, pausedId].sort());
      expect(rows.find((r) => r.charterId === staleId)).toBeUndefined();
      expect(rows.find((r) => r.charterId === corruptId)).toBeUndefined();

      const planning = rows.find((r) => r.charterId === planningId)!;
      expect(planning).toEqual({
        charterId: planningId,
        name: "planner",
        objective: "planning charter",
        status: "active",
        createdAt: "2026-05-15T00:00:00.000Z",
        passCount: 0,
        totalCount: 3,
      });

      const active = rows.find((r) => r.charterId === activeId)!;
      expect(active).toMatchObject({
        name: "active-one",
        status: "active",
        passCount: 2,
        totalCount: 4,
      });

      // name fallback: state.name unset → charterId.slice(0,8).
      const review = rows.find((r) => r.charterId === reviewId)!;
      expect(review.name).toBe(reviewId.slice(0, 8));
      expect(review).toMatchObject({ status: "active", passCount: 1, totalCount: 2 });

      const paused = rows.find((r) => r.charterId === pausedId)!;
      expect(paused).toMatchObject({ status: "paused", passCount: 5, totalCount: 5 });
    });
  });
});
