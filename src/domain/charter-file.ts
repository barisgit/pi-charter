/**
 * charter.md parser (ADR-0014/0015: the file is the interface).
 *
 * Tolerant by doctrine: unknown structure is inert prose, breakage is a
 * warning, never an error. Parsing never blocks status-side work.
 *
 * Grammar (everything else is inert):
 *   ## Objective                                           — required prose
 *   ## References                                          — optional durable pointers
 *   ## Scope                                               — optional prose boundaries
 *   ## Criteria                                            — required section marker
 *   ### C<n>. <title>                                      — one heading per criterion
 *   Depends: C1, C2                                        — optional, advisory only
 *   Status: pending|in-progress|blocked|pass|fail — <note> — one per criterion
 *
 * Existing Evidence lines are accepted only as a legacy input alias. New
 * charters and all parsed/runtime projections expose Status exclusively.
 * HTML comments are stripped before parsing so template guidance is inert.
 */

export type CriterionStatus = "pending" | "in-progress" | "blocked" | "pass" | "fail";

export interface ParsedCriterionStatus {
  value: CriterionStatus;
  note: string;
}

export interface ParsedCriterion {
  id: string; // "C1"
  title: string;
  /** Criterion prose with Depends and Status lines removed. */
  body: string;
  depends: string[];
  status: ParsedCriterionStatus;
  /** 1-based line number of the `### C<n>.` heading (post comment-strip). */
  line: number;
}

export interface ParsedCharterFile {
  objective: string;
  references: string;
  scope: string;
  criteria: ParsedCriterion[];
  /** No criteria authored: charter is open-ended, complete never legal. */
  openEnded: boolean;
  warnings: string[];
}

const CRITERION_HEADING = /^###\s+(C\d+)\.\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const LEVEL2_HEADING = /^##\s+(.+?)\s*$/;
const DEPENDS_LINE = /^Depends:\s*(.*)$/i;
const STATUS_LINE = /^Status:\s*(.*)$/i;
const LEGACY_EVIDENCE_LINE = /^Evidence:\s*(.*)$/i;

/** Strip HTML comments but keep line count stable for line attribution. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ""));
}

function parseStatusValue(raw: string, id: string, warnings: string[]): ParsedCriterionStatus {
  const match = raw.match(/^(\S+)\s*(?:[—–-]\s*)?(.*)$/);
  const token = (match?.[1] ?? "").toLowerCase();
  const note = (match?.[2] ?? "").trim();
  if (
    token === "pending" ||
    token === "in-progress" ||
    token === "blocked" ||
    token === "pass" ||
    token === "fail"
  ) {
    if (token === "pass" && note.length === 0) {
      warnings.push(
        `${id}: Status is "pass" with an empty note; completion requires evidence saying what was observed`,
      );
    }
    return { value: token, note };
  }
  if (raw.trim().length > 0) {
    warnings.push(
      `${id}: Status line must start with pending, in-progress, blocked, pass, or fail (got "${raw.trim().slice(0, 40)}"); treating as pending`,
    );
  }
  return { value: "pending", note: raw.trim() };
}

function parseLegacyEvidenceValue(raw: string, id: string, warnings: string[]): ParsedCriterionStatus {
  const match = raw.match(/^(\S+)\s*(?:[—–-]\s*)?([\s\S]*)$/);
  const token = (match?.[1] ?? "").toLowerCase();
  const note = (match?.[2] ?? "").trim();
  if (token === "pass" || token === "fail") {
    if (token === "pass" && note.length === 0) {
      warnings.push(
        `${id}: legacy pass evidence has an empty note; completion requires evidence saying what was observed`,
      );
    }
    return { value: token, note };
  }
  if (token === "none" || raw.trim().length === 0) return { value: "pending", note };
  warnings.push(
    `${id}: legacy Evidence line must start with pass, fail, or none (got "${raw.trim().slice(0, 40)}"); treating as pending`,
  );
  return { value: "pending", note: raw.trim() };
}

function sectionBody(lines: string[], name: string): { found: boolean; body: string } {
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(LEVEL2_HEADING);
    if (!heading || heading[1].toLowerCase() !== name.toLowerCase()) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !LEVEL2_HEADING.test(lines[j]); j++) {
      body.push(lines[j]);
    }
    return { found: true, body: body.join("\n").trim() };
  }
  return { found: false, body: "" };
}

export function parseCharterFile(text: string): ParsedCharterFile {
  const warnings: string[] = [];
  const lines = stripComments(text).split("\n");

  const objectiveSection = sectionBody(lines, "objective");
  const objective = objectiveSection.body;
  const references = sectionBody(lines, "references").body;
  const scope = sectionBody(lines, "scope").body;
  const sawCriteriaHeading = lines.some((line) => line.match(LEVEL2_HEADING)?.[1].toLowerCase() === "criteria");

  if (!objectiveSection.found) warnings.push("missing `## Objective` section");
  else if (objective.length === 0) warnings.push("`## Objective` section is empty");
  if (!sawCriteriaHeading) warnings.push("missing `## Criteria` section");

  const criteria: ParsedCriterion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(CRITERION_HEADING);
    if (!heading) continue;
    const id = heading[1];
    if (seen.has(id)) {
      warnings.push(`duplicate criterion id ${id}; later occurrence ignored`);
      continue;
    }
    seen.add(id);

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING.test(lines[j])) {
        end = j;
        break;
      }
    }

    let depends: string[] = [];
    let status: ParsedCriterionStatus | undefined;
    let legacyIndex = -1;
    let bodyLengthBeforeLegacy = 0;
    const bodyLines: string[] = [];
    for (let j = i + 1; j < end; j++) {
      const dependency = lines[j].match(DEPENDS_LINE);
      if (dependency) {
        depends = dependency[1]
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        continue;
      }
      const state = lines[j].match(STATUS_LINE);
      if (state) {
        if (status) warnings.push(`${id}: duplicate Status line; later occurrence ignored`);
        else status = parseStatusValue(state[1], id, warnings);
        continue;
      }
      if (LEGACY_EVIDENCE_LINE.test(lines[j])) {
        legacyIndex = j;
        bodyLengthBeforeLegacy = bodyLines.length;
        continue;
      }
      bodyLines.push(lines[j]);
    }

    if (legacyIndex >= 0) {
      if (status) {
        warnings.push(`${id}: both Status and legacy Evidence lines found; Status wins`);
      } else {
        const match = lines[legacyIndex].match(LEGACY_EVIDENCE_LINE)!;
        const rest = lines.slice(legacyIndex + 1, end).join("\n").trimEnd();
        status = parseLegacyEvidenceValue(rest ? `${match[1]}\n${rest}` : match[1], id, warnings);
        bodyLines.splice(bodyLengthBeforeLegacy);
      }
    }

    if (!status) {
      warnings.push(`${id}: missing Status line; treating as pending`);
      status = { value: "pending", note: "" };
    }

    criteria.push({
      id,
      title: heading[2],
      body: bodyLines.join("\n").trim(),
      depends,
      status,
      line: i + 1,
    });
  }

  const ids = new Set(criteria.map((criterion) => criterion.id));
  for (const criterion of criteria) {
    for (const dependency of criterion.depends) {
      if (!ids.has(dependency)) warnings.push(`${criterion.id}: Depends references unknown ${dependency}`);
      if (dependency === criterion.id) warnings.push(`${criterion.id}: Depends references itself`);
    }
  }
  detectCycles(criteria, warnings);

  return {
    objective,
    references,
    scope,
    criteria,
    openEnded: criteria.length === 0,
    warnings,
  };
}

function detectCycles(criteria: ParsedCriterion[], warnings: string[]): void {
  const edges = new Map(criteria.map((criterion) => [criterion.id, criterion.depends]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") {
      warnings.push(`dependency cycle: ${[...path, id].join(" -> ")}`);
      return true;
    }
    state.set(id, "visiting");
    for (const dependency of edges.get(id) ?? []) {
      if (edges.has(dependency) && visit(dependency, [...path, id])) {
        state.set(id, "done");
        return true;
      }
    }
    state.set(id, "done");
    return false;
  };
  for (const criterion of criteria) {
    if (visit(criterion.id, [])) return;
  }
}

/**
 * Ready-next advisory: non-pass criteria whose dependencies are all pass.
 * Advisory only; the agent may work on anything.
 */
export function readyCriteria(parsed: ParsedCharterFile): ParsedCriterion[] {
  const passed = new Set(
    parsed.criteria.filter((criterion) => criterion.status.value === "pass").map((criterion) => criterion.id),
  );
  return parsed.criteria.filter(
    (criterion) =>
      criterion.status.value !== "pass" &&
      criterion.depends.every(
        (dependency) =>
          passed.has(dependency) || !parsed.criteria.some((candidate) => candidate.id === dependency),
      ),
  );
}
