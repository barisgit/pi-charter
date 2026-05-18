import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createCharterWorkspace } from "../src/infrastructure/store";

describe("concurrent appendEvent", () => {
  test("parallel appendEvent calls preserve the initial line plus every appended line", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-concurrent-events-"));
    try {
      const created = await createCharterWorkspace(projectDir, {
        charterId: "cha-concurrent-events",
        objective: "Concurrent events probe",
        now: "2026-05-15T00:00:00.000Z",
      });
      const n = 30;

      await Promise.all(Array.from({ length: n }, (_, index) => appendEvent(created.charterDir, {
        type: "feature_added",
        ts: `2026-05-15T00:01:${String(index).padStart(2, "0")}.000Z`,
        charterId: created.charterId,
        featureId: `f${index}`,
        milestone: "m1",
        fulfills: ["VAL-EVENTS"],
      })));

      const lines = (await readFile(join(created.charterDir, "events.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(n + 1);
      expect(lines.filter((line) => JSON.parse(line).type === "feature_added")).toHaveLength(n);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
