import { isAbsolute } from "node:path";
import {
  isUuid,
  terminalTargetLabel,
  THINKING_LEVELS,
  type HostTarget,
  type TerminalHosts,
  type ThinkingLevel,
} from "./terminal-host.js";
import type { RunRecord, RunStatus, SubagentReport, WorkspaceKind, WorktreeRecord } from "./types.js";
import { isSafeRelativeCwd } from "./workspace.js";

export const RUN_ENTRY_TYPE = "heishi:subagent-run";

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

export async function reconcileRuns(
  runs: RunRecord[],
  hosts: TerminalHosts,
): Promise<RunRecord[]> {
  return Promise.all(runs.map(async (run) => {
    if (run.paneState !== "open" || !run.hostTarget) return run;
    const target = run.hostTarget;
    const host = hosts.forTarget(target);
    const label = terminalTargetLabel(target);
    const wasActive = isActive(run.status);
    const update = (paneState: "closed" | "open" | "disconnected", error: string): RunRecord => ({
      ...run,
      paneState,
      status: wasActive ? "failed" : run.status,
      updatedAt: new Date().toISOString(),
      error,
    });

    let paneExists: boolean;
    try {
      paneExists = await host.exists(target);
    } catch (error) {
      return update("disconnected", `Could not inspect restored subagent terminal target ${label}: ${errorMessage(error)}`);
    }
    if (!paneExists) {
      // A missing headless process is verified gone by its PID and start time, so it can be resumed or cleaned up.
      return target.host === "headless"
        ? update("closed", `Subagent worker ${label} exited with the previous parent session`)
        : update("disconnected", `Subagent terminal target ${label} no longer exists`);
    }

    let closeError: string | undefined;
    try {
      await host.close(target);
    } catch (error) {
      closeError = `Could not close restored subagent terminal target ${label}: ${errorMessage(error)}`;
    }
    try {
      if (await host.exists(target)) {
        const suffix = `Subagent terminal target ${label} still exists after close`;
        return update("open", closeError ? `${closeError}; ${suffix}` : suffix);
      }
      return update("closed", "Subagent parent connection is unavailable after session restoration");
    } catch (error) {
      const suffix = `Could not verify whether restored subagent terminal target ${label} closed: ${errorMessage(error)}`;
      return update("disconnected", closeError ? `${closeError}; ${suffix}` : suffix);
    }
  }));
}

export function isActive(status: RunStatus): boolean {
  return status === "created" || status === "starting" || status === "running";
}

function normalizeRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const run = value as Record<string, unknown>;
  const version = run["version"];
  const legacySub = version === 1;
  const legacyShared = version === 1 || version === 2;
  const hostTarget = normalizeHostTarget(run, version);
  const mode = legacySub ? "sub" : run["mode"];
  const workspace = legacyShared ? "shared" : run["workspace"];
  const worktree = legacyShared ? undefined : normalizeWorktreeRecord(run["worktree"]);
  const validWorkspace = isValidWorkspaceSnapshot(run, mode, workspace, worktree);
  const validModel = typeof run["model"] === "string" || (mode === "main" && run["model"] === undefined);
  const validThinking = isThinkingLevel(run["thinking"]) || (mode === "main" && run["thinking"] === undefined);
  if ((version !== 1 && version !== 2 && version !== 3 && version !== 4)
    || (mode !== "sub" && mode !== "main")
    || !validWorkspace
    || typeof run["runId"] !== "string"
    || typeof run["alias"] !== "string"
    || typeof run["taskPreview"] !== "string"
    || !isNonEmptyString(run["cwd"])
    || !isAbsolute(run["cwd"])
    || !validModel
    || !validThinking
    || !isOneOf(run["placement"], ["pane", "window", "session"])
    || !isOneOf(run["status"], ["created", "starting", "running", "completed", "blocked", "failed", "cancelled"])
    || !isOneOf(run["paneState"], ["open", "closed", "disconnected"])
    || typeof run["createdAt"] !== "string"
    || typeof run["updatedAt"] !== "string"
    || OPTIONAL_STRING_FIELDS.some((field) => run[field] !== undefined && typeof run[field] !== "string")
    || !hasValidHostMetadata(run, version, hostTarget)
    || (run["report"] !== undefined && !isSubagentReport(run["report"]))) return undefined;

  const normalized: RunRecord = {
    version: 4,
    mode,
    workspace: workspace as WorkspaceKind,
    ...(worktree ? { worktree } : {}),
    runId: run["runId"],
    alias: run["alias"],
    taskPreview: run["taskPreview"],
    cwd: run["cwd"],
    placement: run["placement"],
    status: run["status"],
    paneState: run["paneState"],
    ...(hostTarget ? { hostTarget } : {}),
    createdAt: run["createdAt"],
    updatedAt: run["updatedAt"],
  };
  if (typeof run["model"] === "string") normalized.model = run["model"];
  if (isThinkingLevel(run["thinking"])) normalized.thinking = run["thinking"];
  for (const field of OPTIONAL_STRING_FIELDS) copyOptionalString(run, normalized, field);
  if (isSubagentReport(run["report"])) normalized.report = run["report"];
  return normalized;
}

function normalizeWorktreeRecord(value: unknown): WorktreeRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const worktree = value as Record<string, unknown>;
  if (!isNonEmptyString(worktree["path"])
    || !isAbsolute(worktree["path"])
    || !isNonEmptyString(worktree["branch"])
    || !isNonEmptyString(worktree["baseCommit"])
    || !isOneOf(worktree["state"], ["present", "removed"])
    || !isNonEmptyString(worktree["gitCommonDir"])
    || !isAbsolute(worktree["gitCommonDir"])
    || !isSafeRepositoryName(worktree["repositoryName"])
    || typeof worktree["relativeCwd"] !== "string"
    || !isSafeRelativeCwd(worktree["relativeCwd"])
    || (worktree["state"] === "present" && worktree["resumeCommit"] !== undefined)
    || (worktree["state"] === "removed" && !isNonEmptyString(worktree["resumeCommit"]))) return undefined;
  const common = {
    path: worktree["path"],
    branch: worktree["branch"],
    baseCommit: worktree["baseCommit"],
    gitCommonDir: worktree["gitCommonDir"],
    repositoryName: worktree["repositoryName"],
    relativeCwd: worktree["relativeCwd"],
  };
  return worktree["state"] === "present"
    ? { ...common, state: "present" }
    : { ...common, state: "removed", resumeCommit: worktree["resumeCommit"] as string };
}

function normalizeHostTarget(run: Record<string, unknown>, version: unknown): HostTarget | undefined {
  if (version === 4) return parseHostTarget(run["hostTarget"]);
  if (!isTmuxId(run["tmuxTarget"], "%")) return undefined;
  if (run["paneState"] !== "disconnected"
    && (!isTmuxId(run["tmuxWindowId"], "@") || !isTmuxId(run["tmuxSessionId"], "$"))) return undefined;
  return {
    host: "tmux",
    paneId: run["tmuxTarget"],
    ...(isTmuxId(run["tmuxWindowId"], "@") ? { windowId: run["tmuxWindowId"] } : {}),
    ...(isTmuxId(run["tmuxSessionId"], "$") ? { sessionId: run["tmuxSessionId"] } : {}),
  };
}

function hasValidHostMetadata(
  run: Record<string, unknown>,
  version: unknown,
  target: HostTarget | undefined,
): boolean {
  if (!isOptionalTmuxId(run["tmuxTarget"], "%")
    || !isOptionalTmuxId(run["tmuxWindowId"], "@")
    || !isOptionalTmuxId(run["tmuxSessionId"], "$")) return false;
  if (version === 4 && run["hostTarget"] !== undefined && !target) return false;
  if (run["paneState"] === "open" || run["paneState"] === "disconnected") {
    if (!target) return false;
  }
  if (run["paneState"] === "open" && target?.host === "tmux" && (!target.windowId || !target.sessionId)) {
    return false;
  }
  if (target?.host === "tmux") {
    return (run["tmuxTarget"] === undefined || run["tmuxTarget"] === target.paneId)
      && (run["tmuxWindowId"] === undefined || run["tmuxWindowId"] === target.windowId)
      && (run["tmuxSessionId"] === undefined || run["tmuxSessionId"] === target.sessionId);
  }
  return run["tmuxTarget"] === undefined
    && run["tmuxWindowId"] === undefined
    && run["tmuxSessionId"] === undefined;
}

function parseHostTarget(value: unknown): HostTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const target = value as Record<string, unknown>;
  if (target["host"] === "tmux"
    && isTmuxId(target["paneId"], "%")
    && isOptionalTmuxId(target["windowId"], "@")
    && isOptionalTmuxId(target["sessionId"], "$")
    && (target["socketPath"] === undefined || isNonEmptyString(target["socketPath"]))) {
    return {
      host: "tmux",
      paneId: target["paneId"],
      ...(isTmuxId(target["windowId"], "@") ? { windowId: target["windowId"] } : {}),
      ...(isTmuxId(target["sessionId"], "$") ? { sessionId: target["sessionId"] } : {}),
      ...(typeof target["socketPath"] === "string" ? { socketPath: target["socketPath"] } : {}),
    };
  }
  if (target["host"] === "cmux"
    && isUuid(target["surfaceId"])
    && isUuid(target["paneId"])
    && isUuid(target["workspaceId"])
    && isUuid(target["windowId"])
    && isNonEmptyString(target["socketPath"])
    && isOneOf(target["closeKind"], ["surface", "workspace"])
    && ((target["groupId"] === undefined && target["groupAnchorWorkspaceId"] === undefined)
      || (isUuid(target["groupId"]) && isUuid(target["groupAnchorWorkspaceId"])))
    && (target["dedicatedWorkspace"] === undefined || target["dedicatedWorkspace"] === true)
    && (target["dedicatedWorkspace"] !== true || target["closeKind"] === "surface")) {
    return {
      host: "cmux",
      surfaceId: target["surfaceId"],
      paneId: target["paneId"],
      workspaceId: target["workspaceId"],
      windowId: target["windowId"],
      socketPath: target["socketPath"],
      closeKind: target["closeKind"],
      ...(isUuid(target["groupId"]) ? { groupId: target["groupId"] } : {}),
      ...(isUuid(target["groupAnchorWorkspaceId"])
        ? { groupAnchorWorkspaceId: target["groupAnchorWorkspaceId"] }
        : {}),
      ...(target["dedicatedWorkspace"] === true ? { dedicatedWorkspace: true } : {}),
    };
  }
  if (target["host"] === "headless"
    && typeof target["pid"] === "number"
    && Number.isSafeInteger(target["pid"])
    && target["pid"] > 0
    && isNonEmptyString(target["startedAt"])) {
    return { host: "headless", pid: target["pid"], startedAt: target["startedAt"] };
  }
  return undefined;
}

function isOptionalTmuxId(value: unknown, prefix: "%" | "@" | "$"): boolean {
  return value === undefined || isTmuxId(value, prefix);
}

function isTmuxId(value: unknown, prefix: "%" | "@" | "$"): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && /^[0-9]+$/u.test(value.slice(1));
}

function isValidWorkspaceSnapshot(
  run: Record<string, unknown>,
  mode: unknown,
  workspace: unknown,
  worktree: WorktreeRecord | undefined,
): boolean {
  if (workspace === "shared") return run["worktree"] === undefined;
  if (workspace !== "worktree" || mode !== "main") return false;
  if (!isOneOf(run["status"], ["created", "starting", "running", "completed", "blocked", "failed", "cancelled"])
    || !isOneOf(run["paneState"], ["open", "closed", "disconnected"])) return false;

  const status = run["status"];
  const paneState = run["paneState"];
  if (!worktree) {
    return run["worktree"] === undefined
      && paneState === "closed"
      && isOneOf(status, ["created", "starting", "failed", "cancelled"]);
  }
  if (typeof run["runId"] !== "string" || worktree.branch !== `heishi/${run["runId"]}`) return false;
  if (worktree.state === "removed") return isTerminal(status) && paneState !== "open";
  if (status === "starting") return paneState === "closed" || paneState === "open";
  if (status === "running") return paneState === "open";
  return isTerminal(status);
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "cancelled";
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
  const status = report["status"];
  const hasValidRequest = isExternalInputRequest(report["request"]);
  return isOneOf(status, ["completed", "blocked", "failed"])
    && typeof report["summary"] === "string"
    && typeof report["structured"] === "boolean"
    && (report["verification"] === undefined || typeof report["verification"] === "string")
    && (report["remainingRisk"] === undefined || typeof report["remainingRisk"] === "string")
    && (status === "blocked" ? hasValidRequest : report["request"] === undefined);
}

function isExternalInputRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return isOneOf(request["kind"], ["question", "confirmation", "decision", "missing_context", "permission"])
    && typeof request["prompt"] === "string"
    && request["prompt"].trim().length > 0
    && (request["detail"] === undefined || typeof request["detail"] === "string")
    && (request["recommendation"] === undefined || typeof request["recommendation"] === "string")
    && (request["options"] === undefined
      || (Array.isArray(request["options"]) && request["options"].every((option) => typeof option === "string")));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeRepositoryName(value: unknown): value is string {
  return isNonEmptyString(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
