import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharterConfig, resolvePersonaModelByAgent } from "../src/persistence/charter-config";

function makeRepo(cfg: object): string {
  const dir = mkdtempSync(join(tmpdir(), "v22-model-override-"));
  const cfgDir = join(dir, ".pi", "charter");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "charter-config.json"), JSON.stringify(cfg, null, 2));
  return dir;
}

describe("v2.2 personasModel override resolution", () => {
  test("resolves model override for default reviewer persona name", () => {
    const dir = makeRepo({
      personasModel: { reviewer: "openai-codex/gpt-5.4-mini-fast" },
    });
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("charter-reviewer", cfg)).toBe("openai-codex/gpt-5.4-mini-fast");
  });

  test("resolves model override for custom persona name (BYOA)", () => {
    const dir = makeRepo({
      personas: { reviewer: "my-team-reviewer" },
      personasModel: { reviewer: "minimax/MiniMax-M2.7-highspeed" },
    });
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("my-team-reviewer", cfg)).toBe("minimax/MiniMax-M2.7-highspeed");
    expect(resolvePersonaModelByAgent("charter-reviewer", cfg)).toBeUndefined();
  });

  test("returns undefined when no personasModel override configured", () => {
    const dir = makeRepo({});
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("charter-reviewer", cfg)).toBeUndefined();
    expect(resolvePersonaModelByAgent("charter-qa", cfg)).toBeUndefined();
  });

  test("returns undefined for unknown agent name", () => {
    const dir = makeRepo({
      personasModel: { reviewer: "openai-codex/gpt-5.5" },
    });
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("totally-unknown-agent", cfg)).toBeUndefined();
  });

  test("ignores empty-string model override", () => {
    const dir = makeRepo({
      personasModel: { reviewer: "   " },
    });
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("charter-reviewer", cfg)).toBeUndefined();
  });

  test("resolves all 4 roles independently", () => {
    const dir = makeRepo({
      personasModel: {
        plannerCritic: "openai-codex/gpt-5.5",
        reviewer: "openai-codex/gpt-5.4-mini-fast",
        qa: "minimax/MiniMax-M2.7-highspeed",
        readinessProbe: "openai-codex/gpt-5.4-mini-fast",
      },
    });
    const cfg = loadCharterConfig(dir);
    expect(resolvePersonaModelByAgent("charter-planner-critic", cfg)).toBe("openai-codex/gpt-5.5");
    expect(resolvePersonaModelByAgent("charter-reviewer", cfg)).toBe("openai-codex/gpt-5.4-mini-fast");
    expect(resolvePersonaModelByAgent("charter-qa", cfg)).toBe("minimax/MiniMax-M2.7-highspeed");
    expect(resolvePersonaModelByAgent("charter-readiness-probe", cfg)).toBe("openai-codex/gpt-5.4-mini-fast");
  });
});
