import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const ConfigPersonasSchema = Type.Object({
  plannerCritic: Type.Optional(Type.String()),
  reviewer: Type.Optional(Type.String()),
  qa: Type.Optional(Type.String()),
  readinessProbe: Type.Optional(Type.String()),
}, { additionalProperties: false });

const CharterConfigFileSchema = Type.Object({
  personas: Type.Optional(ConfigPersonasSchema),
  qaDir: Type.Optional(Type.String()),
  policy: Type.Optional(Type.Union([Type.Literal("interactive"), Type.Literal("autonomous")])),
}, { additionalProperties: false });

type CharterConfigFile = Static<typeof CharterConfigFileSchema>;

export interface CharterConfig {
  personas: {
    plannerCritic: string;
    reviewer: string;
    qa: string;
    readinessProbe: string;
  };
  qaDir: string;
  policy: "interactive" | "autonomous";
}

export type CharterPersonaRole = "plannerCritic" | "reviewer" | "qa" | "readinessProbe";

const DEFAULT_CHARTER_CONFIG: CharterConfig = {
  personas: {
    plannerCritic: "charter-planner-critic",
    reviewer: "charter-reviewer",
    qa: "charter-qa",
    readinessProbe: "charter-readiness-probe",
  },
  qaDir: "docs/qa",
  policy: "interactive",
};

/**
 * Charter config is global only: lives next to the rest of pi's per-user agent
 * state. Resolved via pi's `getAgentDir()` helper (honors $PI_CODING_AGENT_DIR,
 * falls back to `~/.pi/agent`). There is intentionally no per-project override
 * — tactical knobs go in `charter.md` Scope and constraints; agent wiring stays
 * in the user's global config so it can't fork per repo.
 *
 * Model / thinking overrides for charter personas live in pi-subagents'
 * `~/.pi/agent/subagent.json` preset `agents` map (same surface as every other
 * agent). Charter does not maintain a parallel model registry.
 */
function globalConfigPath(): string {
  return join(getAgentDir(), "charter-config.json");
}

function readConfigFile(path: string): CharterConfigFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (err instanceof SyntaxError) {
      throw new Error(`Malformed charter config JSON at ${path}: ${err.message}`);
    }
    throw err;
  }
  if (!Check(CharterConfigFileSchema, parsed)) {
    const [first] = Errors(CharterConfigFileSchema, parsed);
    const fieldPath = first?.instancePath || "/";
    const message = first?.message ?? "schema validation failed";
    throw new Error(`Invalid charter config at ${path}: ${fieldPath} ${message}`);
  }
  return parsed;
}

export function resolvePersona(role: CharterPersonaRole, config: CharterConfig): string {
  return config.personas[role];
}

export function loadCharterConfig(): CharterConfig {
  return normalizeConfig(readConfigFile(globalConfigPath()));
}

function normalizeConfig(file: CharterConfigFile | undefined): CharterConfig {
  const f = file ?? {};
  return {
    personas: {
      ...DEFAULT_CHARTER_CONFIG.personas,
      ...f.personas,
    },
    qaDir: f.qaDir ?? DEFAULT_CHARTER_CONFIG.qaDir,
    policy: f.policy ?? DEFAULT_CHARTER_CONFIG.policy,
  };
}
