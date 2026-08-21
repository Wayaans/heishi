import type { Placement, ThinkingLevel } from "./tmux.js";

export type WorkerMode = "sub" | "main";
export type WorkspaceKind = "shared" | "worktree";
export type WorktreeState = "present" | "removed";
export type RunStatus = "created" | "starting" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type PaneState = "open" | "closed" | "disconnected";

export type ExternalInputKind = "question" | "confirmation" | "decision" | "missing_context" | "permission";

export interface ExternalInputRequest {
  kind: ExternalInputKind;
  prompt: string;
  detail?: string;
  options?: string[];
  recommendation?: string;
}

export interface SubagentReport {
  status: "completed" | "blocked" | "failed";
  summary: string;
  verification?: string;
  remainingRisk?: string;
  request?: ExternalInputRequest;
  structured: boolean;
}

interface WorktreeRecordBase {
  path: string;
  branch: string;
  baseCommit: string;
  gitCommonDir: string;
  repositoryName: string;
  relativeCwd: string;
}

export interface PresentWorktreeRecord extends WorktreeRecordBase {
  state: "present";
  resumeCommit?: never;
}

export interface RemovedWorktreeRecord extends WorktreeRecordBase {
  state: "removed";
  resumeCommit: string;
}

export type WorktreeRecord = PresentWorktreeRecord | RemovedWorktreeRecord;

export interface RunRecord {
  version: 3;
  mode: WorkerMode;
  workspace: WorkspaceKind;
  worktree?: WorktreeRecord;
  runId: string;
  alias: string;
  taskPreview: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  placement: Placement;
  status: RunStatus;
  paneState: PaneState;
  tmuxTarget?: string;
  tmuxWindowId?: string;
  tmuxSessionId?: string;
  workerSessionId?: string;
  workerSessionFile?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  report?: SubagentReport;
  error?: string;
}

export interface StartInput {
  mode?: WorkerMode;
  task: string;
  alias?: string;
  model?: string;
  thinking?: ThinkingLevel;
  placement?: Placement;
  workspace?: WorkspaceKind;
}

export type ControlAction = "prompt" | "steer" | "follow_up" | "abort" | "focus" | "resume" | "cleanup";

export interface ControlInput {
  runId: string;
  action: ControlAction;
  message?: string;
}

export interface RunResult {
  runId: string;
  alias: string;
  status: RunStatus;
  tmuxTarget?: string;
  tmuxWindowId?: string;
  tmuxSessionId?: string;
  workerSessionId?: string;
  workerSessionFile?: string;
  mode?: "main";
  workspace?: "worktree";
  worktree?: Pick<WorktreeRecord, "path" | "branch" | "baseCommit" | "state">;
  model?: string;
  thinking?: ThinkingLevel;
  report?: SubagentReport;
  error?: string;
}

export interface WaitResult extends RunResult {
  durationMs: number;
}

export function resultFromRun(run: RunRecord): RunResult {
  const result: RunResult = {
    runId: run.runId,
    alias: run.alias,
    status: run.status,
  };
  if (run.mode === "main") result.mode = "main";
  if (run.workspace === "worktree") {
    result.workspace = "worktree";
  }
  if (run.worktree) {
    result.worktree = {
      path: run.worktree.path,
      branch: run.worktree.branch,
      baseCommit: run.worktree.baseCommit,
      state: run.worktree.state,
    };
  }
  if (run.model !== undefined) result.model = run.model;
  if (run.thinking !== undefined) result.thinking = run.thinking;
  if (run.tmuxTarget !== undefined) result.tmuxTarget = run.tmuxTarget;
  if (run.tmuxWindowId !== undefined) result.tmuxWindowId = run.tmuxWindowId;
  if (run.tmuxSessionId !== undefined) result.tmuxSessionId = run.tmuxSessionId;
  if (run.workerSessionId !== undefined) result.workerSessionId = run.workerSessionId;
  if (run.workerSessionFile !== undefined) result.workerSessionFile = run.workerSessionFile;
  if (run.report !== undefined) result.report = run.report;
  if (run.error !== undefined) result.error = run.error;
  return result;
}
