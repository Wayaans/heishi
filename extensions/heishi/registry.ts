import type { RunRecord, RunStatus } from "./types.js";

export const RUN_ENTRY_TYPE = "heishi:subagent-run";

export function restoreRunSnapshots(entries: readonly unknown[]): RunRecord[] {
  const runs = new Map<string, RunRecord>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry["type"] === "custom" && entry["customType"] === RUN_ENTRY_TYPE && isRunRecord(entry["data"])) {
      runs.set(entry["data"].runId, entry["data"]);
    }
  }
  return [...runs.values()];
}

export async function reconcileRuns(
  runs: RunRecord[],
  tmux: {
    exists(target: string): Promise<boolean>;
    close(target: string): Promise<void>;
  },
): Promise<RunRecord[]> {
  return Promise.all(runs.map(async (run) => {
    if (run.paneState !== "open" || !run.tmuxTarget) return run;
    const paneExists = await tmux.exists(run.tmuxTarget);
    if (paneExists) await tmux.close(run.tmuxTarget);
    const wasActive = isActive(run.status);
    return {
      ...run,
      paneState: paneExists ? "closed" as const : "disconnected" as const,
      status: wasActive ? "failed" as const : run.status,
      updatedAt: new Date().toISOString(),
      ...(wasActive ? {
        error: paneExists
          ? "Subagent parent connection is unavailable after session restoration"
          : `Subagent pane ${run.tmuxTarget} no longer exists`,
      } : {}),
    };
  }));
}

export function isActive(status: RunStatus): boolean {
  return status === "created" || status === "starting" || status === "running";
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Record<string, unknown>;
  return run["version"] === 1
    && typeof run["runId"] === "string"
    && typeof run["alias"] === "string"
    && typeof run["taskPreview"] === "string"
    && typeof run["cwd"] === "string"
    && typeof run["model"] === "string"
    && typeof run["thinking"] === "string"
    && typeof run["placement"] === "string"
    && typeof run["status"] === "string"
    && typeof run["paneState"] === "string"
    && typeof run["createdAt"] === "string"
    && typeof run["updatedAt"] === "string";
}
