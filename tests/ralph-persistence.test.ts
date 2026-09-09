import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharterWorkspace, loadCharterState, readEvents, charterDir } from "../src/infrastructure/store";
import { attemptRalphActivation } from "../src/application/ralph";

const projects: string[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const projectDir = await mkdtemp(join(tmpdir(), "charter-guard-"));
  projects.push(projectDir);
  const charterId = "20260908-120000-guard";
  await createCharterWorkspace(projectDir, { charterId, objective: "Deliver the whole objective", now: "2026-09-08T12:00:00Z", sessionId: "s1" });
  return { projectDir, charterId, sessionId: "s1", isEligible: () => true };
}

describe("durable actual-send guard", () => {
  test("five sends produce one recovery; next activation pauses without sending", async () => {
    const input = await setup();
    const sent: string[] = [];
    for (const at of [0, 180_000, 360_000, 540_000, 720_000]) {
      await attemptRalphActivation({ ...input, at, send: (kind) => { sent.push(kind); } });
    }
    expect(sent).toEqual(["normal", "normal", "normal", "normal", "recovery"]);
    // A fresh invocation reloads durable state rather than relying on the previous loop instance.
    expect(await attemptRalphActivation({ ...input, at: 900_000, send: (kind) => { sent.push(kind); } })).toBe("pause");
    expect(sent).toHaveLength(5);
    const state = await loadCharterState(input.projectDir, input.charterId);
    expect(state.status).toBe("paused");
    expect(state.ralph?.pausedByGuard).toBe(true);
    expect(state.ralph?.activations).toHaveLength(5);
    const events = await readEvents(charterDir(input.projectDir, input.charterId));
    expect(events.filter((event) => event.type === "ralph_activated")).toHaveLength(5);
    expect(events.at(-1)?.type).toBe("charter_paused");
  });

  test("failed sends, busy checks and wrong-session requests do not consume activations", async () => {
    const input = await setup();
    let count = 0;
    const send = () => { count++; };
    expect(await attemptRalphActivation({ ...input, at: 1, isEligible: () => false, send })).toBe("skipped");
    expect(await attemptRalphActivation({ ...input, at: 2, sessionId: "other", send })).toBe("skipped");
    await expect(attemptRalphActivation({ ...input, at: 3, send: () => { throw new Error("send rejected"); } })).rejects.toThrow("send rejected");
    expect(count).toBe(0);
    expect((await loadCharterState(input.projectDir, input.charterId)).ralph?.activations ?? []).toEqual([]);
    expect(await attemptRalphActivation({ ...input, at: 4, send })).toBe("normal");
    expect(count).toBe(1);
  });

  test("concurrent eligible requests serialize through the warning and pause boundary", async () => {
    const input = await setup();
    const sent: string[] = [];
    await Promise.all(Array.from({ length: 8 }, (_, at) => attemptRalphActivation({ ...input, at, send: (kind) => { sent.push(kind); } })));
    expect(sent).toEqual(["normal", "normal", "normal", "normal", "recovery"]);
    expect((await loadCharterState(input.projectDir, input.charterId)).status).toBe("paused");
  });
});
