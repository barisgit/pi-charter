import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFeatureMarkdown } from "../domain/feature-md";

export interface PlanFeatureRef {
  id: string;
  milestone: string;
  order: number;
  fulfills: string[];
}

export interface PlanMilestoneGroup {
  milestoneId: string;
  order: number;
  features: PlanFeatureRef[];
}

export async function readPlanFeatures(dir: string): Promise<PlanFeatureRef[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "plan"));
  } catch {
    return [];
  }

  const features: PlanFeatureRef[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const parsed = parseFeatureMarkdown(await readFile(join(dir, "plan", name), "utf8"));
      features.push({
        id: parsed.id,
        milestone: parsed.milestone,
        order: parsed.order,
        fulfills: parsed.fulfills,
      });
    } catch {
      // Skip malformed feature files so status surfaces stay best-effort.
    }
  }
  return features;
}

export function groupFeaturesByMilestone(features: PlanFeatureRef[]): PlanMilestoneGroup[] {
  const byMilestone = new Map<string, PlanFeatureRef[]>();
  for (const feature of features) {
    const list = byMilestone.get(feature.milestone) ?? [];
    list.push(feature);
    byMilestone.set(feature.milestone, list);
  }

  return [...byMilestone.entries()]
    .map(([milestoneId, list]) => {
      const sorted = [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      return {
        milestoneId,
        order: sorted[0]?.order ?? 0,
        features: sorted,
      };
    })
    .sort((a, b) => a.order - b.order || a.milestoneId.localeCompare(b.milestoneId));
}
