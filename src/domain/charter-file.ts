/** Tolerant parser for the Objective/Phases charter.md interface. */

export type PhaseStatus = "upcoming" | "current" | "done";

export interface Phase {
  number: number;
  title: string;
  status: PhaseStatus;
  body: string;
}

export interface ParsedCharterFile {
  objective: string;
  references: string;
  scope: string;
  phases: Phase[];
  warnings: string[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const PHASE_ITEM = /^(\d+)\.\s+(.+?)\s*$/;
const STATUS_SUFFIX = /\s+—\s*(upcoming|current|done)\s*$/i;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ""));
}

function sectionBody(lines: string[], level: number, name: string): { found: boolean; start: number; end: number; body: string } {
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING);
    if (!heading || heading[1].length !== level || heading[2].toLowerCase() !== name.toLowerCase()) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].match(HEADING);
      // Objective subheadings are content; only reserved level-2 sections split it.
      if (next && (next[1].length <= level || (level === 1 && next[1].length === 2 && /^(references|scope|phases)$/i.test(next[2])))) {
        end = j;
        break;
      }
    }
    return { found: true, start: i + 1, end, body: lines.slice(i + 1, end).join("\n").trim() };
  }
  return { found: false, start: -1, end: -1, body: "" };
}

export function parseCharterFile(text: string): ParsedCharterFile {
  const warnings: string[] = [];
  const lines = stripComments(text).split("\n");
  const objectiveSection = sectionBody(lines, 1, "objective");
  const references = sectionBody(lines, 2, "references").body;
  const scope = sectionBody(lines, 2, "scope").body;
  const phaseSection = sectionBody(lines, 2, "phases");

  if (!objectiveSection.found) warnings.push("missing `# Objective` section");
  else if (!objectiveSection.body) warnings.push("`# Objective` section is empty");
  if (!phaseSection.found) warnings.push("missing `## Phases` section");

  const parsed: Array<Phase & { explicit: boolean }> = [];
  if (phaseSection.found) {
    for (let i = phaseSection.start; i < phaseSection.end; i++) {
      const item = lines[i].match(PHASE_ITEM);
      if (!item) continue;
      const rawTitle = item[2];
      const suffix = rawTitle.match(STATUS_SUFFIX);
      const body: string[] = [];
      let j = i + 1;
      while (j < phaseSection.end && !PHASE_ITEM.test(lines[j])) {
        if (/^\s+/.test(lines[j]) || lines[j].trim() === "") body.push(lines[j].replace(/^ {1,4}/, ""));
        else break;
        j++;
      }
      parsed.push({
        number: Number(item[1]),
        title: suffix ? rawTitle.slice(0, suffix.index).trim() : rawTitle.trim(),
        status: suffix ? suffix[1].toLowerCase() as PhaseStatus : "upcoming",
        body: body.join("\n").trim(),
        explicit: Boolean(suffix),
      });
      i = j - 1;
    }
  }

  if (!parsed.some((phase) => phase.status === "current")) {
    const current = parsed.find((phase) => phase.status !== "done" && !phase.explicit);
    if (current) current.status = "current";
  }

  return {
    objective: objectiveSection.body,
    references,
    scope,
    phases: parsed.map(({ explicit: _explicit, ...phase }) => phase),
    warnings,
  };
}
