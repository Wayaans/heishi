import { isAbsolute, normalize, posix, win32 } from "node:path";
import type { WorkerMode, WorkspaceKind } from "./types.js";

export function resolveWorkspace(
  mode: WorkerMode,
  requested: WorkspaceKind | undefined,
  mainDefault: WorkspaceKind = "shared",
): WorkspaceKind {
  if (mode === "sub") {
    if (requested === "worktree") {
      throw new Error("Git worktree workspace is available only in main mode");
    }
    return "shared";
  }
  return requested ?? mainDefault;
}

export function isSafeRelativeCwd(value: string): boolean {
  if (!value || isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
  const normalized = normalize(value);
  return normalized !== ".."
    && !normalized.split(/[\\/]/u).includes("..");
}
