import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFeatureMarkdown } from "../domain/feature-md";
import type { CharterTriageEntry } from "../domain/types";
import { charterDir } from "../infrastructure/store";
import { validateHandoffRecord } from "../persistence/handoff-store";

export type HandoffTriageSeverity = "blocking" | "non_blocking" | "suggestion";
export type HandoffTriageKind = "discovered_issue" | "critical_context" | "incomplete_work";

export interface HandoffTriageItem {
  handoffPath: string;
  itemId: string;
  description: string;
  severity: HandoffTriageSeverity;
  kind: HandoffTriageKind;
  featureId: string;
  sessionId: string;
}

export interface FeaturePlanText {
  featureId: string;
  path: string;
  body: string;
}

const BLOCKING_ISSUE_SEVERITIES: ReadonlySet<HandoffTriageSeverity> = new Set([
  "blocking",
  "non_blocking",
]);

export async function scanHandoffTriageQueue(projectDir: string, charterId: string): Promise<HandoffTriageItem[]> {
  return scanHandoffTriageQueueInDir(charterDir(projectDir, charterId));
}

export async function scanHandoffTriageQueueInDir(dir: string): Promise<HandoffTriageItem[]> {
  const workDir = join(dir, "work");
  let featureDirs: string[];
  try {
    featureDirs = await readdir(workDir);
  } catch {
    return [];
  }

  const items: HandoffTriageItem[] = [];
  for (const featureDir of featureDirs) {
    const handoffsDir = join(workDir, featureDir, "handoffs");
    let entries: string[];
    try {
      entries = await readdir(handoffsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".handoff.json")) continue;
      const handoffPath = join("work", featureDir, "handoffs", entry);
      try {
        const parsed = JSON.parse(await readFile(join(dir, handoffPath), "utf8"));
        const validation = validateHandoffRecord(parsed);
        if (!validation.ok) continue;
        const record = validation.value;
        const leftUndone = record.whatWasLeftUndone.trim();
        if (leftUndone) {
          items.push({
            handoffPath,
            itemId: "whatWasLeftUndone",
            description: leftUndone,
            severity: "blocking",
            kind: "incomplete_work",
            featureId: record.featureId,
            sessionId: record.sessionId,
          });
        }
        record.discoveredIssues.forEach((issue, index) => {
          if (issue.triageState !== "untriaged") return;
          if (!BLOCKING_ISSUE_SEVERITIES.has(issue.severity)) return;
          items.push({
            handoffPath,
            itemId: `discoveredIssues[${index}]`,
            description: issue.description.trim(),
            severity: issue.severity,
            kind: issue.kind,
            featureId: record.featureId,
            sessionId: record.sessionId,
          });
        });
      } catch {
        // Ignore malformed scratch handoff files; the gate is for valid worker
        // handoff records and should not be blocked by stale partial writes.
      }
    }
  }
  return items.sort((a, b) => a.handoffPath.localeCompare(b.handoffPath) || a.itemId.localeCompare(b.itemId));
}

export async function readFeaturePlanTexts(dir: string): Promise<FeaturePlanText[]> {
  let entries: string[];
  try {
    entries = await readdir(join(dir, "plan"));
  } catch {
    return [];
  }
  const plans: FeaturePlanText[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join("plan", entry);
    try {
      const markdown = await readFile(join(dir, path), "utf8");
      const feature = parseFeatureMarkdown(markdown);
      plans.push({ featureId: feature.id, path, body: feature.body });
    } catch {
      // Skip malformed feature files so a broken draft does not hide the real
      // completion blocker.
    }
  }
  return plans;
}

export function isItemTriaged(
  triageLog: readonly CharterTriageEntry[] | undefined,
  item: HandoffTriageItem,
  featurePlans: readonly FeaturePlanText[],
): boolean {
  const cut = triageLog?.some((entry) =>
    entry.decision === "cut"
    && entry.handoffPath === item.handoffPath
    && entry.itemId === item.itemId,
  );
  if (cut) return true;

  const handoffFile = basename(item.handoffPath);
  return featurePlans.some((plan) =>
    plan.body.includes(item.sessionId) || plan.body.includes(handoffFile),
  );
}

export async function listUntriagedHandoffItems(
  dir: string,
  triageLog: readonly CharterTriageEntry[] | undefined,
): Promise<HandoffTriageItem[]> {
  const [queue, featurePlans] = await Promise.all([
    scanHandoffTriageQueueInDir(dir),
    readFeaturePlanTexts(dir),
  ]);
  return queue.filter((item) => !isItemTriaged(triageLog, item, featurePlans));
}
