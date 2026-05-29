import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CharterToolError } from "./errors";
import { assertNotV1NeedsReplan, nextActionsForStatus } from "./service";
import { charterDir, loadCharterState, withCharterLock, writeTextAtomic } from "../infrastructure/store";

const DISCOVERED_H2_RE = /^##[ \t]+Discovered[ \t]*$/m;
const WRONG_LEVEL_DISCOVERED_RE = /^#{3,}[ \t]+Discovered[ \t]*$/m;

export async function writeAtPlanning(charterId: string, body: string): Promise<void>;
export async function writeAtPlanning(projectDir: string, charterId: string, body: string): Promise<void>;
export async function writeAtPlanning(first: string, second: string, third?: string): Promise<void> {
  const { projectDir, charterId, body } = architectureWriterArgs(first, second, third);
  const dir = charterDir(projectDir, charterId);
  await withCharterLock(dir, async () => {
    const state = await loadCharterState(dir);
    assertNotV1NeedsReplan(state);
    if (state.status !== "active") {
      throw new CharterToolError(`Cannot write architecture.md in status ${state.status}; writeAtPlanning is only legal in active.`, {
        code: "architecture.write_not_active",
        nextActions: nextActionsForStatus(state.status),
      });
    }
    const path = join(projectDir, ".pi", "charters", charterId, "architecture.md");
    const existing = await readOptionalText(path);
    if (existing?.trim()) {
      throw new CharterToolError(`Cannot rewrite architecture.md during active; use appendDiscovered to add notes.`, {
        code: "architecture.write_frozen_during_active",
        nextActions: nextActionsForStatus(state.status),
      });
    }
    await writeTextAtomic(path, body);
  });
}

export async function appendDiscovered(charterId: string, text: string): Promise<void>;
export async function appendDiscovered(projectDir: string, charterId: string, text: string): Promise<void>;
export async function appendDiscovered(first: string, second: string, third?: string): Promise<void> {
  const { projectDir, charterId, body: text } = architectureWriterArgs(first, second, third);
  const dir = charterDir(projectDir, charterId);
  await withCharterLock(dir, async () => {
    const state = await loadCharterState(dir);
    assertNotV1NeedsReplan(state);
    if (state.status !== "active") {
      throw new CharterToolError(`Cannot append architecture discoveries in status ${state.status}; appendDiscovered is only legal in active.`, {
        code: "architecture.append_not_active",
        nextActions: nextActionsForStatus(state.status),
      });
    }
    const path = join(projectDir, ".pi", "charters", charterId, "architecture.md");
    const existing = await readOptionalText(path);
    await writeTextAtomic(path, appendToDiscovered(existing, text));
  });
}

export async function overwriteAtAmend(charterId: string, body: string): Promise<void>;
export async function overwriteAtAmend(projectDir: string, charterId: string, body: string): Promise<void>;
export async function overwriteAtAmend(first: string, second: string, third?: string): Promise<void> {
  const { projectDir, charterId, body } = architectureWriterArgs(first, second, third);
  const dir = charterDir(projectDir, charterId);
  await withCharterLock(dir, async () => {
    const state = await loadCharterState(dir);
    assertNotV1NeedsReplan(state);
    if (state.status !== "active") {
      throw new CharterToolError(
        `Cannot overwrite architecture.md outside active; current status is ${state.status}.`,
        {
          code: "architecture.overwrite_not_active",
          nextActions: nextActionsForStatus(state.status),
        },
      );
    }
    await writeTextAtomic(join(projectDir, ".pi", "charters", charterId, "architecture.md"), body);
  });
}

function architectureWriterArgs(first: string, second: string, third?: string): { projectDir: string; charterId: string; body: string } {
  if (third === undefined) return { projectDir: process.cwd(), charterId: first, body: second };
  return { projectDir: first, charterId: second, body: third };
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function appendToDiscovered(markdown: string, text: string): string {
  rejectWrongLevelDiscovered(markdown);
  const addition = text.trimEnd();
  if (!addition.trim()) return markdown;

  const discovered = DISCOVERED_H2_RE.exec(markdown);
  if (!discovered) {
    const body = markdown.trimEnd();
    const prefix = body ? `${body}\n\n` : "";
    return `${prefix}## Discovered\n\n${addition}\n`;
  }

  const before = markdown.slice(0, discovered.index);
  const section = markdown.slice(discovered.index).trimEnd();
  return `${before}${section}\n\n${addition}\n`;
}

function rejectWrongLevelDiscovered(markdown: string): void {
  if (!WRONG_LEVEL_DISCOVERED_RE.test(markdown)) return;
  throw new CharterToolError("architecture.md contains ### Discovered; use the H2 heading ## Discovered for append-only discoveries.", {
    code: "architecture.discovered_wrong_level",
    nextActions: [{ tool: "charter_status", hint: "Inspect the charter before retrying architecture discovery append." }],
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
