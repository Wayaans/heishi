import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunCoordinator, type CoordinatorDependencies } from "./coordinator.js";
import type { IpcAdapter, WorkerChannel, WorkerReady } from "./ipc.js";
import type { ProtocolEnvelope } from "./protocol.js";
import type { TmuxAdapter, TmuxLaunch, TmuxTarget } from "./tmux.js";
import type { RunRecord } from "./types.js";

class FakeChannel implements WorkerChannel {
  readonly socketPath = "/tmp/worker.sock";
  readonly sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  closed = false;
  sendGate?: Promise<void>;

  constructor(readonly ready: WorkerReady) {}
  async waitForReady(): Promise<WorkerReady> { return this.ready; }
  async send(type: string, payload?: Record<string, unknown>): Promise<void> {
    this.sent.push(payload === undefined ? { type } : { type, payload });
    await this.sendGate;
  }
  async close(): Promise<void> { this.closed = true; }
}

class FakeIpc implements IpcAdapter {
  onEvent?: (event: ProtocolEnvelope) => void | Promise<void>;
  constructor(readonly channel: FakeChannel) {}
  async open(_runId: string, _token: string, onEvent: (event: ProtocolEnvelope) => void | Promise<void>): Promise<WorkerChannel> {
    this.onEvent = onEvent;
    return this.channel;
  }
  async emit(event: ProtocolEnvelope): Promise<void> { await this.onEvent?.(event); }
}

class FakeTmux implements TmuxAdapter {
  validated = false;
  launches: TmuxLaunch[] = [];
  closed: string[] = [];
  async validate(): Promise<void> { this.validated = true; }
  async launch(spec: TmuxLaunch): Promise<TmuxTarget> {
    this.launches.push(spec);
    return { paneId: `%${8 + this.launches.length}`, windowId: "@2", sessionId: "$1" };
  }
  async exists(): Promise<boolean> { return true; }
  async focus(): Promise<void> {}
  async close(target: string): Promise<void> { this.closed.push(target); }
}

function fixture(ready: Partial<WorkerReady> = {}): {
  coordinator: RunCoordinator;
  ipc: FakeIpc;
  tmux: FakeTmux;
  records: RunRecord[];
} {
  const channel = new FakeChannel({
    model: "openai/model",
    thinking: "high",
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    ...ready,
  });
  const ipc = new FakeIpc(channel);
  const tmux = new FakeTmux();
  const records: RunRecord[] = [];
  let runNumber = 0;
  const dependencies: CoordinatorDependencies = {
    cwd: "/repo",
    extensionPath: "/repo/extensions/heishi/index.ts",
    piPath: "/bin/pi",
    tmux,
    ipc,
    persist: (record) => { records.push(structuredClone(record)); },
    newRunId: () => runNumber++ === 0
      ? "12345678-1234-1234-1234-123456789abc"
      : "abcdefab-1234-1234-1234-123456789abc",
    newToken: () => "token",
    chooseAlias: () => "Atalanta",
    now: (() => {
      let tick = 0;
      return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
    })(),
  };
  return { coordinator: new RunCoordinator(dependencies), ipc, tmux, records };
}

function completedRun(): RunRecord {
  return {
    version: 1,
    runId: "run-1",
    alias: "Circe",
    taskPreview: "Inspect",
    cwd: "/repo",
    model: "openai/model",
    thinking: "high",
    placement: "pane",
    status: "completed",
    paneState: "closed",
    workerSessionId: "session-1",
    workerSessionFile: "/sessions/session-1.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("run coordinator", () => {
  it("starts asynchronously only after verified readiness, then closes on agent_settled", async () => {
    const { coordinator, ipc, tmux } = fixture();
    const started = await coordinator.start({ task: "Inspect the repository", model: "openai/model", thinking: "high" });

    assert.equal(tmux.validated, true);
    assert.equal(started.status, "running");
    assert.equal(started.alias, "Atalanta");
    assert.equal(started.tmuxTarget, "%9");
    assert.equal(started.tmuxWindowId, "@2");
    assert.equal(started.tmuxSessionId, "$1");
    assert.equal(tmux.launches[0]?.placement, "window");
    assert.deepEqual((ipc.channel).sent[0], { type: "task", payload: { task: "Inspect the repository" } });
    assert.equal(tmux.launches[0]?.command.includes("--no-context-files"), false);
    assert.equal(tmux.launches[0]?.command.includes("--no-session"), false);

    await ipc.emit({
      type: "report", runId: started.runId, version: 1,
      report: { status: "completed", summary: "Done", structured: true },
    });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    const completed = await coordinator.wait(started.runId);

    assert.equal(completed.status, "completed");
    assert.equal(completed.report?.summary, "Done");
    assert.deepEqual(tmux.closed, ["%9"]);
  });

  it("cancels startup without overwriting the terminal status", async () => {
    const { coordinator, ipc, tmux } = fixture();
    const controller = new AbortController();
    let releaseSend!: () => void;
    ipc.channel.sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const starting = coordinator.start(
      { task: "Inspect", model: "openai/model", thinking: "high" },
      controller.signal,
    );
    while (!ipc.channel.sent.some((message) => message.type === "task")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    controller.abort();
    releaseSend();
    await assert.rejects(starting, /cancelled/);
    assert.equal(coordinator.list()[0]?.status, "cancelled");
    assert.deepEqual(tmux.closed, ["%9"]);
  });

  it("returns a failed run when Pi changes the requested model or thinking level", async () => {
    const { coordinator, tmux } = fixture({ model: "openai/fallback" });

    const failed = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });

    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /requested model openai\/model.*openai\/fallback/);
    assert.deepEqual(tmux.closed, ["%9"]);
    assert.equal(coordinator.list()[0]?.workerSessionFile, "/sessions/session-1.jsonl");
  });

  it("does not overwrite a terminal startup event when cancellation is observed", async () => {
    const { coordinator, ipc } = fixture();
    const controller = new AbortController();
    let releaseSend!: () => void;
    ipc.channel.sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const starting = coordinator.start(
      { task: "Inspect", model: "openai/model", thinking: "high" },
      controller.signal,
    );
    while (!ipc.channel.sent.some((message) => message.type === "task")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    controller.abort();
    await ipc.emit({ type: "error", runId: "12345678-1234-1234-1234-123456789abc", version: 1, message: "Disconnected" });
    releaseSend();
    await assert.rejects(starting, /cancelled/);
    assert.equal(coordinator.list()[0]?.status, "failed");
  });

  it("starts multiple runs concurrently", async () => {
    const { coordinator, tmux } = fixture();

    const [first, second] = await Promise.all([
      coordinator.start({ task: "Inspect structure", model: "openai/model", thinking: "high" }),
      coordinator.start({ task: "Inspect package", model: "openai/model", thinking: "high" }),
    ]);

    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.notEqual(first.runId, second.runId);
    assert.deepEqual(tmux.launches.map((launch) => launch.placement), ["window", "window"]);
    await coordinator.shutdown();
  });

  it("keeps existing waiters attached when a follow-up is queued", async () => {
    const { coordinator, ipc } = fixture();
    const started = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });
    const waiting = coordinator.wait(started.runId);

    await coordinator.control({ runId: started.runId, action: "follow_up", message: "Also run checks" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });

    const result = await Promise.race([
      waiting,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("waiter was stranded")), 25)),
    ]);
    assert.equal(result.status, "completed");
  });

  it("preserves cancelled status when abort causes agent_settled", async () => {
    const { coordinator, ipc } = fixture();
    const started = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });

    const aborting = coordinator.control({ runId: started.runId, action: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Stopped" });

    assert.equal((await aborting).status, "cancelled");
  });

  it("marks a terminal run active and auto-closes its resumed pane after a follow-up", async () => {
    const { coordinator, ipc, tmux } = fixture();
    coordinator.restore([completedRun()]);
    await coordinator.control({ runId: "run-1", action: "resume" });
    let releaseSend!: () => void;
    ipc.channel.sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });

    const followingUp = coordinator.control({ runId: "run-1", action: "follow_up", message: "Check again" });
    let waitResolved = false;
    const waiting = coordinator.wait("run-1").then((result) => { waitResolved = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(waitResolved, false);

    releaseSend();
    await followingUp;
    await ipc.emit({ type: "settled", runId: "run-1", version: 1, finalText: "Checked" });
    assert.equal((await waiting).status, "completed");
    assert.equal(coordinator.list()[0]?.paneState, "closed");
    assert.deepEqual(tmux.closed, ["%9"]);
    await coordinator.shutdown();
  });

  it("tracks work typed directly into a resumed interactive pane", async () => {
    const { coordinator, ipc } = fixture();
    coordinator.restore([completedRun()]);
    await coordinator.control({ runId: "run-1", action: "resume" });

    await ipc.emit({ type: "progress", runId: "run-1", version: 1, message: "started", workStarted: true });
    let resolved = false;
    const waiting = coordinator.wait("run-1").then((result) => { resolved = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(resolved, false);

    await ipc.emit({ type: "settled", runId: "run-1", version: 1, finalText: "Direct work done" });
    assert.equal((await waiting).report?.summary, "Direct work done");
    await coordinator.shutdown();
  });

  it("resumes the persisted session without replaying the original task", async () => {
    const { coordinator, ipc, tmux } = fixture();
    coordinator.restore([completedRun()]);

    const resumed = await coordinator.control({ runId: "run-1", action: "resume" });
    assert.equal(resumed.status, "completed");
    assert.equal(coordinator.list()[0]?.paneState, "open");
    assert.deepEqual(ipc.channel.sent, []);
    assert.deepEqual(tmux.launches[0]?.command.slice(-2), ["--session", "/sessions/session-1.jsonl"]);

    await ipc.emit({ type: "settled", runId: "run-1", version: 1, finalText: "Inspected" });
    assert.deepEqual(tmux.closed, []);
    await coordinator.shutdown();
  });
});
