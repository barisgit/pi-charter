import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { charterDir, createCharterWorkspace, writeTextAtomic } from "../src/infrastructure/store";
import { criterionStaleness, recordSourceModification, refreshCharterSnapshot } from "../src/application/staleness";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-stale-"));
}

function charterText(evidence: string): string {
  return `## Objective\n\nShip it.\n\n## Criteria\n\n### C1. Works\nEvidence: ${evidence}\n`;
}

describe("staleness", () => {
  test("evidence before source change is stale", async () => {
    const project = await tempProject();
    const id = "20260702-000000-stale";
    await createCharterWorkspace(project, { charterId: id, objective: "Ship it", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    await writeTextAtomic(join(charterDir(project, id), "charter.md"), charterText("pass — checked"));
    let refreshed = await refreshCharterSnapshot(project, id);
    expect(criterionStaleness(refreshed.state)[0].stale).toBe(false);
    await recordSourceModification(project, { files: ["src/file.ts"], sessionId: "s1" });
    refreshed = await refreshCharterSnapshot(project, id);
    expect(criterionStaleness(refreshed.state)[0].stale).toBe(true);
  });

  test("source change before evidence is fresh", async () => {
    const project = await tempProject();
    const id = "20260702-000000-fresh";
    await createCharterWorkspace(project, { charterId: id, objective: "Ship it", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    await recordSourceModification(project, { files: ["src/file.ts"], sessionId: "s1" });
    await writeTextAtomic(join(charterDir(project, id), "charter.md"), charterText("pass — checked after source"));
    const refreshed = await refreshCharterSnapshot(project, id);
    expect(criterionStaleness(refreshed.state)[0].stale).toBe(false);
  });
});
