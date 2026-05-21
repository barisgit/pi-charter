import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureDefinition } from "../domain/feature-md";
import { charterDir } from "../infrastructure/store";

export const ARCHITECTURE_MIN_BYTES = 200;

export interface ArchitectureGateResult {
  expectedPath: string;
  implFeatureCount: number;
  required: boolean;
  present: boolean;
}

export function architectureMarkdownPath(projectDir: string, charterId: string): string {
  return join(charterDir(projectDir, charterId), "library", "architecture.md");
}

export async function inspectArchitectureGate(
  projectDir: string,
  charterId: string,
  features: FeatureDefinition[],
): Promise<ArchitectureGateResult> {
  const expectedPath = architectureMarkdownPath(projectDir, charterId);
  const implFeatureCount = features.filter((feature) => feature.kind === "impl").length;
  return {
    expectedPath,
    implFeatureCount,
    required: implFeatureCount > 2,
    present: await hasNonTrivialArchitecture(expectedPath),
  };
}

export async function hasNonTrivialArchitecture(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return Buffer.byteLength(content, "utf8") > ARCHITECTURE_MIN_BYTES;
  } catch {
    return false;
  }
}
