import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const OutcomeSchema = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("partial")]);
const SourceSchema = Type.Union([Type.Literal("manual"), Type.Literal("verifier"), Type.Literal("subagent")]);

/** v3 flat evidence row written under work/<segment>/evidence/<ts>/evidence.json */
export const FlatEvidenceSchema = Type.Object({
  charterId: Type.Optional(Type.String()),
  criterionId: Type.String(),
  featureId: Type.Optional(Type.String()),
  outcome: OutcomeSchema,
  summary: Type.String(),
  because: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(Type.String())),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  source: Type.Optional(SourceSchema),
  recordedBy: Type.Optional(Type.String()),
  narrativePath: Type.Optional(Type.String()),
  verifier: Type.Optional(Type.String()),
  ts: Type.String(),
}, { additionalProperties: false });

export type FlatEvidence = Static<typeof FlatEvidenceSchema>;
export type EvidenceFile = FlatEvidence;

export type ValidateEvidenceFileResult =
  | { ok: true; value: EvidenceFile }
  | { ok: false; error: string };

const LEGACY_KINDS = new Set(["command", "review", "qa", "readiness"]);

export function validateEvidenceFile(json: unknown): ValidateEvidenceFileResult {
  const legacyKind = getLegacyKind(json);
  if (legacyKind && LEGACY_KINDS.has(legacyKind)) {
    return {
      ok: false,
      error: `Legacy typed evidence kind '${legacyKind}' is no longer supported; use the flat evidence row shape (criterionId, outcome, summary, ts, ...).`,
    };
  }

  if (!Check(FlatEvidenceSchema, json)) {
    const [first] = Errors(FlatEvidenceSchema, json);
    const missing = (first?.params as { requiredProperties?: unknown } | undefined)?.requiredProperties;
    const [missingField] = Array.isArray(missing) ? missing : [];
    const fieldPath = typeof missingField === "string" ? `/${missingField}` : first?.instancePath || "/";
    const message = first?.message ?? "schema validation failed";
    return { ok: false, error: `Invalid evidence at ${fieldPath}: ${message}` };
  }

  const narrativePathError = validateNarrativePath(json as EvidenceFile);
  if (narrativePathError) return { ok: false, error: narrativePathError };
  return { ok: true, value: json as EvidenceFile };
}

export function parseEvidence(json: unknown): EvidenceFile {
  const validation = validateEvidenceFile(json);
  if (!validation.ok) throw new Error(validation.error);
  return validation.value;
}

function getLegacyKind(json: unknown): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const kind = (json as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function validateNarrativePath(evidence: EvidenceFile): string | undefined {
  const path = evidence.narrativePath;
  if (path === undefined) return undefined;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return "Invalid evidence at /narrativePath: narrativePath must be relative";
  }
  return undefined;
}
