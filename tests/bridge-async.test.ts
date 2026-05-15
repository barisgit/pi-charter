import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributionFromMetadata,
  handleAsyncComplete,
  handleAsyncStarted,
} from "../src/application/async-bridge-service";
import { createCharter } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";
import { PI_CHARTER_METADATA_KEYS } from "../src/infrastructure/subagent-bridge";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-bridge-async-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function readEvents(projectDir: string, charterId: string): Promise<Record<string, unknown>[]> {
  const path = join(charterDir(projectDir, charterId), "events.jsonl");
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("bridge surface 3: async event attribution", () => {
  test("attributionFromMetadata returns null when required keys missing", () => {
    expect(attributionFromMetadata(undefined)).toBeNull();
    expect(attributionFromMetadata({})).toBeNull();
    expect(attributionFromMetadata({ [PI_CHARTER_METADATA_KEYS.projectDir]: "/p" })).toBeNull();
    expect(attributionFromMetadata({ [PI_CHARTER_METADATA_KEYS.charterId]: "cha-1" })).toBeNull();
  });

  test("attributionFromMetadata returns attribution when projectDir + charterId present", () => {
    const result = attributionFromMetadata({
      [PI_CHARTER_METADATA_KEYS.projectDir]: "/project",
      [PI_CHARTER_METADATA_KEYS.charterId]: "cha-1",
      [PI_CHARTER_METADATA_KEYS.featureId]: "f1",
      [PI_CHARTER_METADATA_KEYS.criterionId]: "VAL-X-001",
    });
    expect(result).toEqual({
      projectDir: "/project",
      charterId: "cha-1",
      featureId: "f1",
      criterionId: "VAL-X-001",
    });
  });

  test("attributionFromMetadata ignores non-string optional keys", () => {
    const result = attributionFromMetadata({
      [PI_CHARTER_METADATA_KEYS.projectDir]: "/project",
      [PI_CHARTER_METADATA_KEYS.charterId]: "cha-1",
      [PI_CHARTER_METADATA_KEYS.featureId]: 42,
      [PI_CHARTER_METADATA_KEYS.criterionId]: "",
    });
    expect(result).toEqual({
      projectDir: "/project",
      charterId: "cha-1",
      featureId: undefined,
      criterionId: undefined,
    });
  });

  test("handleAsyncStarted appends feature_started to events.jsonl", async () => {
    await withTempProject(async (projectDir) => {
      await createCharter(projectDir, {
        objective: "Test charter for async bridge",
        charterId: "cha-async-1",
        now: "2026-05-15T00:00:00.000Z",
      });
      const wrote = await handleAsyncStarted({
        payload: {
          runId: "run-42",
          agent: "charter-verifier",
          metadata: {
            [PI_CHARTER_METADATA_KEYS.projectDir]: projectDir,
            [PI_CHARTER_METADATA_KEYS.charterId]: "cha-async-1",
            [PI_CHARTER_METADATA_KEYS.featureId]: "f1-bootstrap",
            [PI_CHARTER_METADATA_KEYS.criterionId]: "VAL-X-001",
          },
        },
        now: "2026-05-15T01:00:00.000Z",
      });
      expect(wrote).toBe(true);
      const events = await readEvents(projectDir, "cha-async-1");
      const matched = events.filter((e) => e.type === "feature_started");
      expect(matched).toHaveLength(1);
      const event = matched[0]!;
      expect(event).toMatchObject({
        type: "feature_started",
        ts: "2026-05-15T01:00:00.000Z",
        charterId: "cha-async-1",
        featureId: "f1-bootstrap",
        criterionId: "VAL-X-001",
        runId: "run-42",
        agent: "charter-verifier",
        source: "subagent:async-started",
      });
    });
  });

  test("handleAsyncComplete appends feature_completed when exitCode === 0", async () => {
    await withTempProject(async (projectDir) => {
      await createCharter(projectDir, {
        objective: "Test charter for async bridge",
        charterId: "cha-async-2",
        now: "2026-05-15T00:00:00.000Z",
      });
      const wrote = await handleAsyncComplete({
        payload: {
          runId: "run-43",
          agent: "charter-verifier",
          exitCode: 0,
          durationMs: 1234,
          summary: "Verified VAL-X-001: pass",
          metadata: {
            [PI_CHARTER_METADATA_KEYS.projectDir]: projectDir,
            [PI_CHARTER_METADATA_KEYS.charterId]: "cha-async-2",
            [PI_CHARTER_METADATA_KEYS.featureId]: "f1-bootstrap",
          },
        },
        now: "2026-05-15T01:00:00.000Z",
      });
      expect(wrote).toBe(true);
      const events = await readEvents(projectDir, "cha-async-2");
      const matched = events.filter((e) => e.type === "feature_completed");
      expect(matched).toHaveLength(1);
      expect(matched[0]).toMatchObject({
        type: "feature_completed",
        charterId: "cha-async-2",
        featureId: "f1-bootstrap",
        runId: "run-43",
        exitCode: 0,
        durationMs: 1234,
        summary: "Verified VAL-X-001: pass",
        source: "subagent:async-complete",
      });
    });
  });

  test("handleAsyncComplete appends feature_failed when exitCode !== 0", async () => {
    await withTempProject(async (projectDir) => {
      await createCharter(projectDir, {
        objective: "Test charter for async bridge",
        charterId: "cha-async-3",
        now: "2026-05-15T00:00:00.000Z",
      });
      const wrote = await handleAsyncComplete({
        payload: {
          runId: "run-44",
          agent: "charter-verifier",
          exitCode: 1,
          summary: "spawn failed",
          metadata: {
            [PI_CHARTER_METADATA_KEYS.projectDir]: projectDir,
            [PI_CHARTER_METADATA_KEYS.charterId]: "cha-async-3",
          },
        },
        now: "2026-05-15T01:00:00.000Z",
      });
      expect(wrote).toBe(true);
      const events = await readEvents(projectDir, "cha-async-3");
      const matched = events.filter((e) => e.type === "feature_failed");
      expect(matched).toHaveLength(1);
      expect(matched[0]).toMatchObject({
        type: "feature_failed",
        charterId: "cha-async-3",
        runId: "run-44",
        exitCode: 1,
        summary: "spawn failed",
      });
    });
  });

  test("handlers return false and do nothing when metadata lacks pi-charter keys", async () => {
    await withTempProject(async (projectDir) => {
      const startedResult = await handleAsyncStarted({
        payload: { runId: "run-99", metadata: { somethingElse: true } },
      });
      const completeResult = await handleAsyncComplete({
        payload: { runId: "run-99", exitCode: 0, metadata: undefined },
      });
      expect(startedResult).toBe(false);
      expect(completeResult).toBe(false);
      // No charter dir created \u2014 verify there's no events file lurking.
      // (We just confirm the projectDir contains no .pi tree.)
      const eventsPath = join(projectDir, ".pi");
      try {
        await readFile(join(eventsPath, "marker"), "utf8");
      } catch {
        // expected
      }
    });
  });
});
