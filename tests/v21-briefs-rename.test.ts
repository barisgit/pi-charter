import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { logger, type LogEntry } from "../src/infrastructure/logger";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v21-briefs-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

interface WarnSpy {
  calls: string[];
  restore: () => void;
}

function spyOnWarn(): WarnSpy {
  const calls: string[] = [];
  const handler = (entry: LogEntry) => {
    if (entry.level !== "warn") return;
    calls.push(entry.message);
  };
  logger.addHandler(handler);
  return { calls, restore: () => { logger.clearHandlers(); } };
}

let activeSpy: WarnSpy | undefined;
afterEach(() => {
  activeSpy?.restore();
  activeSpy = undefined;
});

describe("v2.1 briefs dir rename", () => {
  test("create charter scaffolds qa-briefs not qa", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-briefs-rename";
      await createCharter(projectDir, {
        objective: "Ship renamed QA briefs dir",
        charterId,
        now: "2026-05-21T00:00:00.000Z",
      });

      const charterDir = join(projectDir, ".pi", "charters", charterId);
      expect(existsSync(join(charterDir, "qa-briefs"))).toBe(true);
      expect(existsSync(join(charterDir, "qa"))).toBe(false);
    });
  });

  test("no qa/ briefs dir created by default", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-no-qa-briefs-dir";
      await createCharter(projectDir, {
        objective: "Ship renamed QA briefs dir",
        charterId,
        now: "2026-05-21T00:00:00.000Z",
      });

      expect(existsSync(join(projectDir, ".pi", "charters", charterId, "qa"))).toBe(false);
    });
  });

  test("reads legacy qa/ briefs dir when qa-briefs absent", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-legacy-qa-briefs";
      await createCharter(projectDir, {
        objective: "Read legacy QA briefs",
        charterId,
        now: "2026-05-21T00:00:00.000Z",
      });
      const charterDir = join(projectDir, ".pi", "charters", charterId);
      await rm(join(charterDir, "qa-briefs"), { recursive: true, force: true });
      await mkdir(join(charterDir, "qa"), { recursive: true });
      await writeFile(join(charterDir, "qa", "dashboard.md"), "# Dashboard QA\n", "utf8");
      await writeFile(join(charterDir, "qa", "notes.txt"), "ignored\n", "utf8");
      const spy = spyOnWarn();
      activeSpy = spy;

      const status = await getCharterStatus(projectDir, { charterId });

      expect(status.qaBriefs).toEqual(["dashboard"]);
      const matching = spy.calls.filter((line) => line.includes("legacy qa/ briefs dir is deprecated"));
      expect(matching.length).toBe(1);
    });
  });

  test("src/ contains no references to the literal qa/ briefs path", async () => {
    const proc = Bun.spawn(["grep", "-rnE", "join\\([^)]*['\"]qa['\"]", "src/"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();

    expect(await proc.exited).toBe(1);
    expect(stdout.trim()).toBe("");
  });
});
