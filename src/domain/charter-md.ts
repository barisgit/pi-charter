import type { CharterCriterion, ParsedCharterMarkdown, ParseWarning, VerifierKind } from "./types";

const DEFAULT_VERIFIER: VerifierKind = "manual";

export function renderInitialCharterMarkdown(objective: string): string {
  // The initial template doubles as a worked example. The parser only recognizes
  // criteria written as `### VAL-<ID>` H3 headings with `Verifier:`/`Description:`
  // /`Fresh evidence required:` field lines beneath; bullet lists are NOT parsed.
  // Showing one full criterion makes the convention discoverable without forcing
  // the agent to read the skill before authoring.
  return [
    "# Charter",
    "",
    "## Objective",
    "",
    objective.trim(),
    "",
    "## Criteria",
    "",
    "<!--",
    "Replace the example below with real VAL-* criteria for this charter.",
    "",
    "Format (strict — parsed by pi-charter):",
    "  ### VAL-<UPPER-SNAKE-OR-NUMERIC-ID> <short title>",
    "  Description: <one-line outcome statement>",
    "  Verifier: <manual|command|hook|prompt>",
    "  Command: <shell command if Verifier: command>",
    "  Fresh evidence required: <true|false>",
    "  Review subagent required: <true|false>",
    "",
    "Notes:",
    "  - Bullet lists (`- VAL-1: ...`) are IGNORED. Use ### VAL- H3 headings.",
    "  - Every VAL-* id you list here must be the fulfills= target of at least one",
    "    feature added via charter_plan action=add_feature.",
    "-->",
    "",
    "### VAL-EXAMPLE Example criterion (delete me)",
    "Description: Replace this example with the real outcome you want verified.",
    "Verifier: manual",
    "Fresh evidence required: false",
    "",
    "## Scope and constraints",
    "",
    "<!-- One bullet per scope or constraint, e.g. \"- Do not modify the public API.\" -->",
    "",
  ].join("\n");
}

export interface ParseCharterOptions {
  /**
   * When true, criteria missing a `Verifier:` line still parse but the
   * resulting warning is non-fatal at lock_plan time. Defaults to false.
   * The legacy flag does not suppress the warning itself — callers that
   * care (lock_plan) read `parseOptions.legacy` to decide whether to BLOCK.
   */
  legacy?: boolean;
}

export function parseCharterMarkdown(markdown: string, _options: ParseCharterOptions = {}): ParsedCharterMarkdown {
  // `_options.legacy` is currently a marker for downstream consumers (lock_plan);
  // the parser itself always emits the same warning set so the caller can decide.
  void _options;
  const sections = splitH2Sections(markdown);
  const objective = cleanBlock(sections.get("objective") ?? "");
  const warnings: ParseWarning[] = [];
  const criteria = parseCriteria(sections.get("criteria") ?? "", warnings);
  const constraints = parseConstraints(sections.get("scope and constraints") ?? "");
  return { objective, criteria, constraints, warnings };
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

function parseCriteria(section: string, warnings: ParseWarning[]): CharterCriterion[] {
  const criteria: CharterCriterion[] = [];
  const lines = section.split(/\r?\n/);
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentHeading) return;
    const parsed = parseCriterion(currentHeading, buffer.join("\n"), warnings);
    if (parsed) criteria.push(parsed);
  };

  for (const line of lines) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
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
  if (verifierRaw === "manual" && !because) {
    warnings.push({ criterionId: headingMatch[1], reason: "missing-because" });
  }
  return {
    id: headingMatch[1],
    title: headingMatch[2]?.trim() || headingMatch[1],
    description: fields.get("description"),
    verifier: parseVerifier(verifierRaw),
    command: commandValue?.trim() ? commandValue.trim() : undefined,
    requireFreshEvidence: parseBoolean(
      fields.get("fresh evidence required") ?? fields.get("require fresh evidence"),
      false,
    ),
    requireReviewSubagent: parseBoolean(
      fields.get("review subagent required") ?? fields.get("require review subagent"),
      false,
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

function parseConstraints(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseVerifier(value: string | undefined): VerifierKind {
  if (value === "command" || value === "hook" || value === "prompt" || value === "manual") return value;
  return DEFAULT_VERIFIER;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return fallback;
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
