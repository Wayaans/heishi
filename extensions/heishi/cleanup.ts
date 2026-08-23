import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CleanupApproval } from "./model-config.js";
import type { ControlInput, RunRecord, RunResult } from "./types.js";

interface CleanupCoordinator {
  validateCleanup(runId: string): Promise<RunRecord>;
  control(input: ControlInput): Promise<RunResult>;
}

interface CleanupContext {
  mode: ExtensionContext["mode"];
  ui: Pick<ExtensionContext["ui"], "confirm">;
}

export class WorktreeCleanupApproval {
  private confirmationTail: Promise<void> = Promise.resolve();

  async execute(
    coordinator: CleanupCoordinator,
    runId: string,
    approval: CleanupApproval,
    ctx: CleanupContext,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (approval === "allow") {
      return coordinator.control({ runId, action: "cleanup" });
    }
    if (ctx.mode !== "tui") {
      throw new Error("Worktree cleanup requires confirmation in the interactive TUI");
    }
    return this.enqueueConfirmation(() => this.confirmAndCleanup(coordinator, runId, ctx, signal));
  }

  private enqueueConfirmation(operation: () => Promise<RunResult>): Promise<RunResult> {
    const result = this.confirmationTail.then(operation, operation);
    this.confirmationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async confirmAndCleanup(
    coordinator: CleanupCoordinator,
    runId: string,
    ctx: CleanupContext,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (signal?.aborted) throw new Error("Worktree cleanup cancelled");
    const run = await coordinator.validateCleanup(runId);
    if (!run.worktree) throw new Error("Worktree run has no prepared workspace to clean up");
    const confirmed = await ctx.ui.confirm(
      `Remove ${run.alias}'s worktree?`,
      `Run: ${run.alias}\nPath: ${run.worktree.path}\nBranch ${run.worktree.branch} will be retained.`,
      signal ? { signal } : undefined,
    );
    if (!confirmed) {
      throw new Error(`Worktree cleanup cancelled for ${run.alias}: ${run.worktree.path}`);
    }
    return coordinator.control({ runId, action: "cleanup" });
  }
}
