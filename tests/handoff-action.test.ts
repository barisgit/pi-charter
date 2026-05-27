import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { registerCharterTools } from "../src/application/registration";
import { createCharter } from "../src/application/service";
import { CharterToolError } from "../src/application/errors";
import { charterDir } from "../src/infrastructure/store";
import type { HandoffRecordInput } from "../src/persistence/handoff-store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-handoff-action-"));
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
    objective: "Record worker handoffs",
    charterId,
    now: "2026-05-27T09:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Record worker handoffs.",
      "",
      "## Criteria",
      "",
      "### VAL-HANDOFF-001 — Handoff files are persisted",
      "Description: Worker handoff files land under the feature work directory.",
      "Verifier: manual",
      "",
      "## Scope and constraints",
      "",
      "- Keep the action surgical.",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "m1-test.md"),
    `---\nid: m1-test\nmilestone: m1\norder: 1\nfulfills: [VAL-HANDOFF-001]\npreconditions: []\n---\n\n# m1-test\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-27T09:10:00.000Z", legacy: true });
  return dir;
}

async function callRecord(projectDir: string, params: Record<string, unknown>): Promise<any> {
  const tools: Array<{ name: string; execute: Function }> = [];
  const fakePi: any = {
    registerTool(desc: any) {
      tools.push(desc);
    },
  };
  registerCharterTools(fakePi);
  const recordTool = tools.find((tool) => tool.name === "charter_record")!;
  const ctx: any = {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => undefined },
  };
  return await recordTool.execute("call-1", params, new AbortController().signal, () => {}, ctx);
}

function validHandoff(overrides: Partial<HandoffRecordInput> = {}): HandoffRecordInput {
  return {
    sessionId: "fixer-session-1",
    featureId: "m1-test",
    agent: "fixer",
    startedAt: "2026-05-27T09:20:00.000Z",
    completedAt: "2026-05-27T09:30:00.000Z",
    successState: "success",
    validatorsPassed: true,
    fulfills: ["VAL-HANDOFF-001"],
    whatWasImplemented: "Implemented the structured handoff persistence path and verified that the worker record is stored for later review.",
    whatWasLeftUndone: "",
    verification: {
      commandsRun: [
        { command: "bun test tests/handoff-action.test.ts", exitCode: 0, observation: "Handoff action tests passed locally." },
      ],
    },
    discoveredIssues: [],
    skillFeedback: {
      followedProcedure: true,
      deviations: [],
      suggestedChanges: [],
    },
    ...overrides,
  };
}

describe("charter_record action=handoff", () => {
  test("writes inline handoff under work/<featureId>/handoffs and updates feature-state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-handoff-action-inline";
      const dir = await makeActiveCharter(projectDir, charterId);

      const response = await callRecord(projectDir, {
        action: "handoff",
        charterId,
        ...validHandoff({ sessionId: "fixer-inline-1" }),
      });

      expect(response.details).toMatchObject({
        charterId,
        featureId: "m1-test",
        sessionId: "fixer-inline-1",
        handoffPath: join("work", "m1-test", "handoffs", "fixer-inline-1.handoff.json"),
      });
      const stored = JSON.parse(await readFile(join(dir, response.details.handoffPath), "utf8"));
      expect(stored.sessionId).toBe("fixer-inline-1");
      expect(stored.whatWasImplemented).toContain("structured handoff persistence path");

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["m1-test"].lastWorkerSessionId).toBe("fixer-inline-1");
      expect(featureState.features["m1-test"].lastHandoffPath).toBe(response.details.handoffPath);
    });
  });

  test("rejects schema-invalid inline handoff", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-handoff-action-invalid";
      await makeActiveCharter(projectDir, charterId);

      let caught: unknown;
      try {
        await callRecord(projectDir, {
          action: "handoff",
          charterId,
          ...validHandoff({ whatWasImplemented: "too short" }),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CharterToolError);
      expect((caught as CharterToolError).code).toBe("handoff.schema_violation");
      expect((caught as Error).message).toContain("whatWasImplemented");
    });
  });

  test("keeps multiple sessions for the same feature side by side", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-handoff-action-multi";
      const dir = await makeActiveCharter(projectDir, charterId);

      await callRecord(projectDir, {
        action: "handoff",
        charterId,
        ...validHandoff({ sessionId: "fixer-multi-1" }),
      });
      await callRecord(projectDir, {
        action: "handoff",
        charterId,
        ...validHandoff({ sessionId: "fixer-multi-2" }),
      });

      const first = join(dir, "work", "m1-test", "handoffs", "fixer-multi-1.handoff.json");
      const second = join(dir, "work", "m1-test", "handoffs", "fixer-multi-2.handoff.json");
      expect(JSON.parse(await readFile(first, "utf8")).sessionId).toBe("fixer-multi-1");
      expect(JSON.parse(await readFile(second, "utf8")).sessionId).toBe("fixer-multi-2");
    });
  });

  test("imports a handoffFile and writes the normalized record to the canonical path", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-handoff-action-file";
      const dir = await makeActiveCharter(projectDir, charterId);
      await mkdir(join(dir, "incoming"), { recursive: true });
      await writeFile(
        join(dir, "incoming", "worker.json"),
        `${JSON.stringify(validHandoff({ sessionId: "fixer-file-1" }), null, 2)}\n`,
        "utf8",
      );

      const response = await callRecord(projectDir, {
        action: "handoff",
        charterId,
        handoffFile: join("incoming", "worker.json"),
      });

      expect(response.details.handoffPath).toBe(join("work", "m1-test", "handoffs", "fixer-file-1.handoff.json"));
      const stored = JSON.parse(await readFile(join(dir, response.details.handoffPath), "utf8"));
      expect(stored.sessionId).toBe("fixer-file-1");
      expect(stored.agent).toBe("fixer");
    });
  });

  test("defaults discoveredIssues triageState to untriaged", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-handoff-action-triage";
      const dir = await makeActiveCharter(projectDir, charterId);

      const response = await callRecord(projectDir, {
        action: "handoff",
        charterId,
        ...validHandoff({
          sessionId: "fixer-triage-1",
          discoveredIssues: [
            {
              severity: "non_blocking",
              kind: "discovered_issue",
              description: "A follow-up cleanup opportunity was found while implementing the handoff action.",
            },
          ],
        }),
      });

      const stored = JSON.parse(await readFile(join(dir, response.details.handoffPath), "utf8"));
      expect(stored.discoveredIssues[0].triageState).toBe("untriaged");
    });
  });
});
