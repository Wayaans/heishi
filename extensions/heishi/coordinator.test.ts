import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunCoordinator, type CoordinatorDependencies } from "./coordinator.js";
import type { IpcAdapter, WorkerChannel, WorkerReady } from "./ipc.js";
import type { ProtocolEnvelope } from "./protocol.js";
import { TerminalHostResolver } from "./terminal-host-resolver.js";
import type { CmuxHostTarget, HostLaunch, HostTarget, TerminalHost } from "./terminal-host.js";
import { TmuxHost, type TmuxAdapter, type TmuxLaunch, type TmuxTarget } from "./tmux.js";
import type { RunRecord, WorktreeRecord } from "./types.js";
import { WorktreeOperationError, type WorktreeAdapter, type WorktreeRollbackResult } from "./worktree.js";

class FakeChannel implements WorkerChannel {
  readonly socketPath = "/tmp/worker.sock";
  readonly sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  readonly readinessTimeouts: Array<number | undefined> = [];
  closed = false;
  sendGate?: Promise<void>;
  readyGate?: Promise<void>;

  constructor(readonly ready: WorkerReady) {}
  async waitForReady(timeoutMs?: number): Promise<WorkerReady> {
    this.readinessTimeouts.push(timeoutMs);
    await this.readyGate;
    return this.ready;
  }
  async send(type: string, payload?: Record<string, unknown>): Promise<void> {
    this.sent.push(payload === undefined ? { type } : { type, payload });
    await this.sendGate;
  }
  async close(): Promise<void> { this.closed = true; }
}

class FakeIpc implements IpcAdapter {
  onEvent?: (event: ProtocolEnvelope) => void | Promise<void>;
  failOpen = false;
  openCalls = 0;
  openGate?: Promise<void>;
  constructor(readonly channel: FakeChannel) {}
  async open(_runId: string, _token: string, onEvent: (event: ProtocolEnvelope) => void | Promise<void>): Promise<WorkerChannel> {
    this.openCalls += 1;
    await this.openGate;
    if (this.failOpen) throw new Error("IPC unavailable");
    this.onEvent = onEvent;
    return this.channel;
  }
  async emit(event: ProtocolEnvelope): Promise<void> { await this.onEvent?.(event); }
}

class FakeWorktrees implements WorktreeAdapter {
  prepared: Array<{ sourceCwd: string; runId: string }> = [];
  rolledBack: WorktreeRecord[] = [];
  validatedForCleanup: WorktreeRecord[] = [];
  cleaned: WorktreeRecord[] = [];
  resumed: WorktreeRecord[] = [];
  prepareError?: Error;
  prepareGate?: Promise<void>;
  rollbackError?: Error;
  rollbackWarning?: string;
  cleanupValidationError?: Error;
  cleanupValidationGate?: Promise<void>;
  cleanupError?: Error;
  cleanupGate?: Promise<void>;
  resumeGate?: Promise<void>;
  resumeError?: Error;
  record: WorktreeRecord = {
    path: "/agent/heishi/worktrees/repo-abc/12345678-1234-1234-1234-123456789abc",
    branch: "heishi/12345678-1234-1234-1234-123456789abc",
    baseCommit: "base-commit",
    state: "present",
    gitCommonDir: "/repo/.git",
    repositoryName: "repo",
    relativeCwd: ".",
  };
  async prepare(sourceCwd: string, runId: string): Promise<WorktreeRecord> {
    this.prepared.push({ sourceCwd, runId });
    if (this.prepareError) throw this.prepareError;
    await this.prepareGate;
    return structuredClone(this.record);
  }
  async rollback(worktree: WorktreeRecord): Promise<WorktreeRollbackResult> {
    this.rolledBack.push(structuredClone(worktree));
    if (this.rollbackError) throw this.rollbackError;
    const result: WorktreeRollbackResult = {
      worktree: removedWorktree(worktree, "rollback-commit"),
    };
    if (this.rollbackWarning) result.warning = this.rollbackWarning;
    return result;
  }
  async validateCleanup(worktree: WorktreeRecord): Promise<void> {
    this.validatedForCleanup.push(structuredClone(worktree));
    await this.cleanupValidationGate;
    if (this.cleanupValidationError) throw this.cleanupValidationError;
  }
  async cleanup(worktree: WorktreeRecord): Promise<WorktreeRecord> {
    await this.validateCleanup(worktree);
    this.cleaned.push(structuredClone(worktree));
    await this.cleanupGate;
    if (this.cleanupError) throw this.cleanupError;
    return removedWorktree(worktree, "cleanup-commit");
  }
  async prepareResume(worktree: WorktreeRecord): Promise<WorktreeRecord> {
    this.resumed.push(structuredClone(worktree));
    await this.resumeGate;
    if (this.resumeError) throw this.resumeError;
    return presentWorktree(worktree);
  }
}

class FakeCmux implements TerminalHost {
  readonly kind = "cmux" as const;
  readonly target: CmuxHostTarget = {
    host: "cmux",
    windowId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    paneId: "33333333-3333-4333-8333-333333333333",
    surfaceId: "44444444-4444-4444-8444-444444444444",
    socketPath: "/tmp/cmux.sock",
    closeKind: "surface",
    dedicatedWorkspace: true,
  };
  launches: HostLaunch[] = [];
  closed: HostTarget[] = [];
  existing = false;
  validated = false;

  async validate(): Promise<void> { this.validated = true; }
  async launch(spec: HostLaunch): Promise<CmuxHostTarget> {
    this.launches.push(spec);
    this.existing = true;
    return this.target;
  }
  async exists(): Promise<boolean> { return this.existing; }
  async focus(): Promise<void> {}
  async close(target: HostTarget): Promise<void> {
    this.closed.push(target);
    this.existing = false;
  }
}

class FakeTmux implements TmuxAdapter {
  validated = false;
  launches: TmuxLaunch[] = [];
  closed: string[] = [];
  existingTargets = new Set<string>();
  closeGate?: Promise<void>;
  closeLeavesTarget = false;
  launchError?: Error;
  nextTarget?: TmuxTarget;
  existsError?: Error;
  validateGate?: Promise<void>;
  launchGate?: Promise<void>;
  async validate(): Promise<void> {
    this.validated = true;
    await this.validateGate;
  }
  async launch(spec: TmuxLaunch): Promise<TmuxTarget> {
    await this.launchGate;
    this.launches.push(spec);
    if (this.launchError) throw this.launchError;
    const target = this.nextTarget ?? { paneId: `%${8 + this.launches.length}`, windowId: "@2", sessionId: "$1" };
    this.existingTargets.add(target.paneId);
    return target;
  }
  async exists(target: string): Promise<boolean> {
    if (this.existsError) throw this.existsError;
    return this.existingTargets.has(target);
  }
  async focus(): Promise<void> {}
  async close(target: string): Promise<void> {
    this.closed.push(target);
    await this.closeGate;
    if (!this.closeLeavesTarget) this.existingTargets.delete(target);
  }
}

function removedWorktree(worktree: WorktreeRecord, resumeCommit: string): WorktreeRecord {
  const { resumeCommit: _oldResumeCommit, ...record } = worktree;
  return { ...record, state: "removed", resumeCommit };
}

function presentWorktree(worktree: WorktreeRecord): WorktreeRecord {
  const { resumeCommit: _resumeCommit, ...record } = worktree;
  return { ...record, state: "present" };
}

function fixture(ready: Partial<WorkerReady> = {}, terminalHost?: TerminalHost): {
  coordinator: RunCoordinator;
  ipc: FakeIpc;
  tmux: FakeTmux;
  worktrees: FakeWorktrees;
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
  const worktrees = new FakeWorktrees();
  const records: RunRecord[] = [];
  let runNumber = 0;
  const dependencies: CoordinatorDependencies = {
    cwd: "/repo",
    extensionPath: "/repo/extensions/heishi/index.ts",
    piPath: "/bin/pi",
    hosts: new TerminalHostResolver(
      [terminalHost ?? new TmuxHost(tmux)],
      async () => terminalHost?.kind ?? "tmux",
    ),
    ipc,
    worktrees,
    persist: (record) => { records.push(structuredClone(record)); },
    projectTrusted: true,
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
  return { coordinator: new RunCoordinator(dependencies), ipc, tmux, worktrees, records };
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

function completedRun(): RunRecord {
  return {
    version: 4,
    mode: "sub",
    workspace: "shared",
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

function completedMainRun(): RunRecord {
  return {
    ...completedRun(),
    mode: "main",
    model: "provider/current",
    thinking: "medium",
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
    assert.equal(tmux.launches[0]?.placement, "session");
    assert.equal(tmux.launches[0]?.sessionName, "heishi-subagents");
    assert.equal(tmux.launches[0]?.title, "sub · Atalanta · 123456");
    assert.deepEqual(tmux.launches[0]?.command.slice(-2), ["--name", "Subagent: sub · Atalanta · 123456"]);
    assert.deepEqual((ipc.channel).sent[0], {
      type: "task",
      payload: {
        task: `[Delegation from parent agent]
This is a fresh session. You do not have the parent conversation.
The complete task brief follows:

Inspect the repository`,
      },
    });
    assert.equal(tmux.launches[0]?.command.includes("--no-context-files"), false);
    assert.equal(tmux.launches[0]?.command.includes("--no-session"), false);
    assert.equal(tmux.launches[0]?.environment["HEISHI_WORKER_MODE"], "sub");
    assert.deepEqual(ipc.channel.readinessTimeouts, [undefined]);

    await ipc.emit({
      type: "report", runId: started.runId, version: 1,
      report: { status: "completed", summary: "Done", structured: true },
    });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    const completed = await coordinator.wait(started.runId);

    assert.equal(completed.status, "completed");
    assert.equal(completed.report?.summary, "Done");
    assert.equal(completed.durationMs, 3_000);
    assert.deepEqual(tmux.closed, ["%9"]);
  });

  it("runs the lifecycle through a cmux-shaped generic host target", async () => {
    const cmux = new FakeCmux();
    const { coordinator, ipc, records } = fixture({}, cmux);
    const started = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });

    assert.equal(cmux.validated, true);
    assert.deepEqual(started.hostTarget, cmux.target);
    assert.equal(started.host, "cmux");
    assert.deepEqual(records.at(-1)?.hostTarget, cmux.target);

    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    const completed = await coordinator.wait(started.runId);

    assert.equal(completed.status, "completed");
    assert.deepEqual(cmux.closed, [cmux.target]);
    assert.deepEqual(records.at(-1)?.hostTarget, cmux.target);
    assert.equal(records.at(-1)?.paneState, "closed");
  });

  it("rejects worktree workspace in sub mode before Git or tmux work", async () => {
    const { coordinator, tmux, worktrees } = fixture();

    await assert.rejects(
      () => coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high", workspace: "worktree" }),
      /only in main mode/u,
    );

    assert.equal(tmux.validated, false);
    assert.deepEqual(worktrees.prepared, []);
  });

  it("does not launch tmux when worktree preparation rejects the source checkout", async () => {
    const { coordinator, tmux, worktrees } = fixture();
    worktrees.prepareError = new Error("Git worktree workspace requires a clean source checkout");

    const failed = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });

    assert.equal(failed.status, "failed");
    assert.equal(failed.workspace, "worktree");
    assert.equal(failed.worktree, undefined);
    assert.match(failed.error ?? "", /clean source checkout/u);
    assert.deepEqual(tmux.launches, []);
  });

  it("persists removed metadata from a worktree preparation failure", async () => {
    const { coordinator, tmux, worktrees, records } = fixture();
    const removed = removedWorktree(worktrees.record, "retained-branch-tip");
    worktrees.prepareError = new WorktreeOperationError(
      "Created worktree verification failed; branch and internal lease were retained for manual recovery",
      removed,
    );

    const failed = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });

    assert.equal(failed.status, "failed");
    assert.equal(failed.worktree?.state, "removed");
    assert.match(failed.error ?? "", /internal lease were retained for manual recovery/u);
    const persistedWorktree = records.at(-1)?.worktree;
    assert.equal(persistedWorktree?.state, "removed");
    assert.equal(persistedWorktree?.state === "removed" ? persistedWorktree.resumeCommit : undefined, "retained-branch-tip");
    assert.deepEqual(worktrees.rolledBack, []);
    assert.deepEqual(tmux.launches, []);
  });

  it("starts a main worker in its prepared worktree and reports workspace metadata", async () => {
    const { coordinator, ipc, tmux, worktrees } = fixture();

    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement the change" });

    assert.equal(started.workspace, "worktree");
    assert.deepEqual(started.worktree, {
      path: worktrees.record.path,
      branch: worktrees.record.branch,
      baseCommit: worktrees.record.baseCommit,
      state: "present",
    });
    assert.equal(tmux.launches[0]?.cwd, worktrees.record.path);
    assert.match(String(ipc.channel.sent[0]?.payload?.["task"]), /isolated in Git worktree/u);
    assert.match(String(ipc.channel.sent[0]?.payload?.["task"]), /Do not merge into the source checkout/u);
    assert.match(String(ipc.channel.sent[0]?.payload?.["task"]), /Report Git status/u);
    await coordinator.shutdown();
  });

  it("persists removed rollback state and surfaces retained-ref warnings", async () => {
    const { coordinator, ipc, worktrees, records } = fixture();
    ipc.failOpen = true;
    worktrees.rollbackWarning = "Worktree branch and internal lease were retained for manual recovery";

    const failed = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });

    assert.equal(failed.status, "failed");
    assert.equal(failed.worktree?.state, "removed");
    assert.match(failed.error ?? "", /worktree rollback warning.*internal lease were retained/u);
    assert.equal(records.at(-1)?.worktree?.state, "removed");
    assert.equal(records.at(-1)?.status, "failed");
  });

  it("keeps present rollback state when removal is refused before it completes", async () => {
    const { coordinator, ipc, worktrees, records } = fixture();
    ipc.failOpen = true;
    worktrees.rollbackError = new Error("could not remove registered worktree");

    const failed = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });

    assert.equal(failed.worktree?.state, "present");
    assert.match(failed.error ?? "", /rollback was refused.*could not remove/u);
    assert.equal(records.at(-1)?.worktree?.state, "present");
  });

  it("rolls back a prepared worktree only when startup fails before launch", async () => {
    const beforeLaunch = fixture();
    beforeLaunch.ipc.failOpen = true;
    const failed = await beforeLaunch.coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.worktree?.state, "removed");
    assert.equal(beforeLaunch.worktrees.rolledBack.length, 1);
    assert.deepEqual(beforeLaunch.tmux.launches, []);
    assert.equal(beforeLaunch.records.some((record) => {
      return record.worktree?.state === "removed"
        && (record.status === "created" || record.status === "starting" || record.status === "running");
    }), false);

    const afterLaunch = fixture({ model: "provider/unexpected" });
    const launched = await afterLaunch.coordinator.start({
      mode: "main",
      thinking: "high",
      workspace: "worktree",
      task: "Implement",
      model: "provider/requested",
    });
    assert.equal(launched.status, "failed");
    assert.equal(launched.worktree?.state, "present");
    assert.deepEqual(afterLaunch.worktrees.rolledBack, []);
  });

  it("requires both main model and thinking before preparing or launching a worker", async () => {
    const { coordinator, tmux, worktrees } = fixture();
    for (const pair of [{}, { model: "provider/requested" }, { thinking: "high" as const }]) {
      await assert.rejects(
        () => coordinator.start({ mode: "main", workspace: "worktree", task: "Implement", ...pair }),
        /Main mode requires an explicit model and thinking level/u,
      );
    }
    assert.deepEqual(tmux.launches, []);
    assert.deepEqual(worktrees.prepared, []);
    await coordinator.shutdown();
  });

  it("starts main mode with an explicit saved-default pair in the shared workspace", async () => {
    const { coordinator, ipc, tmux, worktrees } = fixture({ model: "provider/default", thinking: "medium" });

    const started = await coordinator.start({ mode: "main", model: "provider/default", thinking: "medium", task: "Inspect the repository" });

    assert.equal(started.mode, "main");
    assert.equal(started.model, "provider/default");
    assert.equal(started.thinking, "medium");
    assert.deepEqual(ipc.channel.readinessTimeouts, [60_000]);
    assert.equal(tmux.launches[0]?.command.includes("--no-extensions"), false);
    assert.equal(tmux.launches[0]?.command.includes("--approve"), true);
    assert.equal(tmux.launches[0]?.command.includes("--model"), true);
    assert.equal(tmux.launches[0]?.command.includes("--thinking"), true);
    assert.equal(tmux.launches[0]?.environment["HEISHI_WORKER_MODE"], "main");
    assert.equal(tmux.launches[0]?.placement, "window");
    assert.equal(tmux.launches[0]?.sessionName, undefined);
    assert.equal(tmux.launches[0]?.title, "main · Atalanta · 123456");
    assert.equal(tmux.launches[0]?.command.includes("Subagent: main · Atalanta · 123456"), true);
    assert.deepEqual(worktrees.prepared, []);
    assert.equal(started.workspace, undefined);
    await coordinator.shutdown();
  });

  it("returns structured external-input requests from blocked workers", async () => {
    const { coordinator, ipc } = fixture();
    const started = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });
    const request = {
      kind: "decision" as const,
      prompt: "Which retention period should be used?",
      detail: "The specification permits either value.",
      options: ["30 days", "90 days"],
      recommendation: "Use 90 days because it matches the current policy.",
    };

    await ipc.emit({
      type: "report",
      runId: started.runId,
      version: 1,
      report: { status: "blocked", summary: "A product decision is required.", request },
    });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1 });

    const blocked = await coordinator.wait(started.runId);
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.report?.request, request);
  });

  it("rejects blocked reports without a structured external-input request", async () => {
    const { coordinator, ipc } = fixture();
    const started = await coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });

    await assert.rejects(
      () => ipc.emit({
        type: "report",
        runId: started.runId,
        version: 1,
        report: { status: "blocked", summary: "Need input" },
      }),
      /missing its external input request/u,
    );
    await coordinator.shutdown();
  });

  it("uses structured reports and final-text fallback in main mode", async () => {
    const structured = fixture();
    const first = await structured.coordinator.start({ mode: "main", model: "openai/model", thinking: "high", task: "Inspect" });
    await structured.ipc.emit({
      type: "report",
      runId: first.runId,
      version: 1,
      report: { status: "completed", summary: "Structured main report" },
    });
    await structured.ipc.emit({ type: "settled", runId: first.runId, version: 1, finalText: "Fallback" });
    const structuredResult = await structured.coordinator.wait(first.runId);
    assert.equal(structuredResult.report?.summary, "Structured main report");
    assert.equal(structuredResult.report?.structured, true);

    const fallback = fixture();
    const second = await fallback.coordinator.start({ mode: "main", model: "openai/model", thinking: "high", task: "Inspect" });
    await fallback.ipc.emit({ type: "settled", runId: second.runId, version: 1, finalText: "Main fallback" });
    const fallbackResult = await fallback.coordinator.wait(second.runId);
    assert.equal(fallbackResult.report?.summary, "Main fallback");
    assert.equal(fallbackResult.report?.structured, false);
  });

  it("verifies explicit main model and thinking overrides", async () => {
    const accepted = fixture({ model: "provider/requested", thinking: "low" });
    const started = await accepted.coordinator.start({
      mode: "main",
      thinking: "low",
      task: "Inspect",
      model: "provider/requested",
    });
    assert.equal(started.status, "running");
    assert.equal(started.thinking, "low");
    await accepted.coordinator.shutdown();

    const rejected = fixture({ model: "provider/fallback" });
    const failed = await rejected.coordinator.start({
      mode: "main",
      thinking: "high",
      task: "Inspect",
      model: "provider/requested",
    });
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /requested model provider\/requested.*provider\/fallback/u);
  });

  it("passes the explicit main pair to Pi without relying on launch defaults", async () => {
    const { coordinator, ipc, tmux } = fixture({ model: "provider/default", thinking: "high" });

    const started = await coordinator.start({ mode: "main", task: "Implement", model: "provider/default", thinking: "high" });

    assert.equal(started.status, "running");
    assert.equal(started.model, "provider/default");
    assert.equal(started.thinking, "high");
    const command = tmux.launches[0]?.command ?? [];
    assert.equal(command[command.indexOf("--model") + 1], "provider/default");
    assert.equal(command[command.indexOf("--thinking") + 1], "high");
    assert.equal(ipc.channel.sent[0]?.type, "task");
    await coordinator.shutdown();
  });

  it("fails before task submission when Pi clamps the explicit thinking level", async () => {
    const { coordinator, ipc, tmux } = fixture({ model: "provider/plain", thinking: "off" });

    const started = await coordinator.start({ mode: "main", task: "Implement", model: "provider/plain", thinking: "high" });

    assert.equal(started.status, "failed");
    assert.match(started.error ?? "", /requested thinking high, but Pi started off/u);
    assert.deepEqual(ipc.channel.sent, []);
    assert.equal(ipc.channel.closed, true);
    assert.deepEqual(tmux.closed, ["%9"]);
    await coordinator.shutdown();
  });

  it("preserves rollback warnings and refusals when startup is cancelled before launch", async () => {
    const warningFixture = fixture();
    const warningController = new AbortController();
    let releaseWarningPrepare!: () => void;
    warningFixture.worktrees.prepareGate = new Promise<void>((resolve) => { releaseWarningPrepare = resolve; });
    warningFixture.worktrees.rollbackWarning = "branch ownership changed and the branch was retained";
    const warningStart = warningFixture.coordinator.start(
      { mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" },
      warningController.signal,
    );
    while (warningFixture.worktrees.prepared.length === 0) await pause();
    warningController.abort();
    releaseWarningPrepare();

    await assert.rejects(warningStart, /cancelled.*rollback warning.*ownership changed/u);
    const warnedRun = warningFixture.coordinator.list()[0];
    assert.equal(warnedRun?.status, "cancelled");
    assert.equal(warnedRun?.worktree?.state, "removed");
    assert.match(warnedRun?.error ?? "", /cancelled.*rollback warning/u);

    const refusalFixture = fixture();
    const refusalController = new AbortController();
    let releaseRefusalPrepare!: () => void;
    refusalFixture.worktrees.prepareGate = new Promise<void>((resolve) => { releaseRefusalPrepare = resolve; });
    refusalFixture.worktrees.rollbackError = new Error("registered worktree could not be removed");
    const refusalStart = refusalFixture.coordinator.start(
      { mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" },
      refusalController.signal,
    );
    while (refusalFixture.worktrees.prepared.length === 0) await pause();
    refusalController.abort();
    releaseRefusalPrepare();

    await assert.rejects(refusalStart, /cancelled.*rollback was refused.*could not be removed/u);
    const refusedRun = refusalFixture.coordinator.list()[0];
    assert.equal(refusedRun?.status, "cancelled");
    assert.equal(refusedRun?.worktree?.state, "present");
    assert.match(refusedRun?.error ?? "", /cancelled.*rollback was refused/u);
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

  it("waits for startup cancellation during tmux validation", async () => {
    const { coordinator, ipc, tmux } = fixture();
    let releaseValidation!: () => void;
    tmux.validateGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const starting = coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });
    const startRejected = assert.rejects(starting, /Subagent start was cancelled/u);
    while (!tmux.validated) await pause();

    let shutdownSettled = false;
    const shuttingDown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await pause();
    assert.equal(shutdownSettled, false);

    releaseValidation();
    await startRejected;
    await shuttingDown;

    assert.equal(coordinator.list()[0]?.status, "cancelled");
    assert.equal(ipc.openCalls, 0);
    assert.deepEqual(tmux.launches, []);
    assert.equal(tmux.existingTargets.size, 0);
    await assert.rejects(
      () => coordinator.start({ task: "Inspect again", model: "openai/model", thinking: "high" }),
      /coordinator is shutting down/u,
    );
  });

  it("waits for startup cancellation and worktree rollback during preparation", async () => {
    const { coordinator, ipc, tmux, worktrees } = fixture();
    let releasePrepare!: () => void;
    worktrees.prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const starting = coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    const startRejected = assert.rejects(starting, /Subagent start was cancelled/u);
    while (worktrees.prepared.length === 0) await pause();

    let shutdownSettled = false;
    const shuttingDown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await pause();
    assert.equal(shutdownSettled, false);

    releasePrepare();
    await startRejected;
    await shuttingDown;

    assert.equal(coordinator.list()[0]?.status, "cancelled");
    assert.equal(coordinator.list()[0]?.worktree?.state, "removed");
    assert.equal(worktrees.rolledBack.length, 1);
    assert.equal(ipc.openCalls, 0);
    assert.deepEqual(tmux.launches, []);
    assert.equal(tmux.existingTargets.size, 0);
  });

  it("waits for startup cancellation while IPC is opening before runtime registration", async () => {
    const { coordinator, ipc, tmux } = fixture();
    let releaseOpen!: () => void;
    ipc.openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const starting = coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });
    const startRejected = assert.rejects(starting, /Subagent start was cancelled/u);
    while (ipc.openCalls === 0) await pause();

    let shutdownSettled = false;
    const shuttingDown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await pause();
    assert.equal(shutdownSettled, false);

    releaseOpen();
    await startRejected;
    await shuttingDown;

    assert.equal(coordinator.list()[0]?.status, "cancelled");
    assert.equal(ipc.channel.closed, true);
    assert.deepEqual(tmux.launches, []);
    assert.equal(tmux.existingTargets.size, 0);
  });

  it("waits for startup cancellation after launch and closes the worker pane", async () => {
    const { coordinator, ipc, tmux } = fixture();
    let releaseReady!: () => void;
    ipc.channel.readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const starting = coordinator.start({ task: "Inspect", model: "openai/model", thinking: "high" });
    const startRejected = assert.rejects(starting, /Subagent start was cancelled/u);
    while (tmux.launches.length === 0) await pause();

    let shutdownSettled = false;
    const shuttingDown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await pause();
    assert.equal(shutdownSettled, false);

    releaseReady();
    await startRejected;
    await shuttingDown;

    const cancelled = coordinator.list()[0];
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.paneState, "closed");
    assert.equal(cancelled?.tmuxTarget, "%9");
    assert.equal(ipc.channel.closed, true);
    assert.deepEqual(tmux.closed, ["%9"]);
    assert.equal(tmux.existingTargets.size, 0);
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

  it("targets the fixed background session when session placement is requested", async () => {
    const { coordinator, tmux } = fixture();

    await coordinator.start({
      mode: "main",
      model: "openai/model",
      thinking: "high",
      task: "Inspect in the background",
      placement: "session",
    });

    assert.equal(tmux.launches[0]?.placement, "session");
    assert.equal(tmux.launches[0]?.sessionName, "heishi-subagents");
    await coordinator.shutdown();
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
    assert.deepEqual(tmux.launches.map((launch) => launch.placement), ["session", "session"]);
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

  it("validates cleanup before prompting and repeats worktree checks during cleanup", async () => {
    const { coordinator, ipc, worktrees } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });

    await assert.rejects(
      () => coordinator.validateCleanup(started.runId),
      /runtime is still open or finalizing/u,
    );
    assert.deepEqual(worktrees.validatedForCleanup, []);

    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    const validated = await coordinator.validateCleanup(started.runId);
    assert.equal(validated.runId, started.runId);
    assert.deepEqual(worktrees.validatedForCleanup.length, 1);

    await coordinator.control({ runId: started.runId, action: "cleanup" });
    assert.deepEqual(worktrees.validatedForCleanup.length, 2);
  });

  it("excludes cleanup and resume while cleanup validation is in progress", async () => {
    const { coordinator, ipc, worktrees } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    let releaseValidation!: () => void;
    worktrees.cleanupValidationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });

    const validating = coordinator.validateCleanup(started.runId);
    while (worktrees.validatedForCleanup.length === 0) await pause();
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /already in progress/u,
    );
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "resume" }),
      /already in progress/u,
    );

    releaseValidation();
    await validating;
  });

  it("rejects dirty cleanup during non-mutating validation", async () => {
    const { coordinator, ipc, worktrees } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    worktrees.cleanupValidationError = new Error("Worktree has modified, untracked, or ignored files; cleanup refused");

    await assert.rejects(() => coordinator.validateCleanup(started.runId), /cleanup refused/u);
    assert.deepEqual(worktrees.cleaned, []);
  });

  it("persists removed metadata and error when cleanup detects inconsistent retained refs", async () => {
    const { coordinator, ipc, worktrees, records } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    const removed = removedWorktree(worktrees.record, "cleanup-commit");
    worktrees.cleanupError = new WorktreeOperationError(
      "Git worktree was removed, but retained refs are inconsistent: retained branch moved",
      removed,
    );

    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /retained refs are inconsistent/u,
    );

    const persisted = records.at(-1);
    assert.equal(persisted?.worktree?.state, "removed");
    assert.equal(persisted?.worktree?.state === "removed" ? persisted.worktree.resumeCommit : undefined, "cleanup-commit");
    assert.match(persisted?.error ?? "", /retained branch moved/u);
  });

  it("rejects cleanup and resume while auto-close finalization is still tearing down runtime resources", async () => {
    const { coordinator, ipc, tmux } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    let releaseClose!: () => void;
    tmux.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });

    const finalizing = ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    while (tmux.closed.length === 0) await pause();
    assert.equal(coordinator.list()[0]?.status, "running");
    assert.equal(coordinator.list()[0]?.paneState, "open");
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /runtime is still open or finalizing/u,
    );
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "resume" }),
      /runtime is still open or finalizing/u,
    );

    releaseClose();
    await finalizing;
    assert.equal((await coordinator.control({ runId: started.runId, action: "cleanup" })).worktree?.state, "removed");
  });

  it("keeps cleanup blocked when pane close verification finds the pane still present", async () => {
    const { coordinator, ipc, tmux } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    tmux.closeLeavesTarget = true;

    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });

    const run = coordinator.list()[0];
    assert.equal(run?.status, "completed");
    assert.equal(run?.paneState, "open");
    assert.match(run?.error ?? "", /still exists after close/u);
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /terminal target is closed/u,
    );
  });

  it("keeps cleanup blocked when pane close verification fails", async () => {
    const { coordinator, ipc, tmux } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    tmux.existsError = new Error("tmux server unavailable");

    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });

    const run = coordinator.list()[0];
    assert.equal(run?.paneState, "disconnected");
    assert.match(run?.error ?? "", /Could not verify.*server unavailable/u);
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /terminal target is closed/u,
    );
  });

  it("does not claim startup cleanup closed a pane that still exists", async () => {
    const { coordinator, tmux } = fixture({ model: "provider/unexpected" });
    tmux.closeLeavesTarget = true;

    const failed = await coordinator.start({
      mode: "main",
      thinking: "high",
      workspace: "worktree",
      task: "Implement",
      model: "provider/requested",
    });

    assert.equal(failed.status, "failed");
    assert.equal(coordinator.list()[0]?.paneState, "open");
    assert.match(failed.error ?? "", /still exists after close/u);
    await assert.rejects(
      () => coordinator.control({ runId: failed.runId, action: "cleanup" }),
      /terminal target is closed/u,
    );
  });

  it("persists ambiguous worktree state when resume rollback fails", async () => {
    const { coordinator, ipc, worktrees, records } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    await coordinator.control({ runId: started.runId, action: "cleanup" });
    const removed = coordinator.list()[0]?.worktree;
    assert.ok(removed);
    worktrees.resumeError = new WorktreeOperationError(
      "resume add failed; rollback failed",
      presentWorktree(removed),
    );

    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "resume" }),
      /rollback failed/u,
    );

    const persisted = records.at(-1);
    assert.equal(persisted?.worktree?.state, "present");
    assert.match(persisted?.error ?? "", /rollback failed/u);
    assert.deepEqual(worktrees.cleaned.length, 1);
  });

  it("cancels and waits for resume before runtime creation", async () => {
    const { coordinator, ipc, tmux, records } = fixture();
    coordinator.restore([completedRun()]);
    let releaseValidation!: () => void;
    tmux.validateGate = new Promise<void>((resolve) => { releaseValidation = resolve; });

    const resuming = coordinator.control({ runId: "run-1", action: "resume" });
    const resumeRejected = assert.rejects(resuming, /Subagent resume was cancelled/u);
    while (!tmux.validated) await pause();
    let abortSettled = false;
    const aborting = coordinator.control({ runId: "run-1", action: "abort" })
      .then((result) => { abortSettled = true; return result; });
    await pause();
    assert.equal(abortSettled, false);

    releaseValidation();
    await resumeRejected;
    const aborted = await aborting;

    assert.equal(aborted.status, "cancelled");
    assert.equal(ipc.openCalls, 0);
    assert.deepEqual(tmux.launches, []);
    assert.deepEqual(tmux.closed, []);
    assert.equal(records.at(-1)?.status, "cancelled");
    assert.ok(records.at(-1)?.completedAt);
    assert.match(records.at(-1)?.error ?? "", /Subagent resume was cancelled/u);
  });

  it("cancels and closes a resume after its runtime launches", async () => {
    const { coordinator, ipc, tmux, records } = fixture();
    coordinator.restore([completedRun()]);
    let releaseReady!: () => void;
    ipc.channel.readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });

    const resuming = coordinator.control({ runId: "run-1", action: "resume" });
    const resumeRejected = assert.rejects(resuming, /Subagent resume was cancelled/u);
    while (tmux.launches.length === 0) await pause();
    let abortSettled = false;
    const aborting = coordinator.control({ runId: "run-1", action: "abort" })
      .then((result) => { abortSettled = true; return result; });
    await pause();
    assert.equal(abortSettled, false);

    releaseReady();
    await resumeRejected;
    const aborted = await aborting;

    assert.equal(aborted.status, "cancelled");
    assert.equal(ipc.channel.closed, true);
    assert.deepEqual(tmux.closed, ["%9"]);
    assert.equal(tmux.existingTargets.size, 0);
    assert.equal(records.at(-1)?.status, "cancelled");
    await assert.rejects(
      () => coordinator.control({ runId: "run-1", action: "prompt", message: "More" }),
      /not connected/u,
    );
  });

  it("cancels and waits for an in-progress resume during shutdown", async () => {
    const { coordinator, ipc, tmux, records } = fixture();
    coordinator.restore([completedRun()]);
    let releaseOpen!: () => void;
    ipc.openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });

    const resuming = coordinator.control({ runId: "run-1", action: "resume" });
    const resumeRejected = assert.rejects(resuming, /Subagent resume was cancelled/u);
    while (ipc.openCalls === 0) await pause();
    let shutdownSettled = false;
    const shuttingDown = coordinator.shutdown().then(() => { shutdownSettled = true; });
    await pause();
    assert.equal(shutdownSettled, false);

    releaseOpen();
    await resumeRejected;
    await shuttingDown;

    assert.equal(records.at(-1)?.status, "cancelled");
    assert.equal(ipc.channel.closed, true);
    assert.deepEqual(tmux.launches, []);
    assert.deepEqual(tmux.closed, []);
    await assert.rejects(
      () => coordinator.control({ runId: "run-1", action: "resume" }),
      /coordinator is shutting down/u,
    );
  });

  it("does not close a stale pane target when resume fails before launch", async () => {
    const { coordinator, ipc, tmux } = fixture();
    coordinator.restore([{
      ...completedRun(),
      tmuxTarget: "%stale",
      tmuxWindowId: "@old",
      tmuxSessionId: "$old",
    }]);
    ipc.failOpen = true;

    await assert.rejects(() => coordinator.control({ runId: "run-1", action: "resume" }), /IPC unavailable/u);

    assert.deepEqual(tmux.closed, []);
    assert.equal(coordinator.list()[0]?.paneState, "closed");
  });

  it("closes only the pane returned by the current resume launch", async () => {
    for (const target of ["%new", "%stale"] as const) {
      const { coordinator, tmux } = fixture({ sessionId: "wrong-session" });
      coordinator.restore([{
        ...completedRun(),
        tmuxTarget: "%stale",
        tmuxWindowId: "@old",
        tmuxSessionId: "$old",
      }]);
      tmux.nextTarget = { paneId: target, windowId: "@new", sessionId: "$new" };

      await assert.rejects(
        () => coordinator.control({ runId: "run-1", action: "resume" }),
        /expected session-1/u,
      );

      assert.deepEqual(tmux.closed, [target]);
      assert.equal(coordinator.list()[0]?.paneState, "closed");
    }
  });

  it("rejects resume while cleanup is concurrently in progress", async () => {
    const { coordinator, ipc, worktrees } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });
    let releaseCleanup!: () => void;
    worktrees.cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });

    const cleaning = coordinator.control({ runId: started.runId, action: "cleanup" });
    while (worktrees.cleaned.length === 0) await pause();
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "resume" }),
      /cleanup or resume operation is already in progress/u,
    );

    releaseCleanup();
    assert.equal((await cleaning).worktree?.state, "removed");
  });

  it("cleans only settled closed worktree runs and recreates them on resume", async () => {
    const { coordinator, ipc, worktrees } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", workspace: "worktree", task: "Implement" });
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /runtime is still open or finalizing/u,
    );
    await ipc.emit({ type: "settled", runId: started.runId, version: 1, finalText: "Done" });

    const cleaned = await coordinator.control({ runId: started.runId, action: "cleanup" });
    assert.equal(cleaned.worktree?.state, "removed");
    assert.equal(worktrees.cleaned.length, 1);

    const resumed = await coordinator.control({ runId: started.runId, action: "resume" });
    assert.equal(resumed.worktree?.state, "present");
    assert.equal(worktrees.resumed[0]?.state, "removed");
    await assert.rejects(
      () => coordinator.control({ runId: started.runId, action: "cleanup" }),
      /runtime is still open or finalizing/ui,
    );
    await coordinator.shutdown();
  });

  it("rejects cleanup for shared runs", async () => {
    const { coordinator } = fixture();
    coordinator.restore([completedMainRun()]);
    await assert.rejects(
      () => coordinator.control({ runId: "run-1", action: "cleanup" }),
      /Shared workspace runs/u,
    );
  });

  it("rejects resume until a disconnected pane is verified closed", async () => {
    const { coordinator, tmux } = fixture();
    coordinator.restore([{ ...completedMainRun(), paneState: "disconnected", tmuxTarget: "%8" }]);

    await assert.rejects(
      () => coordinator.control({ runId: "run-1", action: "resume" }),
      /Verify the subagent terminal target is closed before resume/u,
    );
    assert.deepEqual(tmux.launches, []);
  });

  it("resumes main sessions without forcing their last effective model or thinking", async () => {
    const { coordinator, tmux } = fixture({ model: "provider/changed", thinking: "max" });
    coordinator.restore([completedMainRun()]);

    const resumed = await coordinator.control({ runId: "run-1", action: "resume" });

    assert.equal(resumed.mode, "main");
    assert.equal(resumed.model, "provider/changed");
    assert.equal(resumed.thinking, "max");
    assert.equal(tmux.launches[0]?.command.includes("--model"), false);
    assert.equal(tmux.launches[0]?.command.includes("--thinking"), false);
    assert.deepEqual(tmux.launches[0]?.command.slice(-2), ["--session", "/sessions/session-1.jsonl"]);
    await coordinator.shutdown();
  });

  it("tracks main model and thinking changes reported by the bridge", async () => {
    const { coordinator, ipc } = fixture();
    const started = await coordinator.start({ mode: "main", model: "openai/model", thinking: "high", task: "Inspect" });

    await ipc.emit({
      type: "metadata",
      runId: started.runId,
      version: 1,
      model: "provider/switched",
      thinking: "xhigh",
    });

    assert.equal(coordinator.list()[0]?.model, "provider/switched");
    assert.equal(coordinator.list()[0]?.thinking, "xhigh");
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
