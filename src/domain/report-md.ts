export interface ReportSections {
  title: string;
  objective: string;
  outcome: string;
  notes: string;
}

export interface ReportCompletionCheck {
  ok: boolean;
  emptySections: string[];
  failures: string[];
}

const REPORT_HEADINGS = ["Title", "Objective", "Outcome", "Notes"] as const;

export function extractCharterTitleFromMarkdown(markdown: string, fallbackName?: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(?:Charter:\s*)?(.+?)\s*$/.exec(line.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  if (fallbackName?.trim()) return fallbackName.trim();
  return "Untitled";
}

export function renderReportMarkdown(sections: ReportSections): string {
  return [
    `# ${sections.title.trim() || "Untitled"}`,
    "",
    "## Objective",
    "",
    sections.objective.trim(),
    "",
    "## Outcome",
    "",
    sections.outcome.trim(),
    "",
    "## Notes",
    "",
    sections.notes.trim(),
    "",
  ].join("\n");
}

export function renderReportScaffold(input: { title: string; objective: string }): string {
  return renderReportMarkdown({
    title: input.title,
    objective: input.objective,
    outcome: "",
    notes: "",
  });
}

export function parseReportMarkdown(markdown: string): ReportSections {
  let title = "";
  const sections = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    sections.set(current, buffer.join("\n"));
  };

  for (const line of markdown.split(/\r?\n/)) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      flush();
      current = undefined;
      buffer = [];
      title = h1[1]?.trim() ?? "";
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      current = normalizeReportHeading(h2[1]);
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  return {
    title: title.trim(),
    objective: trimReportSection(sections.get("objective") ?? ""),
    outcome: trimReportSection(sections.get("outcome") ?? ""),
    notes: trimReportSection(sections.get("notes") ?? ""),
  };
}

function trimReportSection(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function checkReportCompletion(markdown: string): ReportCompletionCheck {
  const parsed = parseReportMarkdown(markdown);
  const emptySections = REPORT_HEADINGS.filter((heading) => {
    const value = heading === "Title" ? parsed.title : parsed[heading.toLowerCase() as keyof Omit<ReportSections, "title">];
    return !hasReportContent(value);
  });
  const failures = emptySections.map((section) => `REPORT.md: ${section} section is empty`);
  return { ok: emptySections.length === 0, emptySections, failures };
}

function hasReportContent(value: string): boolean {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("<!--"));
}

function normalizeReportHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
