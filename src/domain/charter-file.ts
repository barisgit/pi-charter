/**
 * charter.md parser (ADR-0014: the file is the interface).
 *
 * Tolerant by doctrine: unknown structure is inert prose, breakage is a
 * warning, never an error. Parsing never blocks evidence-side work.
 *
 * Grammar (everything else is inert):
 *   ## Objective                       — required, prose until next ## heading
 *   ## Criteria                        — required section marker
 *   ### C<n>. <title>                  — one heading per criterion
 *   Depends: C1, C2                    — optional, advisory only
 *   Evidence: pass|fail|none — <note>  — one per criterion, reads until next heading
 *
 * HTML comments are stripped before parsing so template guidance is inert.
 */

export type EvidenceStatus = "pass" | "fail" | "none";

export interface ParsedEvidence {
  status: EvidenceStatus;
  note: string;
}

export interface ParsedCriterion {
  id: string; // "C1"
  title: string;
  /** Prose between the heading and the Evidence line (Depends stripped). */
  body: string;
  depends: string[];
  evidence: ParsedEvidence;
  /** 1-based line number of the `### C<n>.` heading (post comment-strip). */
  line: number;
}

export interface ParsedCharterFile {
  objective: string;
  criteria: ParsedCriterion[];
  /** No criteria authored: charter is open-ended, complete never legal. */
  openEnded: boolean;
  warnings: string[];
}

const CRITERION_HEADING = /^###\s+(C\d+)\.\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const LEVEL2_HEADING = /^##\s+(.+?)\s*$/;
const DEPENDS_LINE = /^Depends:\s*(.*)$/i;
const EVIDENCE_LINE = /^Evidence:\s*(.*)$/i;

/** Strip HTML comments but keep line count stable for line attribution. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}

function parseEvidenceValue(
  raw: string,
  id: string,
  warnings: string[],
): ParsedEvidence {
  const match = raw.match(/^(\S+)\s*(?:[—–-]\s*)?([\s\S]*)$/);
  const token = (match?.[1] ?? "").toLowerCase();
  const note = (match?.[2] ?? "").trim();
  if (token === "pass" || token === "fail" || token === "none") {
    if (token === "pass" && note.length === 0) {
      warnings.push(
        `${id}: Evidence is "pass" with an empty note; completion requires a note saying what was run and what it showed`,
      );
    }
    return { status: token, note };
  }
  if (raw.trim().length === 0) {
    return { status: "none", note: "" };
  }
  warnings.push(
    `${id}: Evidence line must start with pass, fail, or none (got "${raw.trim().slice(0, 40)}"); treating as none`,
  );
  return { status: "none", note: raw.trim() };
}

export function parseCharterFile(text: string): ParsedCharterFile {
  const warnings: string[] = [];
  const lines = stripComments(text).split("\n");

  // --- objective: prose from "## Objective" to the next level-2 heading ---
  let objective = "";
  let sawObjectiveHeading = false;
  let sawCriteriaHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(LEVEL2_HEADING);
    if (!h) continue;
    const title = h[1].toLowerCase();
    if (title === "objective") {
      sawObjectiveHeading = true;
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (LEVEL2_HEADING.test(lines[j])) break;
        buf.push(lines[j]);
      }
      objective = buf.join("\n").trim();
    } else if (title === "criteria") {
      sawCriteriaHeading = true;
    }
  }
  if (!sawObjectiveHeading) warnings.push("missing `## Objective` section");
  else if (objective.length === 0) warnings.push("`## Objective` section is empty");
  if (!sawCriteriaHeading) warnings.push("missing `## Criteria` section");

  // --- criteria: every `### C<n>.` heading, document-wide (tolerant) ---
  const criteria: ParsedCriterion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(CRITERION_HEADING);
    if (!h) continue;
    const id = h[1];
    if (seen.has(id)) {
      warnings.push(`duplicate criterion id ${id}; later occurrence ignored`);
      continue;
    }
    seen.add(id);

    // block: heading+1 until the next heading of any level
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING.test(lines[j])) {
        end = j;
        break;
      }
    }

    let depends: string[] = [];
    let evidence: ParsedEvidence | undefined;
    const bodyLines: string[] = [];
    for (let j = i + 1; j < end; j++) {
      const dep = lines[j].match(DEPENDS_LINE);
      if (dep) {
        depends = dep[1]
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        continue;
      }
      const ev = lines[j].match(EVIDENCE_LINE);
      if (ev) {
        // evidence note continues until the block end
        const rest = lines.slice(j + 1, end).join("\n").trimEnd();
        const raw = rest.length > 0 ? `${ev[1]}\n${rest}` : ev[1];
        evidence = parseEvidenceValue(raw, id, warnings);
        break;
      }
      bodyLines.push(lines[j]);
    }
    if (!evidence) {
      warnings.push(`${id}: missing Evidence line; treating as "Evidence: none"`);
      evidence = { status: "none", note: "" };
    }

    criteria.push({
      id,
      title: h[2],
      body: bodyLines.join("\n").trim(),
      depends,
      evidence,
      line: i + 1,
    });
  }

  // --- depends sanity: dangling refs and cycles are warnings only ---
  const ids = new Set(criteria.map((c) => c.id));
  for (const c of criteria) {
    for (const d of c.depends) {
      if (!ids.has(d)) warnings.push(`${c.id}: Depends references unknown ${d}`);
      if (d === c.id) warnings.push(`${c.id}: Depends references itself`);
    }
  }
  detectCycles(criteria, warnings);

  return { objective, criteria, openEnded: criteria.length === 0, warnings };
}

function detectCycles(criteria: ParsedCriterion[], warnings: string[]): void {
  const edges = new Map(criteria.map((c) => [c.id, c.depends]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") {
      warnings.push(`dependency cycle: ${[...path, id].join(" -> ")}`);
      return true;
    }
    state.set(id, "visiting");
    for (const d of edges.get(id) ?? []) {
      if (edges.has(d) && visit(d, [...path, id])) {
        state.set(id, "done");
        return true;
      }
    }
    state.set(id, "done");
    return false;
  };
  for (const c of criteria) {
    if (visit(c.id, [])) return; // one cycle warning is enough
  }
}

/**
 * Ready-next advisory: non-pass criteria whose depends are all pass.
 * Advisory only; the agent may work on anything.
 */
export function readyCriteria(parsed: ParsedCharterFile): ParsedCriterion[] {
  const passed = new Set(
    parsed.criteria.filter((c) => c.evidence.status === "pass").map((c) => c.id),
  );
  return parsed.criteria.filter(
    (c) =>
      c.evidence.status !== "pass" &&
      c.depends.every((d) => passed.has(d) || !parsed.criteria.some((x) => x.id === d)),
  );
}
