import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterTools } from "../src/application/registration";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { CharterToolError } from "../src/application/errors";

/**
 * VAL-HANDOFF-SCHEMA: charter_record action=handoff_apply rejects malformed
 * calls at the tool boundary with a CharterToolError carrying a structured
 * `code` and a non-empty `nextActions[]` that names the canonical subagent
 * metadata key. The duplicate runtime guard inside record-service.applyHandoff
 * has been removed, so the tool registration is the single source of truth
 * for these four field validations.
 *
 * On-the-wire compatibility: callers that already pass all four fields
 * (featureId, subagentSessionId, handoffNote, completedCriteria) must still
 * succeed unchanged.
 */

interface FakeTool {
  execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: () => unknown, ctx: unknown) => Promise<unknown>;
}

function makeHarness(homeDir: string): { tools: Map<string, FakeTool> } {
  const tools = new Map<string, FakeTool>();
  const pi: any = {
    events: { emit() {} },
    registerTool(tool: FakeTool & { name: string }) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return ""; },
    on() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  registerCharterTools(pi, { homeDir });
  return { tools };
}

function ctx(projectDir: string, sessionId: string) {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string; charterId: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-handoff-schema-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-handoff-schema-home-"));
  const charterId = "cha-handoff-schema-1";
  try {
    return await fn({ projectDir, homeDir, charterId });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId: string): Promise<void> {
  await createCharter(projectDir, { objective: "Schema validation harness", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  const charterMd = [
    `# Charter ${charterId}`,
    "",
    "## Objective",
    "Schema validation harness.",
    "",
    "## Criteria",
    "",
    "### VAL-S-001 — Sample criterion",
    "Verifier: manual",
    "Because: test fixture rationale",
    "",
    "## Scope and constraints",
    "",
    "- N/A",
    "",
  ].join("\n");
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    [
      "---",
      "id: f1",
      "milestone: m1",
      "order: 1",
      "fulfills: [VAL-S-001]",
      "preconditions: []",
      "---",
      "",
      "# f1",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
}

async function expectRejection(promise: Promise<unknown>): Promise<CharterToolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(CharterToolError);
  return caught as CharterToolError;
}

describe("VAL-HANDOFF-SCHEMA charter_record action=handoff_apply field validation", () => {
  test("missing featureId throws CharterToolError with code handoff_apply.missing_featureId and nextActions hinting featureId metadata key", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const err = await expectRejection(
        tools.get("charter_record")!.execute(
          "c",
          {
            action: "handoff_apply",
            charterId,
            // featureId intentionally absent
            subagentSessionId: "sess-1",
            handoffNote: "note",
            completedCriteria: [{ criterionId: "VAL-S-001", outcome: "pass", summary: "ok" }],
          },
          new AbortController().signal,
          () => undefined,
          ctx(projectDir, "sess-test"),
        ),
      );

      expect(err.code).toBe("handoff_apply.missing_featureId");
      expect(err.nextActions.length).toBeGreaterThan(0);
      const blob = JSON.stringify(err.nextActions);
      expect(blob).toMatch(/pi-charter\.featureId|featureId/);
      expect(err.message).toMatch(/featureId/);
    });
  });

  test("missing subagentSessionId throws CharterToolError with code handoff_apply.missing_subagentSessionId", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const err = await expectRejection(
        tools.get("charter_record")!.execute(
          "c",
          {
            action: "handoff_apply",
            charterId,
            featureId: "f1",
            // subagentSessionId intentionally absent
            handoffNote: "note",
            completedCriteria: [{ criterionId: "VAL-S-001", outcome: "pass", summary: "ok" }],
          },
          new AbortController().signal,
          () => undefined,
          ctx(projectDir, "sess-test"),
        ),
      );

      expect(err.code).toBe("handoff_apply.missing_subagentSessionId");
      expect(err.nextActions.length).toBeGreaterThan(0);
      const blob = JSON.stringify(err.nextActions);
      expect(blob).toMatch(/pi-charter\.subagentSessionId|subagentSessionId/);
      expect(err.message).toMatch(/subagentSessionId/);
    });
  });

  test("missing handoffNote throws CharterToolError with code handoff_apply.missing_handoffNote", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const err = await expectRejection(
        tools.get("charter_record")!.execute(
          "c",
          {
            action: "handoff_apply",
            charterId,
            featureId: "f1",
            subagentSessionId: "sess-1",
            // handoffNote intentionally absent
            completedCriteria: [{ criterionId: "VAL-S-001", outcome: "pass", summary: "ok" }],
          },
          new AbortController().signal,
          () => undefined,
          ctx(projectDir, "sess-test"),
        ),
      );

      expect(err.code).toBe("handoff_apply.missing_handoffNote");
      expect(err.nextActions.length).toBeGreaterThan(0);
      expect(JSON.stringify(err.nextActions)).toMatch(/handoffNote/);
      expect(err.message).toMatch(/handoffNote/);
    });
  });

  test("empty completedCriteria throws CharterToolError with code handoff_apply.empty_completedCriteria", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const err = await expectRejection(
        tools.get("charter_record")!.execute(
          "c",
          {
            action: "handoff_apply",
            charterId,
            featureId: "f1",
            subagentSessionId: "sess-1",
            handoffNote: "note",
            completedCriteria: [],
          },
          new AbortController().signal,
          () => undefined,
          ctx(projectDir, "sess-test"),
        ),
      );

      expect(err.code).toBe("handoff_apply.empty_completedCriteria");
      expect(err.nextActions.length).toBeGreaterThan(0);
      expect(JSON.stringify(err.nextActions)).toMatch(/completedCriteria/);
      expect(err.message).toMatch(/completedCriteria/);
    });
  });

  test("completedCriteria omitted entirely is treated the same as empty", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const err = await expectRejection(
        tools.get("charter_record")!.execute(
          "c",
          {
            action: "handoff_apply",
            charterId,
            featureId: "f1",
            subagentSessionId: "sess-1",
            handoffNote: "note",
            // completedCriteria intentionally absent
          },
          new AbortController().signal,
          () => undefined,
          ctx(projectDir, "sess-test"),
        ),
      );

      expect(err.code).toBe("handoff_apply.empty_completedCriteria");
      expect(err.nextActions.length).toBeGreaterThan(0);
    });
  });

  test("happy-path call still succeeds (regression check; on-the-wire compatibility for compliant callers)", async () => {
    await withTempProject(async ({ projectDir, homeDir, charterId }) => {
      await makeActiveCharter(projectDir, charterId);
      const { tools } = makeHarness(homeDir);

      const result = await tools.get("charter_record")!.execute(
        "c",
        {
          action: "handoff_apply",
          charterId,
          featureId: "f1",
          subagentSessionId: "sess_worker_42",
          handoffNote: "Implemented sample criterion.",
          completedCriteria: [
            { criterionId: "VAL-S-001", outcome: "pass", summary: "Sample criterion satisfied" },
          ],
        },
        new AbortController().signal,
        () => undefined,
        ctx(projectDir, "sess-test"),
      );

      // The handler returns a toolResult envelope with the applyHandoff result
      // tucked under `.details`. Different harnesses surface it as either the
      // top-level result or via `.details`; assert on the shape that exists.
      const details = (result as { details?: { featureId?: string; subagentSessionId?: string; appliedCount?: number } }).details
        ?? (result as { featureId?: string; subagentSessionId?: string; appliedCount?: number });
      expect(details.featureId).toBe("f1");
      expect(details.subagentSessionId).toBe("sess_worker_42");
      expect(details.appliedCount).toBe(1);
    });
  });
});
