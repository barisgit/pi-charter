#!/usr/bin/env bun
/**
 * Dogfood script: exercise the multi-charter widget pipeline end-to-end
 * against the live project.
 *
 * Usage:
 *   bun run scripts/dogfood-render.ts                  # uses process.cwd()
 *   bun run scripts/dogfood-render.ts <projectDir>     # explicit project dir
 *   bun run scripts/dogfood-render.ts --charter <id>   # pin a specific charter
 *
 * Resolution order for the detail snapshot:
 *   1. `--charter <id>` argv if it is in the active list,
 *   2. literal default `dad4fe3a-6cc8-4911-a747-4f39f12c51fb` if active,
 *   3. first row of `listActiveCharters` otherwise.
 *
 * Writes three sections to the pi-charter file log (never stdout/stderr):
 *   listActiveCharters   JSON.stringify(list, null, 2)
 *   charter-multi        rendered string[] joined by \n
 *   charter-detail (<name>)  rendered string[] joined by \n
 *
 * Exits 0 on success, non-zero on error.
 */

import { listActiveCharters } from "../src/application/service";
import { loadCharterSnapshot } from "../src/ui/widget-service";
import { buildMultiCharterViewModel } from "../src/ui/widget-state";
import { renderMultiCharterWidget } from "../src/ui/multi-charter-widget";
import { renderCharterWidget } from "../src/ui/widget";
import { logger } from "../src/infrastructure/logger";

const DEFAULT_DOGFOOD_CHARTER_ID = "dad4fe3a-6cc8-4911-a747-4f39f12c51fb";
const RENDER_WIDTH = 80;

// Identity theme — strips ANSI color noise so file-log output stays grep-able.
const theme = { fg: (_color: string, text: string) => text };

function parseArgs(argv: readonly string[]): { projectDir: string; explicitCharterId?: string } {
  let projectDir = process.cwd();
  let explicitCharterId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--charter") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("--charter requires a charter id");
      }
      explicitCharterId = next;
      i++;
      continue;
    }
    if (tok.startsWith("--")) continue; // ignore unknown flags
    projectDir = tok;
  }
  return explicitCharterId !== undefined
    ? { projectDir, explicitCharterId }
    : { projectDir };
}

async function main(): Promise<void> {
  const { projectDir, explicitCharterId } = parseArgs(process.argv.slice(2));

  const active = await listActiveCharters(projectDir);
  logger.info("dogfood-render", { section: "listActiveCharters", active });

  // Resolve the detail charter id per the documented order.
  let detailId: string | undefined;
  if (explicitCharterId && active.some((c) => c.charterId === explicitCharterId)) {
    detailId = explicitCharterId;
  } else if (active.some((c) => c.charterId === DEFAULT_DOGFOOD_CHARTER_ID)) {
    detailId = DEFAULT_DOGFOOD_CHARTER_ID;
  } else if (active.length > 0) {
    detailId = active[0]!.charterId;
  }

  const snapshots = await Promise.all(
    active.map((c) =>
      loadCharterSnapshot({
        projectDir,
        charterId: c.charterId,
        runningSubagents: [],
      }),
    ),
  );
  const snapshotsById = new Map(snapshots.map((s) => [s.charterId, s] as const));

  const multiVm = buildMultiCharterViewModel({
    snapshots,
    selectedCharterId: detailId ?? null,
    runningSubagentsByCharter: new Map(),
  });
  const multiLines = renderMultiCharterWidget(multiVm, theme, RENDER_WIDTH);
  logger.info("dogfood-render", { section: "charter-multi", lines: multiLines });

  if (detailId) {
    const detailVm = snapshotsById.get(detailId);
    if (detailVm) {
      const detailLines = renderCharterWidget({ width: RENDER_WIDTH, theme, vm: detailVm });
      logger.info("dogfood-render", { section: "charter-detail", displayName: detailVm.displayName, lines: detailLines });
    } else {
      logger.info("dogfood-render", { section: "charter-detail", charterId: detailId, lines: ["(no snapshot)"] });
    }
  } else {
    logger.info("dogfood-render", { section: "charter-detail", lines: ["(no active charter)"] });
  }
}

main().catch((error) => {
  logger.error("dogfood-render failed", error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
