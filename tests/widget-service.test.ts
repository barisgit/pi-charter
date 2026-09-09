import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createCharter } from "../src/application/service";
import { charterDir, charterFilePath } from "../src/infrastructure/store";
import { loadCharterSnapshot } from "../src/ui/widget-service";

describe("loadCharterSnapshot", () => {
  test("projects Objective/Phases status into the compact widget view model", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-widget-service-"));
    const created = await createCharter(projectDir, { objective: "Ship runtime", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(charterFilePath(charterDir(projectDir, created.charterId)), "# Objective\n\nShip runtime.\n\n## Phases\n\n1. Explore — done\n   Mapped it.\n\n2. Build — current\n   [capture](work/build.png)\n", "utf8");

    const vm = await loadCharterSnapshot({ projectDir, charterId: created.charterId, now: Date.parse("2026-07-02T11:00:00.000Z") });
    expect(vm.objective).toBe("Ship runtime.");
    expect(vm.position).toEqual({ done: 1, total: 2 });
    expect(vm.currentPhase).toEqual({ number: 2, title: "Build", body: "[capture](work/build.png)" });
  });
});
