import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCharter } from "../../src/application/service";
import { parseCharterMarkdown } from "../../src/domain/charter-md";
import { parseReportMarkdown, renderReportMarkdown, renderReportScaffold, extractCharterTitleFromMarkdown } from "../../src/domain/report-md";
import { charterDir, writeTextAtomic } from "../../src/infrastructure/store";

export interface V3CriterionSpec {
  id: string;
  title?: string;
  body?: string;
  verifier?: string;
  because?: string;
  command?: string;
  evidenceKind?: string;
  freshSince?: string;
  agent?: string;
  task?: string;
  requireFreshEvidence?: boolean;
  requireReviewSubagent?: boolean;
}

export interface V3MilestoneSpec {
  id: string;
  title?: string;
  criteria: V3CriterionSpec[];
}

export interface MakeActiveCharterOptions {
  projectDir: string;
  charterId: string;
  objective: string;
  now?: string;
  name?: string;
  milestones?: V3MilestoneSpec[];
  criteria?: V3CriterionSpec[];
  commands?: Record<string, string>;
}

function renderCriterion(criterion: V3CriterionSpec, headingLevel: "##" | "###"): string {
  const titleSuffix = criterion.title ? ` ${criterion.title}` : "";
  const lines = [
    `${headingLevel} ${criterion.id}${titleSuffix}`,
    criterion.body ?? "Criterion body.",
    `Verifier: ${criterion.verifier ?? "manual"}`,
  ];
  if (criterion.command) lines.push(`Command: ${criterion.command}`);
  if (criterion.evidenceKind) lines.push(`Kind: ${criterion.evidenceKind}`);
  if (criterion.freshSince) lines.push(`FreshSince: ${criterion.freshSince}`);
  if (criterion.agent) lines.push(`Agent: ${criterion.agent}`);
  if (criterion.task) lines.push(`Task: ${criterion.task}`);
  if (criterion.requireFreshEvidence !== undefined) {
    lines.push(`Fresh evidence required: ${criterion.requireFreshEvidence}`);
  }
  if (criterion.requireReviewSubagent !== undefined) {
    lines.push(`RequireReviewSubagent: ${criterion.requireReviewSubagent}`);
  }
  const verifier = criterion.verifier ?? "manual";
  if (verifier === "manual" || criterion.because) {
    lines.push(`Because: ${criterion.because ?? "test fixture rationale"}`);
  }
  return lines.join("\n");
}

function renderCriteriaMarkdown(options: MakeActiveCharterOptions): string {
  const lines = ["# Criteria", ""];
  if (options.milestones?.length) {
    for (const milestone of options.milestones) {
      const milestoneTitle = milestone.title ? ` ${milestone.title}` : "";
      lines.push(`## ${milestone.id}${milestoneTitle}`, "");
      for (const criterion of milestone.criteria) {
        lines.push(renderCriterion(criterion, "###"), "");
      }
    }
    return lines.join("\n");
  }
  const criteria = options.criteria ?? [];
  for (const criterion of criteria) {
    lines.push(renderCriterion(criterion, "##"), "");
  }
  return lines.join("\n");
}

/**
 * Create an active v3 charter with real criteria in criteria.md (no plan lock).
 */
export async function makeActiveCharter(options: MakeActiveCharterOptions): Promise<string> {
  const now = options.now ?? "2026-05-15T00:00:00.000Z";
  await createCharter(options.projectDir, {
    objective: options.objective,
    charterId: options.charterId,
    now,
    name: options.name,
  });
  const dir = charterDir(options.projectDir, options.charterId);
  await writeFile(join(dir, "criteria.md"), renderCriteriaMarkdown(options), "utf8");
  if (options.commands && Object.keys(options.commands).length > 0) {
    const charterMd = await readFile(join(dir, "charter.md"), "utf8");
    const commandLines = Object.entries(options.commands).map(([key, value]) => `${key}: ${value}`);
    await writeFile(
      join(dir, "charter.md"),
      `${charterMd.trimEnd()}\n\n## Commands\n\n${commandLines.join("\n")}\n`,
      "utf8",
    );
  }
  return dir;
}

/**
 * Ensure REPORT.md exists with non-empty Outcome and Notes for completion gating.
 */
export async function seedReportReadyForCompletion(
  dir: string,
  sections?: { outcome?: string; notes?: string },
): Promise<void> {
  const reportPath = join(dir, "REPORT.md");
  let markdown: string;
  try {
    markdown = await readFile(reportPath, "utf8");
  } catch {
    const charterMarkdown = await readFile(join(dir, "charter.md"), "utf8");
    const criteriaMarkdown = await readFile(join(dir, "criteria.md"), "utf8").catch(() => undefined);
    const parsed = parseCharterMarkdown(
      charterMarkdown,
      criteriaMarkdown === undefined ? undefined : { criteriaMarkdown },
    );
    const title = extractCharterTitleFromMarkdown(charterMarkdown);
    markdown = renderReportScaffold({ title, objective: parsed.objective });
  }
  const parsedReport = parseReportMarkdown(markdown);
  await writeTextAtomic(
    reportPath,
    renderReportMarkdown({
      ...parsedReport,
      outcome: sections?.outcome ?? "Completed successfully.",
      notes: sections?.notes ?? "No additional notes.",
    }),
  );
}
