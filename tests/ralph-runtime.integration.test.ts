import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { registerCharterRalphLoop } from "../src/application/registration";
import { createCharter, pauseCharter } from "../src/application/service";

const MODEL: Model<string> = {
  id: "ralph-runtime-test",
  name: "Ralph runtime test",
  api: "ralph-runtime-test",
  provider: "ralph-runtime-test",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 256,
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Ralph continuation");
    await Bun.sleep(5);
  }
}

describe("Ralph host runtime integration", () => {
  test("a reopened bound session continues after the next prompted turn", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-ralph-runtime-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-charter-ralph-runtime-agent-"));
    const sessionDir = join(agentDir, "sessions");
    tempDirs.push(project, agentDir);

    let providerCalls = 0;
    const providerContexts: string[] = [];
    let charterId: string | undefined;
    const providerExtension: ExtensionFactory = (pi) => {
      pi.registerProvider(MODEL.provider, {
        api: MODEL.api,
        streamSimple: (_model: Model<string>, context: Context, _options?: SimpleStreamOptions) => {
          const stream = createAssistantMessageEventStream();
          const call = ++providerCalls;
          providerContexts.push(JSON.stringify(context));
          void (async () => {
            if (call === 2 && charterId) {
              await pauseCharter(project, { charterId, note: "Stop after observing the resumed Ralph turn." });
            }
            const message = assistantMessage(call === 1 ? "Prompt handled." : "Ralph continuation handled.");
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          })();
          return stream;
        },
      });
    };
    const ralphExtension: ExtensionFactory = (pi) => {
      registerCharterRalphLoop(pi, { debounceMs: 5, warningLeadMs: 0, minIntervalMs: 0 });
    };

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey(MODEL.provider, "test-key");
      const services = await createAgentSessionServices({
        cwd,
        agentDir: runtimeAgentDir,
        authStorage,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [providerExtension, ralphExtension],
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: MODEL,
          noTools: "all",
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const firstRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: project,
      agentDir,
      sessionManager: SessionManager.create(project, sessionDir),
    });
    await firstRuntime.session.bindExtensions({});
    const sessionFile = firstRuntime.session.sessionFile;
    expect(sessionFile).toBeDefined();
    const created = await createCharter(project, {
      objective: "Keep Ralph active across session reopen",
      sessionId: firstRuntime.session.sessionId,
    });
    charterId = created.charterId;
    await firstRuntime.dispose();

    const reopenedRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: project,
      agentDir,
      sessionManager: SessionManager.open(sessionFile!, sessionDir, project),
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: sessionFile },
    });
    reopenedRuntime.setRebindSession(async (session) => session.bindExtensions({}));
    await reopenedRuntime.session.bindExtensions({});

    try {
      await Bun.sleep(50);
      expect(providerCalls).toBe(0);
      await reopenedRuntime.session.prompt("Continue working on the bound charter.");
      await waitFor(() => providerCalls >= 2);
      await Bun.sleep(25);

      expect(providerCalls).toBe(2);
      expect(providerContexts[1]).toContain("Charter .charters/");
    } finally {
      await reopenedRuntime.dispose();
    }
  }, 10_000);
});
