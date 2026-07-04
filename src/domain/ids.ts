import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ID_RE = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*(?:-\d+)?$/;

export function slugFromObjective(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "charter";
}

export function timestampIdPart(date = new Date()): string {
  const iso = date.toISOString();
  return iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");
}

export function charterSlugFromId(id: string): string {
  return id.replace(/^\d{8}-\d{6}-/, "");
}

export async function generateCharterId(input: {
  root: string;
  objective: string;
  now?: Date;
}): Promise<string> {
  const base = `${timestampIdPart(input.now)}-${slugFromObjective(input.objective)}`;
  const existing = new Set(await safeReaddir(input.root));
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export async function resolveCharterId(root: string, query?: string): Promise<string> {
  const ids = (await safeReaddir(root)).filter((name) => ID_RE.test(name));
  if (ids.length === 0) throw new Error("No charters found.");
  if (!query || !query.trim()) {
    const active = ids[0];
    return active;
  }
  const q = query.trim();
  if (ids.includes(q)) return q;

  const prefix = ids.filter((id) => id.startsWith(q));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new Error(`Ambiguous charter id prefix '${q}': ${prefix.join(", ")}`);

  const slugMatches = ids.filter((id) => charterSlugFromId(id).includes(q.toLowerCase()));
  if (slugMatches.length === 1) return slugMatches[0];
  if (slugMatches.length > 1) throw new Error(`Ambiguous charter slug fragment '${q}': ${slugMatches.join(", ")}`);
  throw new Error(`No charter matches '${q}'.`);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function isInsideCharters(path: string): boolean {
  return path.split(/[\\/]+/).includes(".charters");
}

export function idPath(root: string, id: string): string {
  return join(root, id);
}
