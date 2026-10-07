/**
 * Tolerant parser for the authored charter.md interface (ADR-0018).
 *
 * Only the `# Objective`, `## References`, and `## Scope` sections carry meaning.
 * Everything else, including `## Notes` and the historical `## Phases` section of
 * older charters, is displayed as `notes` and never interpreted. The original
 * file remains untouched; this display projection hides Markdown comments.
 */

export interface ParsedCharterFile {
  objective: string;
  references: string;
  scope: string;
  /** Authored Markdown outside the three sections, comments removed. */
  notes: string;
  warnings: string[];
}

interface Section {
  /** Heading line index. */
  start: number;
  /** Exclusive end line index. */
  end: number;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/**
 * Level-2 headings that end the Objective. Other level-2 headings are Objective
 * content (e.g. `## Constraints`). `notes` and the historical `phases` heading only
 * mark where authored notes begin, so their text never leaks into the Objective.
 */
const OBJECTIVE_TERMINATORS = /^(references|scope|notes|phases)$/i;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ""));
}

function findSection(lines: string[], level: number, name: string): Section | undefined {
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING);
    if (!heading || heading[1].length !== level || heading[2].toLowerCase() !== name.toLowerCase()) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].match(HEADING);
      // Objective subheadings are content; only reserved level-2 sections split it.
      if (next && (next[1].length <= level || (level === 1 && next[1].length === 2 && OBJECTIVE_TERMINATORS.test(next[2])))) {
        end = j;
        break;
      }
    }
    return { start: i, end, body: lines.slice(i + 1, end).join("\n").trim() };
  }
  return undefined;
}

/** Extract the Objective, References, Scope, and remaining notes; warnings never block work. */
export function parseCharterFile(text: string): ParsedCharterFile {
  const lines = stripComments(text).split("\n");
  const objective = findSection(lines, 1, "objective");
  const references = findSection(lines, 2, "references");
  const scope = findSection(lines, 2, "scope");
  const claimed = [objective, references, scope].filter((section): section is Section => section !== undefined);
  const notes = lines
    .filter((_line, index) => !claimed.some((section) => index >= section.start && index < section.end))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const warnings: string[] = [];
  if (!objective) warnings.push("missing `# Objective` section");
  else if (!objective.body) warnings.push("`# Objective` section is empty");
  return {
    objective: objective?.body ?? "",
    references: references?.body ?? "",
    scope: scope?.body ?? "",
    notes,
    warnings,
  };
}
