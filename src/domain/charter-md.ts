import { validateVerifier, type Verifier, type VerifierKind } from "./verifier";
import type { CharterCommands, CharterCriterion, CharterMilestone, ParsedCharterMarkdown, ParseWarning } from "./types";

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
  // v3 criteria.md uses ## milestone headings with ### VAL-* leaves.
  // Flat ## VAL-* headings remain supported for legacy charters.
  return [
    `# Criteria for ${name.trim() || "Untitled"}`,
    "",
    "<!--",
    "Replace the example below with real milestones and VAL-* criteria.",
    "",
    "Format (strict — parsed by pi-charter):",
    "  ## <milestone-id> <optional title>",
    "  ### VAL-<UPPER-SNAKE-OR-NUMERIC-ID> <short title>",
    "  <behavioral statement>",
    "  Verifier: <command|manual|hook|prompt|subagent|evidence-exists>",
    "  Command: <shell command if Verifier: command>",
    "  Because: <required for manual verifier>",
    "  RequireFreshEvidence: <true|false>",
    "  RequireReviewSubagent: <true|false>",
    "-->",
    "",
    "## m0-example Example milestone (delete me)",
    "",
    "### VAL-EXAMPLE Example criterion (delete me)",
    "Replace this example with the real outcome you want verified.",
    "",
    "Verifier: command",
    "Command: <behavior-level: a whole test file/glob or a real command, e.g. bun test tests/example.test.ts — NOT bun test -t '<title>'>",
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
  [key: string]: unknown;
  /**
   * Sibling criteria.md contents. When present, criteria are parsed from this
   * file and any legacy `## Criteria` section in charter.md is ignored.
   */
  criteriaMarkdown?: string;
}

export function parseCharterMarkdown<T extends ParseCharterOptions>(markdown: string, _options: T = {} as T): ParsedCharterMarkdown {
  const sections = splitH2Sections(markdown);
  const objective = cleanBlock(sections.get("objective") ?? "");
  const warnings: ParseWarning[] = [];
  const { criteria, milestones } = _options.criteriaMarkdown !== undefined
    ? parseCriteriaMarkdown(_options.criteriaMarkdown, warnings)
    : (() => {
      const legacy = parseCriteriaWithMilestones(sections.get("criteria") ?? "", warnings, 3);
      if (legacy.criteria.length > 0) return legacy;
      return {
        criteria: parseCriteria(sections.get("criteria") ?? "", warnings),
        milestones: [],
      };
    })();
  const constraints = parseConstraints(sections.get("scope and constraints") ?? "");
  const commands = sections.has("commands") ? parseCommands(sections.get("commands") ?? "", warnings) : {};
  const qaSection = sections.has("qa") ? sections.get("qa") : undefined;
  const readinessSection = sections.has("readiness") ? sections.get("readiness") : undefined;
  return { objective, criteria, milestones, constraints, commands, qaSection, readinessSection, warnings };
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

const VAL_HEADING_RE = /^VAL-[A-Z0-9-]+/;

export interface ParsedCriteriaMarkdown {
  criteria: CharterCriterion[];
  milestones: CharterMilestone[];
}

export function parseCriteriaMarkdown(markdown: string, warnings: ParseWarning[] = []): ParsedCriteriaMarkdown {
  const fromMilestones = parseCriteriaWithMilestones(markdown, warnings, 2);
  if (fromMilestones.criteria.length > 0) return fromMilestones;

  const sections = splitH2Sections(markdown);
  if (sections.has("criteria")) {
    return parseCriteriaWithMilestones(sections.get("criteria") ?? "", warnings, 3);
  }

  return {
    criteria: parseCriteriaByHeadingLevel(markdown, warnings, 3),
    milestones: [],
  };
}

function parseCriteria(section: string, warnings: ParseWarning[]): CharterCriterion[] {
  return parseCriteriaByHeadingLevel(section, warnings, 3);
}

function parseCriteriaWithMilestones(
  markdown: string,
  warnings: ParseWarning[],
  valHeadingLevel: 2 | 3,
): ParsedCriteriaMarkdown {
  const sections = splitCriteriaH2Sections(markdown);
  if (sections.length === 0) return { criteria: [], milestones: [] };

  const criteria: CharterCriterion[] = [];
  const milestones: CharterMilestone[] = [];
  for (const section of sections) {
    const heading = section.heading.trim();
    if (VAL_HEADING_RE.test(heading)) {
      const parsed = parseCriterion(heading, section.body, warnings);
      if (parsed) criteria.push(parsed);
      continue;
    }
    const milestoneCriteria = parseCriteriaByHeadingLevel(section.body, warnings, valHeadingLevel === 2 ? 3 : 3);
    if (milestoneCriteria.length === 0) continue;
    const { id, title } = milestoneHeadingParts(heading);
    const criterionIds = milestoneCriteria.map((criterion) => criterion.id);
    criteria.push(...milestoneCriteria);
    milestones.push({ id, title, criterionIds });
  }
  return { criteria, milestones };
}

function splitCriteriaH2Sections(markdown: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const h1 = /^#\s+/.exec(line);
    if (h1) {
      if (currentHeading) sections.push({ heading: currentHeading, body: buffer.join("\n") });
      currentHeading = undefined;
      buffer = [];
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (currentHeading) sections.push({ heading: currentHeading, body: buffer.join("\n") });
      currentHeading = h2[1].trim();
      buffer = [];
      continue;
    }
    if (currentHeading) buffer.push(line);
  }
  if (currentHeading) sections.push({ heading: currentHeading, body: buffer.join("\n") });
  return sections;
}

function milestoneHeadingParts(heading: string): { id: string; title: string } {
  const trimmed = heading.trim();
  const id = trimmed.split(/\s+/)[0] ?? trimmed;
  return { id, title: trimmed };
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
  const verifierSpec = parseVerifier(verifierRaw, fields, commandValue, headingMatch[1], warnings);
  if (verifierSpec.kind === "command" && isPhraseCoupledTestCommand(commandValue)) {
    warnings.push({
      criterionId: headingMatch[1],
      reason: "weak-verifier-phrase-coupled",
      detail: "command filters tests by title (-t/--test-name-pattern) without a file/glob; this couples the VAL to a brittle test name and passes silently on 0 matches. Verify a behavior at file/glob/observable-command level instead.",
    });
  }
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

/**
 * Detect the phrase-coupled test anti-pattern: a command verifier that selects
 * tests by TITLE (`-t '<phrase>'` / `--test-name-pattern`) without naming a test
 * FILE or GLOB. That form couples the VAL to one implementer's test title and,
 * worst of all, EXITS 0 when zero tests match. Behavior-level verifiers (a whole
 * file/glob, or a real observable command) fail on absence for free. Conservative
 * string heuristic — no execution, no test-runner output parsing.
 */
export function isPhraseCoupledTestCommand(command: string | undefined): boolean {
  const raw = command?.trim();
  if (!raw) return false;
  // Tokenize quote-aware (so a separator or file-looking token INSIDE a quoted
  // title phrase does not mis-split the command or mask the warning), splitting
  // into shell segments on unquoted && || ; | & and newlines. A phrase-coupled
  // run chained with a real file run stays flagged on its weak segment.
  return splitShellSegments(raw).some(isPhraseCoupledSegment);
}

// Title-filter flags common to most runners. `-t` is added per-runner below
// because in Mocha `-t` is `--timeout`, not a title filter.
const TITLE_FLAGS_COMMON = new Set(["-g", "--grep", "--test-name-pattern", "--testNamePattern"]);
// Options whose VALUE is a config/setup path, not a test selector — their value
// must not be mistaken for behavior-level file coverage.
const PATH_OPTION_FLAGS = new Set(["--config", "-c", "--preload", "--require", "-r", "--reporter", "--setupFiles", "--setup"]);

function isPhraseCoupledSegment(tokens: string[]): boolean {
  const runner = detectRunner(tokens);
  if (!runner) return false;
  const titleFlags = new Set(TITLE_FLAGS_COMMON);
  if (runner.name !== "mocha") titleFlags.add("-t"); // bun/jest/vitest use -t for title

  // Walk only the ARGS (after the runner subcommand), so env prefixes and the
  // `bun test` literal are never mistaken for file coverage. Classify each
  // token: title flag (consumes its value), path-option flag (consumes its
  // value), other flag (boolean, skipped), or positional (file/glob check).
  let hasTitleFilter = false;
  let hasFileOrGlob = false;
  const args = tokens.slice(runner.argStart);
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const eq = tok.indexOf("=");
    const flag = tok.startsWith("-") ? (eq === -1 ? tok : tok.slice(0, eq)) : undefined;
    if (flag && titleFlags.has(flag)) {
      hasTitleFilter = true;
      if (eq === -1 && i + 1 < args.length && !args[i + 1].startsWith("-")) i++; // consume value
      continue;
    }
    if (flag && PATH_OPTION_FLAGS.has(flag)) {
      if (eq === -1 && i + 1 < args.length && !args[i + 1].startsWith("-")) i++; // consume path value
      continue;
    }
    if (flag) continue; // boolean / unknown flag
    if (/(\.[cm]?[jt]sx?$|\.test\b|\.spec\b|\/|[*?{])/.test(tok)) hasFileOrGlob = true; // positional file/glob
  }
  return hasTitleFilter && !hasFileOrGlob;
}

/**
 * Detect a test runner from the command head (after env assignments) and return
 * its name plus the token index where its ARGS begin. Returns undefined when the
 * segment is not a recognized test-runner invocation.
 */
function detectRunner(tokens: string[]): { name: string; argStart: number } | undefined {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // skip FOO=1 prefixes
  const t0 = tokens[i], t1 = tokens[i + 1], t2 = tokens[i + 2];
  if (!t0) return undefined;
  if (t0 === "vitest" || t0 === "jest" || t0 === "mocha") return { name: t0, argStart: i + 1 };
  if (t0 === "bun" || t0 === "npm" || t0 === "pnpm" || t0 === "yarn") {
    if (t1 === "test") return { name: t0, argStart: i + 2 };
    if (t1 === "run" && t2 === "test") return { name: t0, argStart: i + 3 };
    return undefined;
  }
  if (t0 === "deno" && t1 === "test") return { name: "deno", argStart: i + 2 };
  if (t0 === "playwright" && t1 === "test") return { name: "playwright", argStart: i + 2 };
  if (t0 === "node" && tokens.slice(i).includes("--test")) return { name: "node", argStart: i + 1 };
  if (t0 === "npx" && (t1 === "vitest" || t1 === "jest" || t1 === "mocha" || t1 === "playwright")) {
    return { name: t1, argStart: t1 === "playwright" && t2 === "test" ? i + 3 : i + 2 };
  }
  return undefined;
}

/** Quote-aware split into shell segments, each a list of tokens. */
function splitShellSegments(raw: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  const endToken = () => { if (hasToken) { current.push(token); token = ""; hasToken = false; } };
  const endSegment = () => { endToken(); if (current.length) { segments.push(current); current = []; } };
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'" || c === "\"") {
      const close = raw.indexOf(c, i + 1);
      const end = close === -1 ? raw.length : close;
      token += raw.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
      continue;
    }
    if (c === "\n" || c === "\r") { endSegment(); i++; continue; }
    if (c === " " || c === "\t") { endToken(); i++; continue; }
    if ((c === "&" && raw[i + 1] === "&") || (c === "|" && raw[i + 1] === "|")) { endSegment(); i += 2; continue; }
    if (c === ";" || c === "|" || c === "&") { endSegment(); i++; continue; }
    token += c; hasToken = true; i++;
  }
  endSegment();
  return segments;
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
  warnings: ParseWarning[],
): Verifier {
  const kind = parseVerifierKind(value, criterionId, warnings);
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
  // Recoverable authoring mistake: a present-but-incomplete verifier (for
  // example `Verifier: subagent` with no Agent/Task lines). Degrade to a safe
  // manual verifier and surface a warning instead of throwing. A throw here
  // propagates up through loadParsedCharter (whose callers swallow it into
  // empty defaults), which would silently zero EVERY criterion in the
  // register over one malformed entry. Independent flags such as
  // requireReviewSubagent still apply to the degraded criterion.
  warnings.push({ criterionId, reason: "invalid-verifier", detail: result.error });
  return { kind: "manual" };
}

function parseVerifierKind(value: string | undefined, criterionId: string, warnings: ParseWarning[]): VerifierKind {
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
  // Unknown kind (typo, unsupported value): degrade to the default verifier
  // and warn rather than throwing and zeroing the whole register.
  warnings.push({ criterionId, reason: "invalid-verifier", detail: `Unknown verifier kind: ${value}` });
  return DEFAULT_VERIFIER;
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
