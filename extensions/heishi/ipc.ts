import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlDecoder, PROTOCOL_VERSION, encodeMessage, type ProtocolEnvelope } from "./protocol.js";

export interface WorkerReady {
  model: string;
  thinking: string;
  sessionId: string;
  sessionFile: string;
}

export interface WorkerChannel {
  readonly socketPath: string;
  waitForReady(): Promise<WorkerReady>;
  send(type: string, payload?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface IpcAdapter {
  open(
    runId: string,
    token: string,
    onEvent: (event: ProtocolEnvelope) => void | Promise<void>,
  ): Promise<WorkerChannel>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export class IpcHub implements IpcAdapter {
  constructor(private readonly temporaryRoot = tmpdir()) {}

  async open(
    runId: string,
    token: string,
    onEvent: (event: ProtocolEnvelope) => void | Promise<void>,
  ): Promise<WorkerChannel> {
    const rootName = `heishi-${process.getuid?.() ?? "user"}`;
    const runDirectory = createHash("sha256").update(runId).digest("hex").slice(0, 20);
    let root = join(this.temporaryRoot, rootName);
    let directory = join(root, runDirectory);
    let socketPath = join(directory, "bridge.sock");
    if (Buffer.byteLength(socketPath) > 100) {
      root = join("/tmp", rootName);
      directory = join(root, runDirectory);
      socketPath = join(directory, "bridge.sock");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(directory, 0o700);
    await rm(socketPath, { force: true });

    const ready = deferred<WorkerReady>();
    const pending = new Map<string, Deferred<void>>();
    const sockets = new Set<Socket>();
    let worker: Socket | undefined;
    let closing = false;

    const server = createServer((socket) => {
      sockets.add(socket);
      let authenticated = false;
      const authenticationTimer = setTimeout(() => {
        socket.destroy(new Error("Subagent IPC authentication timed out"));
      }, 20_000);
      authenticationTimer.unref();
      const decoder = new JsonlDecoder();
      socket.on("data", (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (message.runId !== runId) throw new Error("Subagent IPC run ID mismatch");
            if (!authenticated) {
              if (message.type !== "hello" || message["token"] !== token) {
                throw new Error("Subagent IPC authentication failed");
              }
              if (worker && !worker.destroyed) throw new Error("A subagent is already connected");
              worker = socket;
              authenticated = true;
              clearTimeout(authenticationTimer);
              continue;
            }
            if (message.type === "ready") {
              ready.resolve(parseReady(message));
              continue;
            }
            if (message.type === "ack" && message.requestId) {
              const request = pending.get(message.requestId);
              if (request) {
                pending.delete(message.requestId);
                if (message["ok"] === false) request.reject(new Error(String(message["error"] ?? "Subagent command failed")));
                else request.resolve();
              }
              continue;
            }
            void Promise.resolve(onEvent(message)).catch((error: unknown) => {
              socket.destroy(toError(error));
            });
          }
        } catch (error) {
          const failure = toError(error);
          if (authenticated) rejectConnectionWaiters(ready, pending, failure);
          socket.destroy(failure);
        }
      });
      socket.on("close", () => {
        clearTimeout(authenticationTimer);
        sockets.delete(socket);
        if (worker !== socket) return;
        worker = undefined;
        rejectConnectionWaiters(ready, pending, new Error("Subagent disconnected"));
        if (!closing) void onEvent({ type: "disconnect", runId, version: PROTOCOL_VERSION });
      });
      socket.on("error", () => undefined);
    });

    await listen(server, socketPath);
    await chmod(socketPath, 0o600);

    return new SocketWorkerChannel(
      runId,
      socketPath,
      server,
      () => worker,
      sockets,
      ready,
      pending,
      () => { closing = true; },
      directory,
    );
  }
}

class SocketWorkerChannel implements WorkerChannel {
  constructor(
    private readonly runId: string,
    readonly socketPath: string,
    private readonly server: Server,
    private readonly getWorker: () => Socket | undefined,
    private readonly sockets: Set<Socket>,
    private readonly ready: Deferred<WorkerReady>,
    private readonly pending: Map<string, Deferred<void>>,
    private readonly markClosing: () => void,
    private readonly directory: string,
  ) {}

  waitForReady(): Promise<WorkerReady> {
    return withTimeout(this.ready.promise, 20_000, "Timed out waiting for subagent readiness");
  }

  async send(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const socket = this.getWorker();
    if (!socket || socket.destroyed) throw new Error("Subagent is not connected");
    const requestId = randomUUID();
    const acknowledgement = deferred<void>();
    this.pending.set(requestId, acknowledgement);
    socket.write(encodeMessage({
      ...payload,
      type,
      runId: this.runId,
      version: PROTOCOL_VERSION,
      requestId,
    }));
    try {
      await withTimeout(acknowledgement.promise, 10_000, `Timed out waiting for ${type} acknowledgement`);
    } finally {
      this.pending.delete(requestId);
    }
  }

  async close(): Promise<void> {
    this.markClosing();
    rejectConnectionWaiters(this.ready, this.pending, new Error("Subagent connection closed"));
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }
}

function rejectConnectionWaiters(
  ready: Deferred<WorkerReady>,
  pending: Map<string, Deferred<void>>,
  error: Error,
): void {
  ready.reject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function parseReady(message: ProtocolEnvelope): WorkerReady {
  const model = message["model"];
  const thinking = message["thinking"];
  const sessionId = message["sessionId"];
  const sessionFile = message["sessionFile"];
  if ([model, thinking, sessionId, sessionFile].some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Subagent sent incomplete readiness metadata");
  }
  return {
    model: model as string,
    thinking: thinking as string,
    sessionId: sessionId as string,
    sessionFile: sessionFile as string,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
