import { validateVerifier, type Verifier, type VerifierKind } from "./verifier";
import type { CharterCommands, CharterCriterion, ParsedCharterMarkdown, ParseWarning } from "./types";

const DEFAULT_VERIFIER: VerifierKind = "manual";

export function renderInitialCharterMarkdown(objective: string, name = "Untitled"): string {
  return [
    `# Charter: ${name.trim() || "Untitled"}`,
    "",
    "## Objective",
    "",
    objective.trim(),
    "",
    "## Scope and constraints",
    "",
    "<!-- One bullet per scope or constraint, e.g. \"- Do not modify the public API.\" -->",
    "",
    "## Mission Boundaries (NEVER VIOLATE)",
    "",
    "- DO NOT delete .gitignore, .editorconfig, or other top-level dotfiles.",
    "- DO NOT create duplicate root-level docs (e.g. SPEC.md at root AND docs/).",
    "- Charter UUID, feature IDs, VAL IDs MAY NEVER appear hardcoded in committed scripts.",
    "- <project-specific boundaries: port ranges, off-limits paths, never-modify dirs>",
    "- Workers: If you cannot complete your work within these boundaries, return to orchestrator. Never violate boundaries.",
    "",
    "## Commands",
    "",
    "test: <e.g. bun test>",
    "typecheck: <e.g. bun run check-types>",
    "lint: <e.g. bun run lint>",
    "",
  ].join("\n");
}

export function renderInitialCriteriaMarkdown(name = "Untitled"): string {
  // The initial criteria template doubles as a worked example. The parser
  // recognizes criteria written as `## VAL-<ID>` headings in criteria.md. For
  // migration grace, it also accepts the old charter.md `## Criteria` wrapper
  // with `### VAL-<ID>` H3 headings when criteria.md is absent.
  return [
    `# Criteria for ${name.trim() || "Untitled"}`,
    "",
    "<!--",
    "Replace the example below with real VAL-* criteria for this charter.",
    "",
    "Format (strict — parsed by pi-charter):",
    "  ## VAL-<UPPER-SNAKE-OR-NUMERIC-ID> <short title>",
    "  <behavioral statement>",
    "  Verifier: <command|review|qa|readiness|evidence-exists>",
    "  Command: <shell command if Verifier: command>",
    "  Because: <required for manual verifier>",
    "  RequireFreshEvidence: <true|false>",
    "  RequireReviewSubagent: <true|false>",
    "",
    "Notes:",
    "  - Bullet lists (`- VAL-1: ...`) are IGNORED. Use ## VAL- headings.",
    "  - Every VAL-* id you list here must be the fulfills= target of at least one",
    "    feature added via charter_plan action=add_feature.",
    "-->",
    "",
    "## VAL-EXAMPLE Example criterion (delete me)",
    "Replace this example with the real outcome you want verified.",
    "",
    "Verifier: command",
    "Command: <e.g. bun test tests/example.test.ts>",
    "RequireFreshEvidence: false",
    "RequireReviewSubagent: false",
    "",
  ].join("\n");
}

function parseCommands(section: string, warnings: ParseWarning[]): CharterCommands {
  const commands: CharterCommands = {};
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;
    const match = /^([^:]+):\s*(.*?)\s*$/.exec(line);
    if (!match) {
      warnings.push({ reason: "malformed-command", section: "commands", line });
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!key) {
      warnings.push({ reason: "malformed-command", section: "commands", line });
      continue;
    }
    if (!value) {
      warnings.push({ reason: "malformed-command", section: "commands", key });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(commands, key)) {
      warnings.push({ reason: "duplicate-command", section: "commands", key });
    }
    commands[key] = value;
  }
  return commands;
}

export interface ParseCharterOptions {
  /**
   * When true, criteria missing a `Verifier:` line still parse but the
   * resulting warning is non-fatal at lock_plan time. Defaults to false.
   * The legacy flag does not suppress the warning itself — callers that
   * care (lock_plan) read `parseOptions.legacy` to decide whether to BLOCK.
   */
  legacy?: boolean;
  /**
   * Sibling criteria.md contents. When present, criteria are parsed from this
   * file and any legacy `## Criteria` section in charter.md is ignored.
   */
  criteriaMarkdown?: string;
}

export function parseCharterMarkdown(markdown: string, _options: ParseCharterOptions = {}): ParsedCharterMarkdown {
  // `_options.legacy` is currently a marker for downstream consumers (lock_plan);
  // the parser itself always emits the same warning set so the caller can decide.
  void _options.legacy;
  const sections = splitH2Sections(markdown);
  const objective = cleanBlock(sections.get("objective") ?? "");
  const warnings: ParseWarning[] = [];
  const criteria = _options.criteriaMarkdown !== undefined
    ? parseCriteriaMarkdown(_options.criteriaMarkdown, warnings)
    : parseCriteria(sections.get("criteria") ?? "", warnings);
  const constraints = parseConstraints(sections.get("scope and constraints") ?? "");
  const commands = sections.has("commands") ? parseCommands(sections.get("commands") ?? "", warnings) : {};
  const qaSection = sections.has("qa") ? sections.get("qa") : undefined;
  const readinessSection = sections.has("readiness") ? sections.get("readiness") : undefined;
  return { objective, criteria, constraints, commands, qaSection, readinessSection, warnings };
}

function splitH2Sections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) sections.set(current, buffer.join("\n"));
      current = normalizeHeading(match[1]);
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) sections.set(current, buffer.join("\n"));
  return sections;
}

export function parseCriteriaMarkdown(markdown: string, warnings: ParseWarning[] = []): CharterCriterion[] {
  const criteria = parseCriteriaByHeadingLevel(markdown, warnings, 2);
  if (criteria.length > 0) return criteria;

  const sections = splitH2Sections(markdown);
  if (sections.has("criteria")) return parseCriteria(sections.get("criteria") ?? "", warnings);

  return parseCriteria(markdown, warnings);
}

function parseCriteria(section: string, warnings: ParseWarning[]): CharterCriterion[] {
  return parseCriteriaByHeadingLevel(section, warnings, 3);
}

function parseCriteriaByHeadingLevel(section: string, warnings: ParseWarning[], headingLevel: 2 | 3): CharterCriterion[] {
  const criteria: CharterCriterion[] = [];
  const lines = section.split(/\r?\n/);
  let currentHeading: string | undefined;
  let buffer: string[] = [];
  const headingRe = headingLevel === 2 ? /^##\s+(.+?)\s*$/ : /^###\s+(.+?)\s*$/;

  const flush = () => {
    if (!currentHeading) return;
    const parsed = parseCriterion(currentHeading, buffer.join("\n"), warnings);
    if (parsed) criteria.push(parsed);
  };

  for (const line of lines) {
    const match = headingRe.exec(line);
    if (match) {
      flush();
      currentHeading = match[1].trim();
      buffer = [];
      continue;
    }
    if (currentHeading) buffer.push(line);
  }
  flush();
  return criteria;
}

function parseCriterion(heading: string, body: string, warnings: ParseWarning[]): CharterCriterion | undefined {
  const headingMatch = /^(VAL-[A-Z0-9-]+)\s*(?:[—-]\s*)?(.*)$/.exec(heading);
  if (!headingMatch) return undefined;

  const fields = parseFields(body);
  const commandValue = fields.get("command");
  const verifierRaw = fields.get("verifier");
  if (verifierRaw === undefined) {
    warnings.push({ criterionId: headingMatch[1], reason: "missing-verifier" });
  }
  const becauseRaw = fields.get("because");
  const because = becauseRaw?.trim() ? becauseRaw.trim() : undefined;
  // Author-time rationale is required for manual verifiers; the lock_plan
  // weak-verifier check uses this warning as the BLOCK signal.
  if (verifierRaw?.trim().toLowerCase() === "manual" && !because) {
    warnings.push({ criterionId: headingMatch[1], reason: "missing-because" });
  }
  const verifierSpec = parseVerifier(verifierRaw, fields, commandValue, headingMatch[1]);
  const description = fields.get("description") ?? parseBodyDescription(body);
  return {
    id: headingMatch[1],
    title: headingMatch[2]?.trim() || headingMatch[1],
    description,
    verifier: verifierSpec.kind,
    verifierSpec,
    command: commandValue?.trim() ? commandValue.trim() : undefined,
    requireFreshEvidence: parseBoolean(
      fields.get("fresh evidence required") ?? fields.get("require fresh evidence") ?? fields.get("requirefreshevidence"),
      false,
    ),
    requireReviewSubagent: parseOptionalBoolean(
      fields.get("review subagent required") ?? fields.get("require review subagent") ?? fields.get("requirereviewsubagent"),
    ),
    because,
  };
}

function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z ]+):\s*(.*?)\s*$/.exec(line.trim());
    if (!match) continue;
    fields.set(normalizeHeading(match[1]), match[2]);
  }
  return fields;
}

function parseBodyDescription(body: string): string | undefined {
  const lines: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) {
      if (lines.length > 0) break;
      continue;
    }
    if (isFieldLine(line)) break;
    lines.push(line);
  }
  const description = lines.join(" ").trim();
  return description || undefined;
}

function isFieldLine(line: string): boolean {
  return /^([A-Za-z][A-Za-z ]+):\s*(.*?)\s*$/.test(line.trim());
}

function parseConstraints(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseVerifier(
  value: string | undefined,
  fields: Map<string, string>,
  commandValue: string | undefined,
  criterionId: string,
): Verifier {
  const kind = parseVerifierKind(value, criterionId);
  const evidenceKind = evidenceKindAlias(value);
  let verifier: unknown;
  switch (kind) {
    case "command":
      verifier = { kind, ...(commandValue?.trim() ? { command: commandValue.trim() } : {}) };
      break;
    case "manual":
    case "hook":
    case "prompt":
      verifier = { kind };
      break;
    case "subagent":
      verifier = {
        kind,
        agent: fields.get("agent")?.trim(),
        task: fields.get("task")?.trim(),
      };
      break;
    case "evidence-exists":
      verifier = {
        kind,
        evidenceKind: fields.get("kind")?.trim() ?? evidenceKind,
        ...(fields.get("freshsince")?.trim() ? { freshSince: fields.get("freshsince")!.trim() } : {}),
      };
      break;
    default:
      return assertNever(kind);
  }

  const result = validateVerifier(verifier);
  if (result.ok) return result.value;
  throw new Error(`Invalid verifier for ${criterionId}: ${result.error}`);
}

function parseVerifierKind(value: string | undefined, criterionId: string): VerifierKind {
  if (value === undefined) return DEFAULT_VERIFIER;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "command" ||
    normalized === "hook" ||
    normalized === "prompt" ||
    normalized === "manual" ||
    normalized === "subagent" ||
    normalized === "evidence-exists"
  ) return normalized;
  if (normalized === "review" || normalized === "qa" || normalized === "readiness") return "evidence-exists";
  throw new Error(`Unknown verifier kind for ${criterionId}: ${value}`);
}

function evidenceKindAlias(value: string | undefined): "review" | "qa" | "readiness" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "review" || normalized === "qa" || normalized === "readiness") return normalized;
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled verifier kind: ${String(value)}`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return fallback;
}

/**
 * Like `parseBoolean` but returns `undefined` when the field line is omitted
 * entirely (or has an unrecognized value). Used for `requireReviewSubagent`
 * so the completion gate can distinguish "author wrote `false`" from
 * "author wrote nothing", and auto-default the omitted case to true when
 * the criterion is covered by a `milestone_ready_for_review` event.
 */
function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return undefined;
}

function cleanBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
    .join("\n")
    .trim();
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
