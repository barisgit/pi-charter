/** Loads the session-bound charter status, with listing dates, for the widget. */

import { getBoundCharterStatus, type CharterStatusResult } from "../application/service";
import { listCharters } from "../infrastructure/store";

export type CharterWidgetStatusWithDates = CharterStatusResult & { createdAt?: string; updatedAt?: string };

export async function loadCharterWidgetStatus(
  projectDir: string,
  input: { sessionId?: string } = {},
): Promise<CharterWidgetStatusWithDates | undefined> {
  const status = await getBoundCharterStatus(projectDir, input.sessionId);
  if (!status) return undefined;
  return withListDates(projectDir, status);
}

async function withListDates(projectDir: string, status: CharterStatusResult): Promise<CharterWidgetStatusWithDates> {
  const row = (await listCharters(projectDir)).find((entry) => entry.charterId === status.charterId);
  return { ...status, createdAt: row?.createdAt ?? status.createdAt, updatedAt: row?.updatedAt };
}
