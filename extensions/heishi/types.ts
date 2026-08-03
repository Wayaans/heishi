import type { Placement, ThinkingLevel } from "./tmux.js";

export type RunStatus = "created" | "starting" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type PaneState = "open" | "closed" | "disconnected";

export interface SubagentReport {
  status: "completed" | "blocked" | "failed";
  summary: string;
  verification?: string;
  remainingRisk?: string;
  structured: boolean;
}

export interface RunRecord {
  version: 1;
  runId: string;
  alias: string;
  taskPreview: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
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
  task: string;
  alias?: string;
  model: string;
  thinking: ThinkingLevel;
  placement?: Placement;
}

export type ControlAction = "prompt" | "steer" | "follow_up" | "abort" | "focus" | "resume";

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
  model: string;
  thinking: ThinkingLevel;
  report?: SubagentReport;
  error?: string;
}

export function resultFromRun(run: RunRecord): RunResult {
  const result: RunResult = {
    runId: run.runId,
    alias: run.alias,
    status: run.status,
    model: run.model,
    thinking: run.thinking,
  };
  if (run.tmuxTarget !== undefined) result.tmuxTarget = run.tmuxTarget;
  if (run.tmuxWindowId !== undefined) result.tmuxWindowId = run.tmuxWindowId;
  if (run.tmuxSessionId !== undefined) result.tmuxSessionId = run.tmuxSessionId;
  if (run.workerSessionId !== undefined) result.workerSessionId = run.workerSessionId;
  if (run.workerSessionFile !== undefined) result.workerSessionFile = run.workerSessionFile;
  if (run.report !== undefined) result.report = run.report;
  if (run.error !== undefined) result.error = run.error;
  return result;
}
