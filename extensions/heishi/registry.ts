import { THINKING_LEVELS, type ThinkingLevel } from "./tmux.js";
import type { RunRecord, RunStatus, SubagentReport, WorkerMode } from "./types.js";

export const RUN_ENTRY_TYPE = "heishi:subagent-run";
export const MODE_ENTRY_TYPE = "heishi:mode";

const OPTIONAL_STRING_FIELDS = [
  "tmuxTarget", "tmuxWindowId", "tmuxSessionId", "workerSessionId", "workerSessionFile",
  "startedAt", "completedAt", "error",
] as const;
type OptionalStringField = typeof OPTIONAL_STRING_FIELDS[number];

export function restoreRunSnapshots(entries: readonly unknown[]): RunRecord[] {
  const runs = new Map<string, RunRecord>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry["type"] !== "custom" || entry["customType"] !== RUN_ENTRY_TYPE) continue;
    const run = normalizeRunRecord(entry["data"]);
    if (run) runs.set(run.runId, run);
  }
  return [...runs.values()];
}

export function restoreSessionMode(entries: readonly unknown[]): WorkerMode | undefined {
  let mode: WorkerMode | undefined;
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry["type"] !== "custom" || entry["customType"] !== MODE_ENTRY_TYPE) continue;
    const data = entry["data"];
    if (typeof data !== "object" || data === null) continue;
    const candidate = (data as Record<string, unknown>)["mode"];
    if (candidate === "sub" || candidate === "main") mode = candidate;
  }
  return mode;
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

function normalizeRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const run = value as Record<string, unknown>;
  const legacy = run["version"] === 1;
  const mode = legacy ? "sub" : run["mode"];
  const validModel = typeof run["model"] === "string" || (mode === "main" && run["model"] === undefined);
  const validThinking = isThinkingLevel(run["thinking"]) || (mode === "main" && run["thinking"] === undefined);
  if ((!legacy && run["version"] !== 2)
    || (mode !== "sub" && mode !== "main")
    || typeof run["runId"] !== "string"
    || typeof run["alias"] !== "string"
    || typeof run["taskPreview"] !== "string"
    || typeof run["cwd"] !== "string"
    || !validModel
    || !validThinking
    || !isOneOf(run["placement"], ["pane", "window", "session"])
    || !isOneOf(run["status"], ["created", "starting", "running", "completed", "blocked", "failed", "cancelled"])
    || !isOneOf(run["paneState"], ["open", "closed", "disconnected"])
    || typeof run["createdAt"] !== "string"
    || typeof run["updatedAt"] !== "string"
    || OPTIONAL_STRING_FIELDS.some((field) => run[field] !== undefined && typeof run[field] !== "string")
    || (run["report"] !== undefined && !isSubagentReport(run["report"]))) return undefined;

  const normalized: RunRecord = {
    version: 2,
    mode,
    runId: run["runId"],
    alias: run["alias"],
    taskPreview: run["taskPreview"],
    cwd: run["cwd"],
    placement: run["placement"],
    status: run["status"],
    paneState: run["paneState"],
    createdAt: run["createdAt"],
    updatedAt: run["updatedAt"],
  };
  if (typeof run["model"] === "string") normalized.model = run["model"];
  if (isThinkingLevel(run["thinking"])) normalized.thinking = run["thinking"];
  for (const field of OPTIONAL_STRING_FIELDS) copyOptionalString(run, normalized, field);
  if (isSubagentReport(run["report"])) normalized.report = run["report"];
  return normalized;
}

function copyOptionalString(source: Record<string, unknown>, target: RunRecord, field: OptionalStringField): void {
  const value = source[field];
  if (typeof value === "string") target[field] = value;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return isOneOf(value, THINKING_LEVELS);
}

function isSubagentReport(value: unknown): value is SubagentReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return isOneOf(report["status"], ["completed", "blocked", "failed"])
    && typeof report["summary"] === "string"
    && typeof report["structured"] === "boolean"
    && (report["verification"] === undefined || typeof report["verification"] === "string")
    && (report["remainingRisk"] === undefined || typeof report["remainingRisk"] === "string");
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}
