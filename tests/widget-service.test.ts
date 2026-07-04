import { describe, expect, test } from "bun:test";
import { RunningSubagentRegistry } from "../src/ui/widget-service";

describe("RunningSubagentRegistry.forCharter", () => {
  test("filters live subagents by charterId; returns [] for unknown ids", () => {
    const reg = new RunningSubagentRegistry();
    reg.start({
      runId: "r1",
      charterId: "A",
      agent: "fixer",
      metadata: { "pi-charter.featureId": "f1" },
      startedAt: "2026-05-15T10:00:00.000Z",
    });
    reg.start({
      runId: "r2",
      charterId: "A",
      agent: "charter-reviewer",
      metadata: { "pi-charter.criterionId": "C1" },
      startedAt: "2026-05-15T10:00:01.000Z",
    });
    reg.start({
      runId: "r3",
      charterId: "B",
      agent: "fixer",
      metadata: { "pi-charter.featureId": "f2" },
      startedAt: "2026-05-15T10:00:02.000Z",
    });

    const a = reg.forCharter("A");
    expect(a).toHaveLength(2);
    expect(a.map((r) => r.runId).sort()).toEqual(["r1", "r2"]);
    for (const sub of a) expect(sub.charterId).toBe("A");

    const b = reg.forCharter("B");
    expect(b).toHaveLength(1);
    expect(b[0]?.runId).toBe("r3");

    expect(reg.forCharter("Z")).toEqual([]);
  });

  test("complete drops the entry from forCharter results", () => {
    const reg = new RunningSubagentRegistry();
    reg.start({ runId: "r1", charterId: "A", agent: "fixer", startedAt: "2026-05-15T10:00:00.000Z" });
    reg.start({ runId: "r2", charterId: "A", agent: "fixer", startedAt: "2026-05-15T10:00:01.000Z" });
    expect(reg.forCharter("A")).toHaveLength(2);
    reg.complete("r1");
    const remaining = reg.forCharter("A");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.runId).toBe("r2");
  });
});
