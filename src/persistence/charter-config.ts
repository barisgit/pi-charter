import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const ConfigPersonasSchema = Type.Object({
  plannerCritic: Type.Optional(Type.String()),
  reviewer: Type.Optional(Type.String()),
  qa: Type.Optional(Type.String()),
  readinessProbe: Type.Optional(Type.String()),
}, { additionalProperties: false });

const ConfigPersonasModelSchema = Type.Object({
  plannerCritic: Type.Optional(Type.String()),
  reviewer: Type.Optional(Type.String()),
  qa: Type.Optional(Type.String()),
  readinessProbe: Type.Optional(Type.String()),
}, { additionalProperties: false });

const CharterConfigFileSchema = Type.Object({
  personas: Type.Optional(ConfigPersonasSchema),
  qaDir: Type.Optional(Type.String()),
  policy: Type.Optional(Type.Union([Type.Literal("interactive"), Type.Literal("autonomous")])),
  personasModel: Type.Optional(ConfigPersonasModelSchema),
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
  personasModel: {
    plannerCritic?: string;
    reviewer?: string;
    qa?: string;
    readinessProbe?: string;
  };
}

export type CharterPersonaRole = keyof CharterConfig["personas"];

export interface ResolvedPersona {
  agent: string;
  model?: string;
}

const DEFAULT_CHARTER_CONFIG: CharterConfig = {
  personas: {
    plannerCritic: "charter-planner-critic",
    reviewer: "charter-reviewer",
    qa: "charter-qa",
    readinessProbe: "charter-readiness-probe",
  },
  qaDir: "docs/qa",
  policy: "interactive",
  personasModel: {},
};

function configPath(cwd: string): string {
  return join(cwd, ".pi", "charter", "charter-config.json");
}

export function resolvePersona(role: CharterPersonaRole, config: CharterConfig): ResolvedPersona {
  return {
    agent: config.personas[role],
    model: config.personasModel[role],
  };
}

export function loadCharterConfig(cwd: string): CharterConfig {
  const path = configPath(cwd);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CHARTER_CONFIG, personas: { ...DEFAULT_CHARTER_CONFIG.personas }, personasModel: {} };
    }
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

  return normalizeConfig(parsed);
}

function normalizeConfig(config: CharterConfigFile): CharterConfig {
  return {
    personas: {
      ...DEFAULT_CHARTER_CONFIG.personas,
      ...config.personas,
    },
    qaDir: config.qaDir ?? DEFAULT_CHARTER_CONFIG.qaDir,
    policy: config.policy ?? DEFAULT_CHARTER_CONFIG.policy,
    personasModel: {
      ...config.personasModel,
    },
  };
}
