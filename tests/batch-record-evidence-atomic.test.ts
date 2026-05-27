import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidenceBatch } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";

// VAL-7: per-call atomicity of criterion-state.json + per-entry evidence files.
//
// Approach: spyOn fs/promises.rename — the atomic-commit step used by
// store.ts:writeTextAtomicUnsafe — and count renames by final destination
// path. Rename is the on-disk observation of "how many atomic writes
// landed for each file", which is precisely what VAL-7 measures.

import * as fsPromises from "node:fs/promises";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-batch-evidence-atomic-"));
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
    objective: "Atomic batch probe",
    charterId,
    now: "2026-05-15T02:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Atomic batch probe.",
      "",
      "## Criteria",
      "",
      "### VAL-A — A",
      "Description: A.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-B — B",
      "Description: B.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-C — C",
      "Description: C.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-D — D",
      "Description: D.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-E — E",
      "Description: E.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  // Two features, each fulfills part of the charter. Splitting entries 3/2
  // across f1/f2 lets us assert per-feature feature-state.json write counts.
  await writeFile(
    join(dir, "plan", "f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-A\n  - VAL-B\n  - VAL-C\npreconditions: []\n---\n\n# F1\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await writeFile(
    join(dir, "plan", "f2.md"),
    `---\nid: f2\nmilestone: m1\norder: 2\nfulfills:\n  - VAL-D\n  - VAL-E\npreconditions: []\n---\n\n# F2\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z" });
  return dir;
}

interface RenameCounter {
  total: number;
  byDest: Map<string, number>;
  restore: () => void;
}

function installRenameCounter(): RenameCounter {
  const counter: RenameCounter = {
    total: 0,
    byDest: new Map<string, number>(),
    restore: () => {},
  };
  const original = fsPromises.rename.bind(fsPromises);
  const spy = spyOn(fsPromises, "rename").mockImplementation((async (oldPath: unknown, newPath: unknown) => {
    counter.total += 1;
    const key = typeof newPath === "string" ? newPath : String(newPath);
    counter.byDest.set(key, (counter.byDest.get(key) ?? 0) + 1);
    return original(oldPath as Parameters<typeof fsPromises.rename>[0], newPath as Parameters<typeof fsPromises.rename>[1]);
  }) as unknown as typeof fsPromises.rename);
  counter.restore = () => {
    spy.mockRestore();
  };
  return counter;
}

function countMatching(counter: RenameCounter, predicate: (path: string) => boolean): number {
  let total = 0;
  for (const [path, count] of counter.byDest) {
    if (predicate(path)) total += count;
  }
  return total;
}

describe("recordEvidenceBatch — VAL-7 single criterion-state write", () => {
  let installed: RenameCounter | undefined;
  afterEach(() => {
    installed?.restore();
    installed = undefined;
  });

  test("5 entries in ONE batch produce exactly ONE criterion-state.json write", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-0000000000b1";
      const dir = await makeActiveCharter(projectDir, charterId);

      // Install the counter AFTER setup so charter/plan writes don't pollute.
      installed = installRenameCounter();

      await recordEvidenceBatch(projectDir, {
        charterId,
        now: "2026-05-15T03:00:00.000Z",
        entries: [
          { criterionId: "VAL-A", featureId: "f1", outcome: "pass", summary: "A", because: "ra" },
          { criterionId: "VAL-B", featureId: "f1", outcome: "pass", summary: "B", because: "rb" },
          { criterionId: "VAL-C", featureId: "f1", outcome: "pass", summary: "C", because: "rc" },
          { criterionId: "VAL-D", featureId: "f2", outcome: "pass", summary: "D", because: "rd" },
          { criterionId: "VAL-E", featureId: "f2", outcome: "pass", summary: "E", because: "re" },
        ],
      });

      const criterionStatePath = join(dir, "criterion-state.json");
      const criterionStateWrites = installed.byDest.get(criterionStatePath) ?? 0;
      expect(criterionStateWrites).toBe(1);

      // Per-entry evidence files: each entry produces its own
      // work/<featureId>/evidence/<ts>/evidence.json file — assert 5 total.
      const evidenceWrites = countMatching(installed, (path) => /\/work\/.+\/evidence\/[^/]+\/evidence\.json$/.test(path));
      expect(evidenceWrites).toBe(5);

      // feature-state.json: at most one write per unique featureId completed
      // (f1 fulfills A/B/C — all pass → completion projection writes;
      // f2 fulfills D/E — all pass → completion projection writes). With 2
      // unique featureIds in the batch the projection runs at most twice.
      const featureStatePath = join(dir, "feature-state.json");
      const featureStateWrites = installed.byDest.get(featureStatePath) ?? 0;
      expect(featureStateWrites).toBeLessThanOrEqual(2);
      // Both features complete in this batch (every fulfilled criterion is
      // pass), so the projection should land exactly two writes here.
      expect(featureStateWrites).toBe(2);
    });
  });
});
