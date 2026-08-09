import { randomInt, randomUUID } from "node:crypto";
import type { IpcAdapter, WorkerChannel, WorkerReady } from "./ipc.js";
import type { ProtocolEnvelope } from "./protocol.js";
import { isActive } from "./registry.js";
import { buildPiCommand, THINKING_LEVELS, type ThinkingLevel, type TmuxAdapter } from "./tmux.js";
import {
  resultFromRun,
  type ControlInput,
  type RunRecord,
  type RunResult,
  type StartInput,
  type SubagentReport,
  type WaitResult,
  type WorkerMode,
} from "./types.js";

const SUBAGENT_SESSION_NAME = "heishi-subagents";
const MAIN_READINESS_TIMEOUT_MS = 60_000;

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

type RunChanges = Omit<Partial<RunRecord>, "report" | "error"> & {
  report?: SubagentReport | undefined;
  error?: string | undefined;
};

export class RunCoordinator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly newRunId: () => string;
  private readonly newToken: () => string;
  private readonly chooseAlias: () => string;
  private readonly now: () => string;

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.newRunId = dependencies.newRunId ?? randomUUID;
    this.newToken = dependencies.newToken ?? randomUUID;
    this.chooseAlias = dependencies.chooseAlias ?? (() => MYTHOLOGICAL_NAMES[randomInt(MYTHOLOGICAL_NAMES.length)] ?? "Atalanta");
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async start(input: StartInput, signal?: AbortSignal): Promise<RunResult> {
    const mode = validateStart(input);
    if (signal?.aborted) throw new Error("Subagent start was cancelled");

    const runId = this.newRunId();
    const timestamp = this.now();
    const run: RunRecord = {
      version: 2,
      mode,
      runId,
      alias: resolveAlias(input.alias, this.chooseAlias),
      taskPreview: preview(input.task),
      cwd: this.dependencies.cwd,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      placement: input.placement ?? "session",
      status: "created",
      paneState: "closed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.runs.set(runId, run);
    this.persist(run);

    let abortListener: (() => void) | undefined;
    try {
      await this.dependencies.tmux.validate();
      throwIfAborted(signal);
      this.update(run, { status: "starting" });
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
      throwIfAborted(signal);

      await this.launchWorker(run, runtime, token, false);
      throwIfAborted(signal);

      if (signal) {
        abortListener = () => { void this.abortRun(runId); };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      const ready = await waitForWorkerReady(channel, run.mode);
      throwIfAborted(signal);
      this.update(run, {
        workerSessionId: ready.sessionId,
        workerSessionFile: ready.sessionFile,
      });
      verifyInitialReady(run, ready, input.model, input.thinking);
      this.update(run, { model: ready.model, thinking: parseThinkingLevel(ready.thinking) });
      await channel.send("task", { task: input.task });
      throwIfAborted(signal);
      this.update(run, { status: "running", startedAt: this.now() });
      return resultFromRun(run);
    } catch (error) {
      const hasRuntime = this.runtimes.has(runId);
      if (signal?.aborted) {
        if (hasRuntime) await this.abortRun(runId);
        else if (isActive(run.status)) {
          this.update(run, {
            status: "cancelled",
            paneState: "closed",
            completedAt: this.now(),
            error: "Subagent start was cancelled",
          });
        }
        throw new Error("Subagent start was cancelled");
      }
      await this.failStartup(run, error);
      return resultFromRun(run);
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
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
    if (input.action === "resume") return this.resume(run);
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

  restore(runs: RunRecord[]): void {
    this.runs.clear();
    for (const run of runs) this.runs.set(run.runId, structuredClone(run));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((runId) => this.abortRun(runId)));
  }

  private async resume(run: RunRecord): Promise<RunResult> {
    if (run.paneState === "open") throw new Error("Subagent pane is already open");
    if (!run.workerSessionFile || !run.workerSessionId) {
      throw new Error("Subagent has no persisted worker session to resume");
    }
    await this.dependencies.tmux.validate();
    const token = this.newToken();
    try {
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
      await this.launchWorker(run, runtime, token, true);
      const ready = await waitForWorkerReady(channel, run.mode);
      if (run.mode === "sub") verifyInitialReady(run, ready, run.model, run.thinking);
      if (ready.sessionId !== run.workerSessionId) {
        throw new Error(`Subagent resumed session ${ready.sessionId}, expected ${run.workerSessionId}`);
      }
      this.update(run, { model: ready.model, thinking: parseThinkingLevel(ready.thinking) });
      return resultFromRun(run);
    } catch (error) {
      const runtime = this.runtimes.get(run.runId);
      await runtime?.channel.close().catch(() => undefined);
      this.runtimes.delete(run.runId);
      if (run.tmuxTarget) await this.dependencies.tmux.close(run.tmuxTarget).catch(() => undefined);
      this.update(run, { paneState: "closed", error: errorMessage(error) });
      throw error;
    }
  }

  private async launchWorker(
    run: RunRecord,
    runtime: Runtime,
    token: string,
    resume: boolean,
  ): Promise<void> {
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
      cwd: run.cwd,
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

  private async abortRun(runId: string): Promise<void> {
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
    const changes: Partial<RunRecord> = {
      status,
      completedAt: this.now(),
      ...(report ? { report } : {}),
      ...(error ? { error } : {}),
    };
    changes.paneState = closePane ? "closed" : "disconnected";
    this.update(run, changes);
    await runtime.channel.close().catch(() => undefined);
    if (closePane && run.tmuxTarget) await this.dependencies.tmux.close(run.tmuxTarget).catch(() => undefined);
    this.runtimes.delete(run.runId);
    runtime.settled.resolve();
  }

  private async failStartup(run: RunRecord, error: unknown): Promise<void> {
    const runtime = this.runtimes.get(run.runId);
    if (runtime) {
      runtime.finishing = true;
      await runtime.channel.close().catch(() => undefined);
      runtime.settled.resolve();
      this.runtimes.delete(run.runId);
    }
    if (run.tmuxTarget) await this.dependencies.tmux.close(run.tmuxTarget).catch(() => undefined);
    this.update(run, {
      status: "failed",
      paneState: "closed",
      completedAt: this.now(),
      error: errorMessage(error),
    });
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
  const parsed: SubagentReport = { status, summary, structured: true };
  if (typeof report["verification"] === "string") parsed.verification = report["verification"];
  if (typeof report["remainingRisk"] === "string") parsed.remainingRisk = report["remainingRisk"];
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Subagent start was cancelled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
