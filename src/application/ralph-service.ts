/**
 * Deterministic Ralph reprompt service.
 *
 * Replaces the per-turn model evaluator with a "dumb" continuation prompt that
 * fires whenever the session goes fully idle (main agent done AND all async
 * subagents done). The charter must never stop on its own: as long as the
 * bound charter is in a non-terminal status, every idle transition triggers a
 * status-driven prompt injected as a `deliverAs: "steer"` message.
 *
 * Pattern: same shape as OpenAI Codex `/goal` continuation + Anthropic Claude
 * Code `/goal` Stop-hook loop, minus any LLM judgment about whether to
 * continue. The agent itself decides when the charter is actually done, then
 * calls `charter_manage action=complete`.
 *
 * Prompts are sourced in override order:
 *   1. repo-level   `<cwd>/.pi/charter-prompts/ralph/<case>.md`
 *   2. charter-level `<projectDir>/.pi/charters/<id>/prompts/ralph/<case>.md`
 *   3. builtin       `<extension>/src/prompts/ralph/<case>.md`
 *
 * Template variables are simple `{{ name }}` substitutions; no Handlebars,
 * no escaping beyond what the deterministic status block already encodes.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { getCharterStatus, type CharterStatusResult } from "./service";
import { formatCommandsBlock } from "./subagent-bootstrap";
import type { CharterStatus } from "../domain/types";

export type RalphCase = "planning" | "active";

/**
 * Statuses where Ralph should NOT reprompt. Mirrors the previous evaluator
 * skip set plus `paused` (paused charters intentionally do not auto-continue).
 */
export const RALPH_SKIP_STATUSES = new Set<CharterStatus>([
  "completed",
  "abandoned",
  "paused",
  "awaiting-clarification",
  "budget_limited",
]);

/**
 * Pick the prompt case from charter status. Active and review both drive
 * execution; planning is its own track. Anything terminal is filtered out
 * upstream by `RALPH_SKIP_STATUSES`.
 */
export function ralphCaseForStatus(status: CharterStatus): RalphCase {
  if (status === "planning") return "planning";
  // active | review → execution prompt.
  return "active";
}

/**
 * Compact deterministic status block. No prose, no narrative — just enough
 * for the agent to know which lever to pull next. Mirrors the same fields
 * the charter widget surfaces.
 */
export function renderStatusSummary(status: CharterStatusResult): string {
  const lines: string[] = [];
  lines.push(`status: ${status.status}`);

  const drift = status.drift;
  const readyNext = drift.readyNext ?? [];
  if (readyNext.length > 0) {
    lines.push("readyNext:");
    for (const r of readyNext.slice(0, 5)) {
      const fulfills = r.fulfills?.length ? ` -> ${r.fulfills.join(",")}` : "";
      lines.push(`  - ${r.featureId}${fulfills}`);
    }
  } else {
    lines.push("readyNext: (none)");
  }

  const uncovered = drift.uncovered ?? [];
  if (uncovered.length > 0) {
    lines.push("uncovered:");
    for (const u of uncovered.slice(0, 5)) {
      lines.push(`  - ${u.criterionId}: ${u.reason}`);
    }
  }

  const stuck = drift.stuck ?? [];
  if (stuck.length > 0) {
    lines.push("stuck:");
    for (const s of stuck.slice(0, 5)) {
      lines.push(`  - ${s.featureId} (${s.status})`);
    }
  }

  const stale = drift.stale ?? [];
  if (stale.length > 0) {
    lines.push("stale:");
    for (const s of stale.slice(0, 5)) {
      const ageMin = Math.round(s.ageMs / 60_000);
      lines.push(`  - ${s.criterionId} (${ageMin}m old)`);
    }
  }

  const nextActions = status.nextActions ?? [];
  if (nextActions.length > 0) {
    lines.push("legalNextActions:");
    for (const a of nextActions.slice(0, 6)) {
      const action = a.action ? ` action=${a.action}` : "";
      lines.push(`  - ${a.tool}${action}: ${a.hint}`);
    }
  } else {
    lines.push("legalNextActions: (none)");
  }

  const commands = formatCommandsBlock(status.commands);
  if (commands) lines.push(commands);

  const blocking = status.details?.blockingForComplete;
  if (Array.isArray(blocking) && blocking.length > 0) {
    lines.push("completionBlockers:");
    for (const b of blocking.slice(0, 5)) {
      const id = b.criterionId ?? b.handoffPath ?? b.featureId ?? "handoff item";
      lines.push(`  - ${id}: ${b.reason ?? "needs evidence"}`);
    }
  } else {
    lines.push("completionBlockers: (none)");
  }

  return lines.join("\n");
}

/**
 * Resolve the absolute path to the bundled `src/prompts/ralph/<case>.md`
 * file. Mirrors `resolveAgentsDir` — Bun and bundled builds both put this
 * module under `<extension>/src/application/`, so prompts live one `..` away.
 */
function builtinPromptPath(promptCase: RalphCase): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..", "prompts", "ralph", `${promptCase}.md`);
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface LoadRalphPromptInput {
  promptCase: RalphCase;
  charterId: string;
  projectDir: string;
  /** Defaults to projectDir; tests may pass a separate `cwd`. */
  cwd?: string;
}

/**
 * Read the prompt template, honoring override layers. The first existing
 * file wins; falls back to the bundled default. Returns the raw template
 * (template variables NOT yet substituted).
 */
export async function loadRalphPromptTemplate(input: LoadRalphPromptInput): Promise<string> {
  const cwd = input.cwd ?? input.projectDir;
  const candidates = [
    resolvePath(cwd, ".pi", "charter-prompts", "ralph", `${input.promptCase}.md`),
    resolvePath(input.projectDir, ".pi", "charters", input.charterId, "prompts", "ralph", `${input.promptCase}.md`),
    builtinPromptPath(input.promptCase),
  ];
  for (const path of candidates) {
    const text = await readIfExists(path);
    if (text !== undefined) return text;
  }
  // Should never happen — builtin path is bundled with the extension — but
  // surface a useful error rather than rendering an empty steer.
  throw new Error(`pi-charter: no ralph prompt template found for case ${input.promptCase}`);
}

/**
 * Substitute `{{ name }}` tokens. Tolerates spaces inside the braces and
 * silently leaves unknown tokens alone (so missing variables don't blow up
 * the steer payload).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : `{{ ${name} }}`;
  });
}

export interface BuildRalphPromptInput {
  charterId: string;
  projectDir: string;
  status: CharterStatusResult;
  /** Test seam: defaults to projectDir. */
  cwd?: string;
}

export interface BuiltRalphPrompt {
  promptCase: RalphCase;
  content: string;
}

/**
 * Build the rendered steer payload for the bound charter. Returns
 * `undefined` if the charter is in a skip status.
 */
export async function buildRalphPrompt(input: BuildRalphPromptInput): Promise<BuiltRalphPrompt | undefined> {
  const status = input.status.status;
  if (RALPH_SKIP_STATUSES.has(status)) return undefined;
  const promptCase = ralphCaseForStatus(status);
  const template = await loadRalphPromptTemplate({
    promptCase,
    charterId: input.charterId,
    projectDir: input.projectDir,
    cwd: input.cwd,
  });
  const statusSummary = renderStatusSummary(input.status);
  const content = renderTemplate(template, {
    objective: input.status.objective ?? "",
    charterId: input.charterId,
    status,
    statusSummary,
  });
  return { promptCase, content };
}

/**
 * Convenience: load the status, then build the prompt. Returns `undefined`
 * if no prompt should fire.
 */
export async function buildRalphPromptForCharter(input: {
  projectDir: string;
  charterId: string;
  cwd?: string;
}): Promise<BuiltRalphPrompt | undefined> {
  const status = await getCharterStatus(input.projectDir, { charterId: input.charterId });
  return buildRalphPrompt({
    charterId: input.charterId,
    projectDir: input.projectDir,
    status,
    cwd: input.cwd,
  });
}
