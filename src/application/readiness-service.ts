import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateEvidenceFile, type ReadinessEvidence } from "../domain/evidence-schemas";
import { parseFeatureMarkdown } from "../domain/feature-md";

export type ReadinessProbeResult = ReadinessEvidence["probeResult"];

export interface BlockingReadinessFeature {
  featureId: string;
  fulfills: string[];
  probeResult: "blocking";
}

export async function getLatestReadinessProbe(
  featureId: string,
  charterDir: string,
): Promise<ReadinessProbeResult | undefined> {
  let entries: string[];
  try {
    entries = await readdir(join(charterDir, "evidence", featureId));
  } catch {
    return undefined;
  }

  let latest: { file: string; probedAt: string; probeResult: ReadinessProbeResult } | undefined;
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".readiness.json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(charterDir, "evidence", featureId, entry), "utf8"));
    } catch {
      continue;
    }
    const validated = validateEvidenceFile(parsed);
    if (!validated.ok || validated.value.kind !== "readiness") continue;
    if (validated.value.featureId !== featureId) continue;
    const candidate = {
      file: entry,
      probedAt: validated.value.probedAt,
      probeResult: validated.value.probeResult,
    };
    if (!latest || compareReadinessEvidence(candidate, latest) > 0) latest = candidate;
  }

  return latest?.probeResult;
}

export async function listBlockingReadinessFeatures(
  charterDir: string,
): Promise<BlockingReadinessFeature[]> {
  let entries: string[];
  try {
    entries = await readdir(join(charterDir, "plan"));
  } catch {
    return [];
  }

  const blocking: BlockingReadinessFeature[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      const feature = parseFeatureMarkdown(await readFile(join(charterDir, "plan", entry), "utf8"));
      if (feature.kind !== "readiness") continue;
      const probeResult = await getLatestReadinessProbe(feature.id, charterDir);
      if (probeResult === "blocking") {
        blocking.push({ featureId: feature.id, fulfills: feature.fulfills, probeResult });
      }
    } catch {
      continue;
    }
  }
  return blocking;
}

function compareReadinessEvidence(
  a: { file: string; probedAt: string },
  b: { file: string; probedAt: string },
): number {
  const aMs = Date.parse(a.probedAt);
  const bMs = Date.parse(b.probedAt);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
  if (a.probedAt !== b.probedAt) return a.probedAt.localeCompare(b.probedAt);
  return a.file.localeCompare(b.file);
}
