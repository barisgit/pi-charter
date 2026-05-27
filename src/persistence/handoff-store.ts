import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const SuccessStateSchema = Type.Union([
  Type.Literal("success"),
  Type.Literal("partial"),
  Type.Literal("failure"),
]);

const IssueSeveritySchema = Type.Union([
  Type.Literal("blocking"),
  Type.Literal("non_blocking"),
  Type.Literal("suggestion"),
]);

const IssueKindSchema = Type.Union([
  Type.Literal("discovered_issue"),
  Type.Literal("critical_context"),
  Type.Literal("incomplete_work"),
]);

const TriageStateSchema = Type.Union([
  Type.Literal("untriaged"),
  Type.Literal("triaged"),
]);

const HandoffCommandRunSchema = Type.Object({
  command: Type.String(),
  exitCode: Type.Number(),
  observation: Type.String(),
}, { additionalProperties: false });

const HandoffDiscoveredIssueInputSchema = Type.Object({
  severity: IssueSeveritySchema,
  kind: IssueKindSchema,
  description: Type.String(),
  suggestedFix: Type.Optional(Type.String()),
  triageState: Type.Optional(TriageStateSchema),
}, { additionalProperties: false });

const HandoffDiscoveredIssueSchema = Type.Object({
  severity: IssueSeveritySchema,
  kind: IssueKindSchema,
  description: Type.String(),
  suggestedFix: Type.Optional(Type.String()),
  triageState: TriageStateSchema,
}, { additionalProperties: false });

const HandoffSkillDeviationSchema = Type.Object({
  step: Type.String(),
  whatIDidInstead: Type.String(),
  why: Type.String(),
}, { additionalProperties: false });

const HandoffVerificationSchema = Type.Object({
  commandsRun: Type.Array(HandoffCommandRunSchema),
}, { additionalProperties: false });

const HandoffSkillFeedbackSchema = Type.Object({
  followedProcedure: Type.Boolean(),
  deviations: Type.Array(HandoffSkillDeviationSchema),
  suggestedChanges: Type.Array(Type.String()),
}, { additionalProperties: false });

export const HandoffRecordInputProperties = {
  sessionId: Type.String(),
  featureId: Type.String(),
  agent: Type.String(),
  startedAt: Type.String(),
  completedAt: Type.String(),
  successState: SuccessStateSchema,
  validatorsPassed: Type.Boolean(),
  commitId: Type.Optional(Type.String()),
  repoPath: Type.Optional(Type.String()),
  fulfills: Type.Array(Type.String()),
  whatWasImplemented: Type.String({ minLength: 50 }),
  whatWasLeftUndone: Type.String(),
  verification: HandoffVerificationSchema,
  discoveredIssues: Type.Array(HandoffDiscoveredIssueInputSchema),
  skillFeedback: HandoffSkillFeedbackSchema,
} as const;

export const HandoffRecordProperties = {
  ...HandoffRecordInputProperties,
  discoveredIssues: Type.Array(HandoffDiscoveredIssueSchema),
} as const;

export const HandoffRecordInputSchema = Type.Object(HandoffRecordInputProperties, { additionalProperties: false });
export const HandoffRecordSchema = Type.Object(HandoffRecordProperties, { additionalProperties: false });

export type HandoffRecordInput = Static<typeof HandoffRecordInputSchema>;
export type HandoffRecord = Static<typeof HandoffRecordSchema>;

export type ValidateHandoffRecordResult =
  | { ok: true; value: HandoffRecord }
  | { ok: false; error: string };

export function validateHandoffRecord(json: unknown): ValidateHandoffRecordResult {
  if (!Check(HandoffRecordInputSchema, json)) {
    return { ok: false, error: formatSchemaError(HandoffRecordInputSchema, json) };
  }
  const normalized = normalizeHandoffRecord(json as HandoffRecordInput);
  if (!Check(HandoffRecordSchema, normalized)) {
    return { ok: false, error: formatSchemaError(HandoffRecordSchema, normalized) };
  }
  return { ok: true, value: normalized };
}

function normalizeHandoffRecord(input: HandoffRecordInput): HandoffRecord {
  return {
    ...input,
    discoveredIssues: input.discoveredIssues.map((issue) => ({
      ...issue,
      triageState: issue.triageState ?? "untriaged",
    })),
  };
}

function formatSchemaError(schema: typeof HandoffRecordInputSchema | typeof HandoffRecordSchema, json: unknown): string {
  const [first] = Errors(schema, json);
  const missing = (first?.params as { requiredProperties?: unknown } | undefined)?.requiredProperties;
  const [missingField] = Array.isArray(missing) ? missing : [];
  const fieldPath = typeof missingField === "string" ? `/${missingField}` : first?.instancePath || "/";
  const message = first?.message ?? "schema validation failed";
  return `Invalid handoff record at ${fieldPath}: ${message}`;
}
