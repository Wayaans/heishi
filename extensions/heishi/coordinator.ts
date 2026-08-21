import { randomInt, randomUUID } from "node:crypto";
import type { IpcAdapter, WorkerChannel, WorkerReady } from "./ipc.js";
import type { ProtocolEnvelope } from "./protocol.js";
import { isActive } from "./registry.js";
import { buildPiCommand, THINKING_LEVELS, type ThinkingLevel, type TmuxAdapter, type TmuxTarget } from "./tmux.js";
import {
  resultFromRun,
  type ControlInput,
  type ExternalInputRequest,
  type RunRecord,
  type RunResult,
  type StartInput,
  type SubagentReport,
  type WaitResult,
  type WorkerMode,
} from "./types.js";
import { WorktreeOperationError, worktreeCwd, type WorktreeAdapter } from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";

const SUBAGENT_SESSION_NAME = "heishi-subagents";
const MAIN_READINESS_TIMEOUT_MS = 60_000;
const DELEGATION_HEADER = `[Delegation from parent agent]
This is a fresh session. You do not have the parent conversation.
The complete task brief follows:`;

const MYTHOLOGICAL_NAMES = [
  "Achilles", "Andromeda", "Ariadne", "Atalanta", "Cassandra", "Circe", "Daedalus", "Electra",
  "Hector", "Icarus", "Medea", "Odysseus", "Orpheus", "Perseus", "Theseus",
] as const;

export interface CoordinatorDependencies {
  cwd: string;
  extensionPath: string;
  piPath: string;
  tmux: TmuxAdapter;
  ipc: IpcAdapter;
  worktrees: WorktreeAdapter;
  persist(record: RunRecord): void;
  projectTrusted: boolean;
  newRunId?: () => string;
  newToken?: () => string;
  chooseAlias?: () => string;
  now?: () => string;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface Runtime {
  channel: WorkerChannel;
  settled: Deferred;
  autoClose: boolean;
  finishing: boolean;
  aborting: boolean;
}

interface StartOperation {
  cancellationRequested: boolean;
  settled: Deferred;
}

interface LifecycleOperation {
  action: "cleanup" | "resume";
  cancellationRequested: boolean;
  settled: Deferred;
}

type RunChanges = Omit<Partial<RunRecord>, "report" | "error"> & {
  report?: SubagentReport | undefined;
  error?: string | undefined;
};

export class RunCoordinator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly startOperations = new Map<string, StartOperation>();
  private readonly lifecycleOperations = new Map<string, LifecycleOperation>();
  private readonly newRunId: () => string;
  private readonly newToken: () => string;
  private readonly chooseAlias: () => string;
  private readonly now: () => string;
  private shuttingDown = false;

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.newRunId = dependencies.newRunId ?? randomUUID;
    this.newToken = dependencies.newToken ?? randomUUID;
    this.chooseAlias = dependencies.chooseAlias ?? (() => MYTHOLOGICAL_NAMES[randomInt(MYTHOLOGICAL_NAMES.length)] ?? "Atalanta");
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async start(input: StartInput, signal?: AbortSignal): Promise<RunResult> {
    if (this.shuttingDown) throw new Error("Cannot start while the subagent coordinator is shutting down");
    const mode = input.mode ?? "sub";
    const workspace = resolveWorkspace(mode, input.workspace);
    validateStart(input);
    if (signal?.aborted) throw new Error("Subagent start was cancelled");

    const runId = this.newRunId();
    const timestamp = this.now();
    const run: RunRecord = {
      version: 3,
      mode,
      workspace,
      runId,
      alias: resolveAlias(input.alias, this.chooseAlias),
      taskPreview: preview(input.task),
      cwd: this.dependencies.cwd,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      placement: input.placement ?? (mode === "main" ? "window" : "session"),
      status: "created",
      paneState: "closed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.runs.set(runId, run);
    this.persist(run);
    const startOperation = createStartOperation();
    this.startOperations.set(runId, startOperation);

    let abortListener: (() => void) | undefined;
    let launchAttempted = false;
    try {
      throwIfStartCancelled(startOperation, signal);
      await this.dependencies.tmux.validate();
      throwIfStartCancelled(startOperation, signal);
      this.update(run, { status: "starting" });
      if (run.workspace === "worktree") {
        throwIfStartCancelled(startOperation, signal);
        const worktree = await this.dependencies.worktrees.prepare(run.cwd, run.runId);
        this.update(run, { worktree });
        throwIfStartCancelled(startOperation, signal);
      }
      throwIfStartCancelled(startOperation, signal);
      const token = this.newToken();
      const channel = await this.dependencies.ipc.open(
        runId,
        token,
        (event) => this.handleWorkerEvent(runId, event),
      );
      const runtime: Runtime = {
        channel,
        settled: deferred(),
        autoClose: true,
        finishing: false,
        aborting: false,
      };
      this.runtimes.set(runId, runtime);
      throwIfStartCancelled(startOperation, signal);

      launchAttempted = true;
      await this.launchWorker(run, runtime, token, false);
      throwIfStartCancelled(startOperation, signal);

      if (signal) {
        abortListener = () => { void this.abortRun(runId); };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      throwIfStartCancelled(startOperation, signal);
      const ready = await waitForWorkerReady(channel, run.mode);
      throwIfStartCancelled(startOperation, signal);
      this.update(run, {
        workerSessionId: ready.sessionId,
        workerSessionFile: ready.sessionFile,
      });
      verifyInitialReady(run, ready, input.model, input.thinking);
      this.update(run, { model: ready.model, thinking: parseThinkingLevel(ready.thinking) });
      const workspaceNote = run.workspace === "worktree" && run.worktree
        ? `\n\nYou are isolated in Git worktree ${run.worktree.path} on branch ${run.worktree.branch}. Do not merge into the source checkout. Report Git status when you finish.`
        : "";
      throwIfStartCancelled(startOperation, signal);
      await channel.send("task", { task: `${DELEGATION_HEADER}\n\n${input.task}${workspaceNote}` });
      throwIfStartCancelled(startOperation, signal);
      this.update(run, { status: "running", startedAt: this.now() });
      throwIfStartCancelled(startOperation, signal);
      return resultFromRun(run);
    } catch (error) {
      if (error instanceof WorktreeOperationError) run.worktree = error.worktree;
      let rollbackProblem: string | undefined;
      if (!(error instanceof WorktreeOperationError)
        && !launchAttempted
        && run.workspace === "worktree"
        && run.worktree?.state === "present") {
        try {
          const rollback = await this.dependencies.worktrees.rollback(run.worktree);
          run.worktree = rollback.worktree;
          if (rollback.warning) rollbackProblem = `worktree rollback warning: ${rollback.warning}`;
        } catch (rollbackError) {
          if (rollbackError instanceof WorktreeOperationError) run.worktree = rollbackError.worktree;
          rollbackProblem = `worktree rollback was refused: ${errorMessage(rollbackError)}`;
        }
      }
      const startupError = rollbackProblem
        ? new Error(`${errorMessage(error)}; ${rollbackProblem}`)
        : error;
      const cancelled = startOperation.cancellationRequested
        || signal?.aborted === true
        || error instanceof StartCancellationError;
      if (cancelled) {
        const cancellationMessage = rollbackProblem
          ? `Subagent start was cancelled; ${rollbackProblem}`
          : "Subagent start was cancelled";
        await this.cancelStartup(run, cancellationMessage);
        throw new StartCancellationError(cancellationMessage);
      }
      await this.failStartup(run, startupError);
      return resultFromRun(run);
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (this.startOperations.get(runId) === startOperation) this.startOperations.delete(runId);
      startOperation.settled.resolve();
    }
  }

  async control(input: ControlInput): Promise<RunResult> {
    const run = this.requireRun(input.runId);
    if (requiresMessage(input.action) && !input.message?.trim()) {
      throw new Error(`message is required for subagent ${input.action}`);
    }

    if (input.action === "focus") {
      if (run.paneState !== "open" || !run.tmuxTarget) throw new Error("Subagent pane is not open");
      await this.dependencies.tmux.focus(run.tmuxTarget);
      return resultFromRun(run);
    }
    if (input.action === "resume") {
      return this.runLifecycleOperation(run, "resume", (lifecycle) => this.resume(run, lifecycle));
    }
    if (input.action === "cleanup") {
      return this.runLifecycleOperation(run, "cleanup", () => this.cleanup(run));
    }
    if (input.action === "abort") {
      await this.abortRun(run.runId);
      return resultFromRun(run);
    }

    const runtime = this.runtimes.get(run.runId);
    if (!runtime || run.paneState !== "open") throw new Error("Subagent is not connected; resume it first");
    const startsWork = input.action === "prompt" || input.action === "follow_up";
    const previousRun = structuredClone(run);
    const previousSettled = runtime.settled;
    const previousAutoClose = runtime.autoClose;
    runtime.autoClose = true;
    if (startsWork) {
      if (!isActive(run.status)) runtime.settled = deferred();
      this.update(run, { status: "running", report: undefined, error: undefined, startedAt: this.now() });
    }
    try {
      await runtime.channel.send(input.action, { message: input.message as string });
    } catch (error) {
      if (this.runtimes.get(run.runId) === runtime) {
        runtime.autoClose = previousAutoClose;
        if (startsWork) {
          runtime.settled = previousSettled;
          this.runs.set(run.runId, previousRun);
          this.persist(previousRun);
        }
      }
      throw error;
    }
    return resultFromRun(this.requireRun(run.runId));
  }

  async wait(runId: string, signal?: AbortSignal): Promise<WaitResult> {
    const run = this.requireRun(runId);
    const runtime = this.runtimes.get(runId);
    let abortListener: (() => void) | undefined;
    if (signal && runtime) {
      abortListener = () => { void this.abortRun(runId); };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      if (isActive(run.status) && runtime) await runtime.settled.promise;
      const settledRun = this.requireRun(runId);
      const startedAt = Date.parse(settledRun.startedAt ?? settledRun.createdAt);
      const endedAt = Date.parse(settledRun.completedAt ?? (isActive(settledRun.status) ? this.now() : settledRun.updatedAt));
      return { ...resultFromRun(settledRun), durationMs: Math.max(0, endedAt - startedAt) };
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  list(): RunRecord[] {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  async validateCleanup(runId: string): Promise<RunRecord> {
    if (this.shuttingDown) throw new Error("Cannot cleanup while the subagent coordinator is shutting down");
    const run = this.requireRun(runId);
    if (this.lifecycleOperations.has(runId)) {
      throw new Error(`Another cleanup or resume operation is already in progress for ${runId}`);
    }
    if (this.runtimes.has(runId)) {
      throw new Error("Cannot cleanup while the subagent runtime is still open or finalizing");
    }
    const lifecycle = lifecycleOperation("cleanup");
    this.lifecycleOperations.set(runId, lifecycle);
    try {
      await this.dependencies.worktrees.validateCleanup(this.cleanupWorktree(run));
      return structuredClone(run);
    } finally {
      this.lifecycleOperations.delete(runId);
      lifecycle.settled.resolve();
    }
  }

  restore(runs: RunRecord[]): void {
    this.runs.clear();
    for (const run of runs) this.runs.set(run.runId, structuredClone(run));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const starts = [...this.startOperations.values()];
    for (const start of starts) start.cancellationRequested = true;
    const lifecycles = [...this.lifecycleOperations.values()];
    for (const lifecycle of lifecycles) {
      if (lifecycle.action === "resume") lifecycle.cancellationRequested = true;
    }
    await Promise.all([
      ...[...this.runtimes.keys()].map((runId) => this.abortRuntime(runId)),
      ...starts.map((start) => start.settled.promise),
      ...lifecycles.map((lifecycle) => lifecycle.settled.promise),
    ]);
  }

  private async runLifecycleOperation(
    run: RunRecord,
    action: "cleanup" | "resume",
    operation: (lifecycle: LifecycleOperation) => Promise<RunResult>,
  ): Promise<RunResult> {
    if (this.shuttingDown) {
      throw new Error(`Cannot ${action} while the subagent coordinator is shutting down`);
    }
    if (this.lifecycleOperations.has(run.runId)) {
      throw new Error(`Another cleanup or resume operation is already in progress for ${run.runId}`);
    }
    if (this.runtimes.has(run.runId)) {
      throw new Error(`Cannot ${action} while the subagent runtime is still open or finalizing`);
    }
    const lifecycle = lifecycleOperation(action);
    this.lifecycleOperations.set(run.runId, lifecycle);
    try {
      return await operation(lifecycle);
    } finally {
      this.lifecycleOperations.delete(run.runId);
      lifecycle.settled.resolve();
    }
  }

  private async cleanup(run: RunRecord): Promise<RunResult> {
    try {
      const worktree = await this.dependencies.worktrees.cleanup(this.cleanupWorktree(run));
      this.update(run, { worktree });
      return resultFromRun(run);
    } catch (error) {
      if (error instanceof WorktreeOperationError) {
        this.update(run, { worktree: error.worktree, error: error.message });
      }
      throw error;
    }
  }

  private cleanupWorktree(run: RunRecord): NonNullable<RunRecord["worktree"]> {
    if (run.workspace !== "worktree") throw new Error("Shared workspace runs cannot be cleaned up");
    if (!run.worktree) throw new Error("Worktree run has no prepared workspace to clean up");
    if (isActive(run.status)) throw new Error("Worktree cleanup requires a settled run");
    if (run.paneState !== "closed") throw new Error("Verify the subagent pane is closed before worktree cleanup");
    return run.worktree;
  }

  private async resume(run: RunRecord, lifecycle: LifecycleOperation): Promise<RunResult> {
    if (run.paneState !== "closed") throw new Error("Verify the subagent pane is closed before resume");
    if (!run.workerSessionFile || !run.workerSessionId) {
      throw new Error("Subagent has no persisted worker session to resume");
    }
    const token = this.newToken();
    let launchedTarget: TmuxTarget | undefined;
    try {
      throwIfResumeCancelled(lifecycle);
      await this.dependencies.tmux.validate();
      throwIfResumeCancelled(lifecycle);
      if (run.workspace === "worktree") {
        if (!run.worktree) throw new Error("Worktree run is missing workspace metadata");
        throwIfResumeCancelled(lifecycle);
        this.update(run, { worktree: await this.dependencies.worktrees.prepareResume(run.worktree) });
        throwIfResumeCancelled(lifecycle);
      }
      throwIfResumeCancelled(lifecycle);
      const channel = await this.dependencies.ipc.open(
        run.runId,
        token,
        (event) => this.handleWorkerEvent(run.runId, event),
      );
      const runtime: Runtime = {
        channel,
        settled: resolvedDeferred(),
        autoClose: false,
        finishing: false,
        aborting: false,
      };
      this.runtimes.set(run.runId, runtime);
      throwIfResumeCancelled(lifecycle);
      launchedTarget = await this.launchWorker(run, runtime, token, true);
      throwIfResumeCancelled(lifecycle);
      const ready = await waitForWorkerReady(channel, run.mode);
      throwIfResumeCancelled(lifecycle);
      if (run.mode === "sub") verifyInitialReady(run, ready, run.model, run.thinking);
      if (ready.sessionId !== run.workerSessionId) {
        throw new Error(`Subagent resumed session ${ready.sessionId}, expected ${run.workerSessionId}`);
      }
      throwIfResumeCancelled(lifecycle);
      this.update(run, { model: ready.model, thinking: parseThinkingLevel(ready.thinking) });
      throwIfResumeCancelled(lifecycle);
      return resultFromRun(run);
    } catch (error) {
      const cancelled = lifecycle.cancellationRequested || error instanceof ResumeCancellationError;
      const runtime = this.runtimes.get(run.runId);
      if (runtime) runtime.finishing = true;
      await runtime?.channel.close().catch(() => undefined);
      const paneResult = launchedTarget
        ? await this.closePaneAndVerify(launchedTarget.paneId)
        : undefined;
      const worktree = error instanceof WorktreeOperationError ? error.worktree : undefined;
      const failure = cancelled
        ? combineErrors(
          "Subagent resume was cancelled",
          error instanceof ResumeCancellationError ? undefined : errorMessage(error),
        )
        : errorMessage(error);
      const persistedError = combineErrors(failure, paneResult?.error);
      this.update(run, {
        ...(worktree ? { worktree } : {}),
        ...(paneResult ? { paneState: paneResult.paneState } : cancelled ? { paneState: "closed" } : {}),
        ...(cancelled ? { status: "cancelled", completedAt: this.now() } : {}),
        error: persistedError,
      });
      this.runtimes.delete(run.runId);
      runtime?.settled.resolve();
      if (cancelled) throw new ResumeCancellationError(persistedError);
      throw error;
    }
  }

  private async launchWorker(
    run: RunRecord,
    runtime: Runtime,
    token: string,
    resume: boolean,
  ): Promise<TmuxTarget> {
    const title = `${run.alias} · ${shortId(run.runId)}`;
    const commandOptions = {
      mode: run.mode,
      piPath: this.dependencies.piPath,
      extensionPath: this.dependencies.extensionPath,
      ...(!resume || run.mode === "sub" ? {
        ...(run.model !== undefined ? { model: run.model } : {}),
        ...(run.thinking !== undefined ? { thinking: run.thinking } : {}),
      } : {}),
      name: `Subagent: ${title}`,
      projectTrusted: this.dependencies.projectTrusted,
      ...(resume && run.workerSessionFile ? { sessionFile: run.workerSessionFile } : {}),
    };
    const target = await this.dependencies.tmux.launch({
      placement: run.placement,
      ...(run.placement === "session" ? { sessionName: SUBAGENT_SESSION_NAME } : {}),
      cwd: run.workspace === "worktree" && run.worktree ? worktreeCwd(run.worktree) : run.cwd,
      title,
      command: buildPiCommand(commandOptions),
      environment: workerEnvironment(run.runId, token, runtime.channel.socketPath, resume, run.mode),
    });
    this.update(run, {
      paneState: "open",
      tmuxTarget: target.paneId,
      tmuxWindowId: target.windowId,
      tmuxSessionId: target.sessionId,
    });
    return target;
  }

  private async handleWorkerEvent(runId: string, event: ProtocolEnvelope): Promise<void> {
    const run = this.runs.get(runId);
    const runtime = this.runtimes.get(runId);
    if (!run || !runtime || runtime.finishing) return;

    if (event.type === "report") {
      const report = parseReport(event["report"]);
      this.update(run, { report });
      return;
    }
    if (event.type === "metadata" && run.mode === "main") {
      const model = event["model"];
      const thinking = event["thinking"];
      if (typeof model !== "string" || !model) throw new Error("Subagent metadata is missing its model");
      this.update(run, { model, thinking: parseThinkingLevel(thinking) });
      return;
    }
    if (event.type === "progress" && event["workStarted"] === true) {
      if (!isActive(run.status)) runtime.settled = deferred();
      this.update(run, {
        status: "running",
        startedAt: this.now(),
        ...(event["resetReport"] === true || !isActive(run.status) ? { report: undefined, error: undefined } : {}),
      });
      return;
    }
    if (event.type === "settled") {
      if (runtime.aborting) {
        await this.finish(run, "cancelled", run.report, true);
        return;
      }
      const report = run.report ?? {
        status: "completed" as const,
        summary: typeof event["finalText"] === "string" && event["finalText"].trim()
          ? event["finalText"].trim()
          : "Subagent settled without a structured report.",
        structured: false,
      };
      if (runtime.autoClose) {
        await this.finish(run, report.status, report, true);
      } else {
        this.update(run, { status: report.status, report, completedAt: this.now() });
        runtime.settled.resolve();
        runtime.settled = resolvedDeferred();
      }
      return;
    }
    if (event.type === "error") {
      const message = typeof event["message"] === "string" ? event["message"] : "Subagent failed";
      await this.finish(run, "failed", run.report, true, message);
      return;
    }
    if (event.type === "disconnect") {
      if (isActive(run.status)) await this.finish(run, "failed", run.report, true, "Subagent disconnected");
      else await this.finish(run, run.status, run.report, true);
    }
  }

  private async cancelStartup(run: RunRecord, cancellationMessage: string): Promise<void> {
    const runtime = this.runtimes.get(run.runId);
    if (runtime) {
      if (runtime.finishing) {
        await runtime.settled.promise;
      } else {
        await this.finish(
          run,
          isActive(run.status) ? "cancelled" : run.status,
          run.report,
          true,
          isActive(run.status) ? cancellationMessage : undefined,
        );
      }
    }
    if (!runtime && run.tmuxTarget && run.paneState !== "closed") {
      const paneResult = await this.closePaneAndVerify(run.tmuxTarget);
      this.update(run, {
        paneState: paneResult.paneState,
        ...(isActive(run.status) ? { status: "cancelled", completedAt: this.now() } : {}),
        error: combineErrors(run.error ?? cancellationMessage, paneResult.error),
      });
    } else if (isActive(run.status)) {
      this.update(run, {
        status: "cancelled",
        paneState: "closed",
        completedAt: this.now(),
        error: cancellationMessage,
      });
    } else if (cancellationMessage !== "Subagent start was cancelled") {
      this.update(run, { error: combineErrors(run.error, cancellationMessage) });
    }
  }

  private async abortRun(runId: string): Promise<void> {
    const lifecycle = this.lifecycleOperations.get(runId);
    if (lifecycle?.action === "resume") {
      lifecycle.cancellationRequested = true;
      await lifecycle.settled.promise;
    }
    await this.abortRuntime(runId);
  }

  private async abortRuntime(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    const runtime = this.runtimes.get(runId);
    if (!run || !runtime || runtime.finishing) return;
    runtime.aborting = true;
    await runtime.channel.send("abort").catch(() => undefined);
    await Promise.race([
      runtime.settled.promise,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    if (this.runtimes.has(runId)) await this.finish(run, "cancelled", run.report, true);
  }

  private async finish(
    run: RunRecord,
    status: RunRecord["status"],
    report: SubagentReport | undefined,
    closePane: boolean,
    error?: string,
  ): Promise<void> {
    const runtime = this.runtimes.get(run.runId);
    if (!runtime || runtime.finishing) return;
    runtime.finishing = true;
    await runtime.channel.close().catch(() => undefined);
    const paneResult = closePane
      ? run.tmuxTarget
        ? await this.closePaneAndVerify(run.tmuxTarget)
        : { paneState: "closed" as const }
      : { paneState: "disconnected" as const };
    this.update(run, {
      status,
      paneState: paneResult.paneState,
      completedAt: this.now(),
      ...(report ? { report } : {}),
      ...(error || paneResult.error ? { error: combineErrors(error, paneResult.error) } : {}),
    });
    this.runtimes.delete(run.runId);
    runtime.settled.resolve();
  }

  private async failStartup(run: RunRecord, error: unknown): Promise<void> {
    const runtime = this.runtimes.get(run.runId);
    if (runtime) {
      runtime.finishing = true;
      await runtime.channel.close().catch(() => undefined);
    }
    const paneResult = run.tmuxTarget
      ? await this.closePaneAndVerify(run.tmuxTarget)
      : { paneState: "closed" as const };
    this.update(run, {
      status: "failed",
      paneState: paneResult.paneState,
      completedAt: this.now(),
      error: combineErrors(errorMessage(error), paneResult.error),
    });
    this.runtimes.delete(run.runId);
    runtime?.settled.resolve();
  }

  private async closePaneAndVerify(target: string): Promise<{
    paneState: "closed" | "open" | "disconnected";
    error?: string;
  }> {
    let closeError: string | undefined;
    try {
      await this.dependencies.tmux.close(target);
    } catch (error) {
      closeError = `Could not close subagent pane ${target}: ${errorMessage(error)}`;
    }
    try {
      if (!await this.dependencies.tmux.exists(target)) return { paneState: "closed" };
      return {
        paneState: "open",
        error: combineErrors(closeError, `Subagent pane ${target} still exists after close`),
      };
    } catch (error) {
      return {
        paneState: "disconnected",
        error: combineErrors(
          closeError,
          `Could not verify whether subagent pane ${target} closed: ${errorMessage(error)}`,
        ),
      };
    }
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown subagent run: ${runId}`);
    return run;
  }

  private update(run: RunRecord, changes: RunChanges): void {
    Object.assign(run, changes, { updatedAt: this.now() });
    if (changes.report === undefined && "report" in changes) delete run.report;
    if (changes.error === undefined && "error" in changes) delete run.error;
    this.persist(run);
  }

  private persist(run: RunRecord): void {
    this.dependencies.persist(structuredClone(run));
  }
}

function verifyInitialReady(
  run: RunRecord,
  ready: WorkerReady,
  requestedModel: string | undefined,
  requestedThinking: ThinkingLevel | undefined,
): void {
  if (requestedModel !== undefined && ready.model !== requestedModel) {
    throw new Error(`Subagent requested model ${requestedModel}, but Pi started ${ready.model}`);
  }
  if (requestedThinking !== undefined && ready.thinking !== requestedThinking) {
    throw new Error(`Subagent requested thinking ${requestedThinking}, but Pi started ${ready.thinking}`);
  }
  if (run.mode === "sub" && (requestedModel === undefined || requestedThinking === undefined)) {
    throw new Error("Subagent model and thinking are required");
  }
  parseThinkingLevel(ready.thinking);
}

function waitForWorkerReady(channel: WorkerChannel, mode: WorkerMode): Promise<WorkerReady> {
  return channel.waitForReady(mode === "main" ? MAIN_READINESS_TIMEOUT_MS : undefined);
}

function workerEnvironment(
  runId: string,
  token: string,
  socketPath: string,
  resume: boolean,
  mode: WorkerMode,
): Record<string, string> {
  return {
    HEISHI_WORKER: "1",
    HEISHI_WORKER_MODE: mode,
    HEISHI_RUN_ID: runId,
    HEISHI_TOKEN: token,
    HEISHI_SOCKET: socketPath,
    HEISHI_RESUME: resume ? "1" : "0",
  };
}

function validateStart(input: StartInput): WorkerMode {
  if (!input.task.trim()) throw new Error("Subagent task is required");
  const mode = input.mode ?? "sub";
  if (mode === "main") {
    if (input.thinking !== undefined && !input.model?.trim()) {
      throw new Error("Main-agent thinking requires an explicit model");
    }
    if (input.model !== undefined && !input.model.trim()) throw new Error("Main-agent model is required");
    return mode;
  }
  if (!input.model?.trim()) throw new Error("Subagent model is required");
  if (input.thinking === undefined) throw new Error("Subagent thinking level is required");
  parseThinkingLevel(input.thinking);
  return mode;
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error("Invalid subagent thinking level");
  return value as ThinkingLevel;
}

function resolveAlias(alias: string | undefined, chooseAlias: () => string): string {
  const resolved = (alias ?? chooseAlias()).trim();
  if (!resolved || resolved.length > 60 || /[\x00-\x1f\x7f]/u.test(resolved)) {
    throw new Error("Subagent alias must be 1-60 printable characters");
  }
  return resolved;
}

function preview(task: string): string {
  const compact = task.replace(/\s+/gu, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 99)}…` : compact;
}

function shortId(runId: string): string {
  return runId.slice(0, 6);
}

function requiresMessage(action: ControlInput["action"]): boolean {
  return action === "prompt" || action === "steer" || action === "follow_up";
}

function parseReport(value: unknown): SubagentReport {
  if (typeof value !== "object" || value === null) throw new Error("Subagent report is malformed");
  const report = value as Record<string, unknown>;
  const status = report["status"];
  const summary = report["summary"];
  if ((status !== "completed" && status !== "blocked" && status !== "failed") || typeof summary !== "string") {
    throw new Error("Subagent report is malformed");
  }
  const request = report["request"] === undefined ? undefined : parseExternalInputRequest(report["request"]);
  if (status === "blocked" && request === undefined) {
    throw new Error("Blocked subagent report is missing its external input request");
  }
  if (status !== "blocked" && request !== undefined) {
    throw new Error("Only a blocked subagent report may include an external input request");
  }

  const parsed: SubagentReport = { status, summary, structured: true };
  if (typeof report["verification"] === "string") parsed.verification = report["verification"];
  if (typeof report["remainingRisk"] === "string") parsed.remainingRisk = report["remainingRisk"];
  if (request !== undefined) parsed.request = request;
  return parsed;
}

function parseExternalInputRequest(value: unknown): ExternalInputRequest {
  if (typeof value !== "object" || value === null) throw new Error("Subagent external input request is malformed");
  const request = value as Record<string, unknown>;
  const kind = request["kind"];
  const prompt = request["prompt"];
  if (
    (kind !== "question" && kind !== "confirmation" && kind !== "decision"
      && kind !== "missing_context" && kind !== "permission")
    || typeof prompt !== "string"
    || !prompt.trim()
    || (request["detail"] !== undefined && typeof request["detail"] !== "string")
    || (request["recommendation"] !== undefined && typeof request["recommendation"] !== "string")
    || (request["options"] !== undefined
      && (!Array.isArray(request["options"]) || !request["options"].every((option) => typeof option === "string")))
  ) {
    throw new Error("Subagent external input request is malformed");
  }

  const parsed: ExternalInputRequest = { kind, prompt };
  if (typeof request["detail"] === "string") parsed.detail = request["detail"];
  if (Array.isArray(request["options"])) parsed.options = request["options"] as string[];
  if (typeof request["recommendation"] === "string") parsed.recommendation = request["recommendation"];
  return parsed;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function resolvedDeferred(): Deferred {
  const value = deferred();
  value.resolve();
  return value;
}

function createStartOperation(): StartOperation {
  return { cancellationRequested: false, settled: deferred() };
}

function lifecycleOperation(action: LifecycleOperation["action"]): LifecycleOperation {
  return { action, cancellationRequested: false, settled: deferred() };
}

class StartCancellationError extends Error {
  constructor(message = "Subagent start was cancelled") {
    super(message);
    this.name = "StartCancellationError";
  }
}

class ResumeCancellationError extends Error {
  constructor(message = "Subagent resume was cancelled") {
    super(message);
    this.name = "ResumeCancellationError";
  }
}

function throwIfResumeCancelled(lifecycle: LifecycleOperation): void {
  if (lifecycle.cancellationRequested) throw new ResumeCancellationError();
}

function throwIfStartCancelled(operation: StartOperation, signal: AbortSignal | undefined): void {
  if (operation.cancellationRequested || signal?.aborted) throw new StartCancellationError();
}

function combineErrors(first: string | undefined, second: string | undefined): string {
  if (!first) return second ?? "Unknown subagent error";
  return second ? `${first}; ${second}` : first;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
