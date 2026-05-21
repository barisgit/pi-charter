import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const OutcomeSchema = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("partial")]);
const CommandCheckOutcomeSchema = Type.Union([Type.Literal("pass"), Type.Literal("fail")]);

const CommandCheckResultSchema = Type.Object({
  outcome: CommandCheckOutcomeSchema,
  exitCode: Type.Number(),
  stdoutHead: Type.Optional(Type.String()),
  stderrHead: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number()),
}, { additionalProperties: false });

export const CommandEvidenceSchema = Type.Object({
  kind: Type.Literal("command"),
  featureId: Type.String(),
  ts: Type.String(),
  checkResults: Type.Record(Type.String(), CommandCheckResultSchema),
  summary: Type.String(),
  because: Type.String(),
}, { additionalProperties: false });

const BlockingIssueSchema = Type.Object({
  file: Type.String(),
  line: Type.Number(),
  description: Type.String(),
}, { additionalProperties: false });

export const ReviewEvidenceSchema = Type.Object({
  kind: Type.Literal("review"),
  featureId: Type.String(),
  round: Type.Number(),
  reviewedAt: Type.String(),
  subagentSessionId: Type.String(),
  commitId: Type.Optional(Type.String()),
  outcome: Type.Optional(OutcomeSchema),
  blockingIssues: Type.Array(BlockingIssueSchema),
  nonBlockingNotes: Type.Array(Type.String()),
  summary: Type.String(),
  because: Type.String(),
}, { additionalProperties: false });

const QaFindingSchema = Type.Object({
  description: Type.String(),
  severity: Type.Optional(Type.String()),
  file: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const QaArtifactSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("screenshot"),
    Type.Literal("video"),
    Type.Literal("playwright_trace"),
    Type.Literal("har"),
    Type.Literal("terminal_capture"),
    Type.Literal("console_log"),
    Type.Literal("server_log"),
    Type.Literal("http_trace"),
    Type.Literal("dom_snapshot"),
    Type.Literal("a11y_audit"),
    Type.Literal("diff"),
    Type.Literal("file"),
  ]),
  path: Type.String(),
  caption: Type.Optional(Type.String({ maxLength: 280 })),
}, { additionalProperties: false });

export const QaEvidenceSchema = Type.Object({
  kind: Type.Literal("qa"),
  featureId: Type.String(),
  milestone: Type.String(),
  surfaces: Type.Array(Type.String()),
  outcome: OutcomeSchema,
  artifacts: Type.Array(QaArtifactSchema),
  findings: Type.Array(QaFindingSchema),
  summary: Type.String(),
  because: Type.String(),
}, { additionalProperties: false });

export const ReadinessEvidenceSchema = Type.Object({
  kind: Type.Literal("readiness"),
  featureId: Type.String(),
  probeResult: Type.Union([
    Type.Literal("verified"),
    Type.Literal("deferred-with-fallback"),
    Type.Literal("blocking"),
  ]),
  outcome: Type.Optional(OutcomeSchema),
  probedAt: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
  summary: Type.String(),
  because: Type.String(),
}, { additionalProperties: false });

export const EvidenceFileSchema = Type.Union([
  CommandEvidenceSchema,
  ReviewEvidenceSchema,
  QaEvidenceSchema,
  ReadinessEvidenceSchema,
]);

export type CommandEvidence = Static<typeof CommandEvidenceSchema>;
export type ReviewEvidence = Static<typeof ReviewEvidenceSchema>;
export type QaEvidence = Static<typeof QaEvidenceSchema>;
export type ReadinessEvidence = Static<typeof ReadinessEvidenceSchema>;
export type EvidenceFile = Static<typeof EvidenceFileSchema>;
export type EvidenceKind = EvidenceFile["kind"];

export type ValidateEvidenceFileResult =
  | { ok: true; value: EvidenceFile }
  | { ok: false; error: string };

const schemasByKind = {
  command: CommandEvidenceSchema,
  review: ReviewEvidenceSchema,
  qa: QaEvidenceSchema,
  readiness: ReadinessEvidenceSchema,
} as const;

export function validateEvidenceFile(json: unknown): ValidateEvidenceFileResult {
  const kind = getEvidenceKind(json);
  if (!isEvidenceKind(kind)) {
    return { ok: false, error: `Unknown evidence kind: ${String(kind ?? "<missing>")}` };
  }

  if (kind === "qa" && hasOwnProperty(json, "screenshots")) {
    return { ok: false, error: "qa evidence uses legacy screenshots[] field; migrate to artifacts:[{kind, path, caption?}]" };
  }

  const schema = schemasByKind[kind];
  if (Check(schema, json)) {
    if (kind === "qa") {
      const pathError = validateQaArtifactPaths(json as QaEvidence);
      if (pathError) return { ok: false, error: pathError };
    }
    return { ok: true, value: json as EvidenceFile };
  }

  const [first] = Errors(schema, json);
  const missing = (first?.params as { requiredProperties?: unknown } | undefined)?.requiredProperties;
  const [missingField] = Array.isArray(missing) ? missing : [];
  const fieldPath = typeof missingField === "string" ? `/${missingField}` : first?.instancePath || "/";
  const message = first?.message ?? "schema validation failed";
  return { ok: false, error: `Invalid ${kind} evidence at ${fieldPath}: ${message}` };
}

function getEvidenceKind(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  return (json as { kind?: unknown }).kind;
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function validateQaArtifactPaths(evidence: QaEvidence): string | undefined {
  for (let index = 0; index < evidence.artifacts.length; index += 1) {
    const path = evidence.artifacts[index]!.path;
    if (path.startsWith("/")) {
      return `Invalid qa evidence at /artifacts/${index}/path: artifact path must be relative`;
    }
    if (path.split("/").includes("..")) {
      return `Invalid qa evidence at /artifacts/${index}/path: artifact path must not contain '..' segments`;
    }
  }
  return undefined;
}

function isEvidenceKind(kind: unknown): kind is EvidenceKind {
  return typeof kind === "string" && kind in schemasByKind;
}
