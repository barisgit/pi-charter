import type { CharterCommands } from "../domain/types";

export function commandEntries(commands?: CharterCommands): Array<[string, string]> {
  if (!commands) return [];
  return Object.entries(commands).filter(([, value]) => value.trim().length > 0);
}

export function formatCommandsInline(commands?: CharterCommands): string | undefined {
  const entries = commandEntries(commands);
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key}=${value}`).join("; ");
}

export function formatCommandsBlock(commands?: CharterCommands): string | undefined {
  const entries = commandEntries(commands);
  if (entries.length === 0) return undefined;
  return [
    "Commands:",
    ...entries.map(([key, value]) => `- ${key}: ${value}`),
  ].join("\n");
}

export interface SubagentBootstrapPromptInput {
  charterId: string;
  featureId?: string;
  criterionId?: string;
  commands?: CharterCommands;
}

export function renderSubagentBootstrapPrompt(input: SubagentBootstrapPromptInput): string {
  const lines = [`charterId: ${input.charterId}`];
  if (input.featureId) lines.push(`featureId: ${input.featureId}`);
  if (input.criterionId) lines.push(`criterionId: ${input.criterionId}`);
  const commands = formatCommandsBlock(input.commands);
  if (commands) lines.push("", commands, "", "Use these charter.md ## Commands entries verbatim when you need build/test/dev/lint/qa commands.");
  return lines.join("\n");
}
