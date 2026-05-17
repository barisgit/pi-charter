#!/usr/bin/env bun
/**
 * Dogfood script (VAL-9): exercise the new multi-charter widget pipeline
 * end-to-end against the live project.
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
 * Prints three sections to stdout (header line then content):
 *   === listActiveCharters ===   JSON.stringify(list, null, 2)
 *   === charter-multi ===        rendered string[] joined by \n
 *   === charter-detail (<name>) ===  rendered string[] joined by \n
 *
 * Exits 0 on success, non-zero on error.
 */

import { listActiveCharters } from "../src/application/service";
import { loadCharterSnapshot } from "../src/ui/widget-service";
import { buildMultiCharterViewModel } from "../src/ui/widget-state";
import { renderMultiCharterWidget } from "../src/ui/multi-charter-widget";
import { renderCharterWidget } from "../src/ui/widget";

const DEFAULT_DOGFOOD_CHARTER_ID = "dad4fe3a-6cc8-4911-a747-4f39f12c51fb";
const RENDER_WIDTH = 80;

// Identity theme — strips ANSI color noise so stdout stays grep-able.
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
  process.stdout.write("=== listActiveCharters ===\n");
  process.stdout.write(`${JSON.stringify(active, null, 2)}\n\n`);

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
  process.stdout.write("=== charter-multi ===\n");
  process.stdout.write(`${multiLines.join("\n")}\n\n`);

  if (detailId) {
    const detailVm = snapshotsById.get(detailId);
    if (detailVm) {
      const detailLines = renderCharterWidget({ width: RENDER_WIDTH, theme, vm: detailVm });
      process.stdout.write(`=== charter-detail (${detailVm.displayName}) ===\n`);
      process.stdout.write(`${detailLines.join("\n")}\n`);
    } else {
      process.stdout.write(`=== charter-detail (${detailId}) ===\n`);
      process.stdout.write("(no snapshot)\n");
    }
  } else {
    process.stdout.write("=== charter-detail (none) ===\n");
    process.stdout.write("(no active charter)\n");
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[dogfood-render] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
