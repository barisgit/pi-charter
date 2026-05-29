import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { logger, type LogEntry } from "../src/infrastructure/logger";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-workspace-layout-"));
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

describe("workspace layout", () => {
  test("create charter scaffolds work/ not qa-briefs", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-briefs-rename";
      await createCharter(projectDir, {
        objective: "Ship v3 charter workspace",
        charterId,
        now: "2026-05-21T00:00:00.000Z",
      });

      const dir = join(projectDir, ".pi", "charters", charterId);
      expect(existsSync(join(dir, "work"))).toBe(true);
      expect(existsSync(join(dir, "qa-briefs"))).toBe(false);
      expect(existsSync(join(dir, "qa"))).toBe(false);
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

  test("src/ contains no references to the literal qa/ briefs path", async () => {
    const proc = Bun.spawn(["grep", "-rnE", "join\\([^)]*['\"]qa['\"]", "src/"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();

    expect(await proc.exited).toBe(1);
    expect(stdout.trim()).toBe("");
  });
});
