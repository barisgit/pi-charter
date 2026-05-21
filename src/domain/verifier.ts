import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const EvidenceKindSchema = Type.Union([
  Type.Literal("review"),
  Type.Literal("qa"),
  Type.Literal("readiness"),
  Type.Literal("command"),
]);

const ManualVerifierSchema = Type.Object({
  kind: Type.Literal("manual"),
}, { additionalProperties: false });

const CommandVerifierSchema = Type.Object({
  kind: Type.Literal("command"),
  command: Type.Optional(Type.String()),
}, { additionalProperties: false });

const HookVerifierSchema = Type.Object({
  kind: Type.Literal("hook"),
}, { additionalProperties: false });

const PromptVerifierSchema = Type.Object({
  kind: Type.Literal("prompt"),
}, { additionalProperties: false });

export const SubagentVerifierSchema = Type.Object({
  kind: Type.Literal("subagent"),
  agent: Type.String(),
  task: Type.String(),
}, { additionalProperties: false });

export const EvidenceExistsVerifierSchema = Type.Object({
  kind: Type.Literal("evidence-exists"),
  evidenceKind: EvidenceKindSchema,
  freshSince: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const VerifierSchema = Type.Union([
  ManualVerifierSchema,
  CommandVerifierSchema,
  HookVerifierSchema,
  PromptVerifierSchema,
  SubagentVerifierSchema,
  EvidenceExistsVerifierSchema,
]);

export type Verifier = Static<typeof VerifierSchema>;
export type VerifierKind = Verifier["kind"];
export type SubagentVerifier = Static<typeof SubagentVerifierSchema>;
export type EvidenceExistsVerifier = Static<typeof EvidenceExistsVerifierSchema>;
export type EvidenceExistsVerifierKind = EvidenceExistsVerifier["evidenceKind"];

export type ValidateVerifierResult =
  | { ok: true; value: Verifier }
  | { ok: false; error: string };

const schemasByKind = {
  manual: ManualVerifierSchema,
  command: CommandVerifierSchema,
  hook: HookVerifierSchema,
  prompt: PromptVerifierSchema,
  subagent: SubagentVerifierSchema,
  "evidence-exists": EvidenceExistsVerifierSchema,
} as const;

export function validateVerifier(json: unknown): ValidateVerifierResult {
  const kind = getVerifierKind(json);
  if (!isVerifierKind(kind)) {
    return { ok: false, error: `Unknown verifier kind: ${String(kind ?? "<missing>")}` };
  }

  const schema = schemasByKind[kind];
  if (Check(schema, json)) {
    const value = json as Verifier;
    if (value.kind === "evidence-exists" && value.freshSince !== undefined && Number.isNaN(Date.parse(value.freshSince))) {
      return { ok: false, error: "Invalid evidence-exists verifier at /freshSince: must be an ISO8601 timestamp" };
    }
    return { ok: true, value };
  }

  const [first] = Errors(schema, json);
  const missing = (first?.params as { requiredProperties?: unknown } | undefined)?.requiredProperties;
  const [missingField] = Array.isArray(missing) ? missing : [];
  const fieldPath = typeof missingField === "string" ? `/${missingField}` : first?.instancePath || "/";
  const message = first?.message ?? "schema validation failed";
  return { ok: false, error: `Invalid ${kind} verifier at ${fieldPath}: ${message}` };
}

function getVerifierKind(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  return (json as { kind?: unknown }).kind;
}

function isVerifierKind(kind: unknown): kind is VerifierKind {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(schemasByKind, kind);
}
