import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ProcessCommandExecutor, type CommandExecutor } from "./command-executor.js";
import type { HeadlessHostTarget, HostLaunch, HostTarget, TerminalHost } from "./terminal-host.js";

type WorkerProcess = ChildProcessByStdio<Writable, Readable, null>;

// Dialogs block the worker until answered. Nobody can answer them without a terminal, so cancel them.
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDIN_CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_TIMEOUT_MS = 2_000;
const EXIT_POLL_MS = 100;

/**
 * Runs workers as child processes in Pi RPC mode when no terminal multiplexer is available.
 * The worker bridge still communicates over the Heishi socket; stdin only keeps the process alive.
 * Targets record the process start time so a restored session never mistakes a reused PID for its worker.
 */
export class HeadlessHost implements TerminalHost {
  readonly kind = "headless" as const;
  private readonly workers = new Map<number, WorkerProcess>();

  constructor(private readonly executor: CommandExecutor = new ProcessCommandExecutor()) {}

  async validate(): Promise<void> {}

  async launch(spec: HostLaunch): Promise<HeadlessHostTarget> {
    const [command, ...args] = spec.command;
    if (!command) throw new Error("Headless worker command is empty");
    const child = spawn(command, [...args, "--mode", "rpc"], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.environment },
      stdio: ["pipe", "pipe", "ignore"],
      // A separate process group keeps terminal signals sent to the parent away from the worker.
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("Headless worker started without a process ID");
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.unref();
    this.workers.set(pid, child);
    child.once("exit", () => this.workers.delete(pid));
    cancelDialogs(child);
    const startedAt = await this.processStartTime(pid);
    if (!startedAt) throw new Error(`Headless worker ${pid} exited during startup`);
    return { host: "headless", pid, startedAt };
  }

  async exists(target: HostTarget): Promise<boolean> {
    const { pid, startedAt } = requireHeadlessTarget(target);
    if (this.workers.has(pid)) return true;
    return await this.processStartTime(pid) === startedAt;
  }

  async focus(_target: HostTarget): Promise<void> {
    throw new Error("Headless workers have no terminal to focus; view details or wait for the report");
  }

  async close(target: HostTarget): Promise<void> {
    const headless = requireHeadlessTarget(target);
    const child = this.workers.get(headless.pid);
    if (child) {
      // Closing stdin requests an orderly RPC shutdown.
      child.stdin.end();
      if (await this.exitsWithin(headless, STDIN_CLOSE_TIMEOUT_MS)) return;
    } else if (!await this.exists(headless)) {
      return;
    }
    // A worker restored from a previous parent has no stdin handle, so it is signalled directly.
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      sendSignal(headless.pid, signal);
      if (await this.exitsWithin(headless, SIGNAL_TIMEOUT_MS)) return;
    }
  }

  private async exitsWithin(target: HeadlessHostTarget, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (await this.exists(target)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    }
    return true;
  }

  private async processStartTime(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await this.executor.exec("ps", ["-o", "lstart=", "-p", String(pid)]);
      return stdout.trim() || undefined;
    } catch (error) {
      // ps exits with status 1 when the process does not exist.
      if (isExitStatus(error, 1)) return undefined;
      throw new Error(`Could not inspect headless worker ${pid}: ${errorMessage(error)}`);
    }
  }
}

function cancelDialogs(child: WorkerProcess): void {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const id = dialogRequestId(line);
      if (id !== undefined && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
      }
    }
  });
}

function dialogRequestId(line: string): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { type, method, id } = record as Record<string, unknown>;
  return type === "extension_ui_request" && typeof method === "string" && DIALOG_METHODS.has(method) && typeof id === "string"
    ? id
    : undefined;
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) throw error;
  }
}

function isExitStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === status;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function requireHeadlessTarget(target: HostTarget): HeadlessHostTarget {
  if (target.host !== "headless") throw new Error(`Headless host received a ${target.host} target`);
  return target;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
