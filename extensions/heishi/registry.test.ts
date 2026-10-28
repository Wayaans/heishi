import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileRuns, restoreRunSnapshots } from "./registry.js";
import { HeadlessHost } from "./headless.js";
import { TerminalHostResolver } from "./terminal-host-resolver.js";
import type { TerminalHosts } from "./terminal-host.js";
import { TmuxHost, type TmuxAdapter } from "./tmux.js";
import type { RunRecord } from "./types.js";

function restorationHosts(adapter: Pick<TmuxAdapter, "exists" | "close">): TerminalHosts {
  return new TerminalHostResolver([new TmuxHost({
    validate: async () => undefined,
    launch: async () => { throw new Error("Restoration cannot launch a worker"); },
    focus: async () => undefined,
    ...adapter,
  })], async () => "tmux");
}

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 4,
    mode: "sub",
    workspace: "shared",
    runId: "run-1",
    alias: "Circe",
    taskPreview: "Inspect the checkout",
    cwd: "/repo",
    model: "openai/model",
    thinking: "high",
    placement: "pane",
    status: "running",
    paneState: "open",
    hostTarget: { host: "tmux", paneId: "%1", windowId: "@1", sessionId: "$1" },
    tmuxTarget: "%1",
    tmuxWindowId: "@1",
    tmuxSessionId: "$1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("run registry restoration", () => {
  it("uses the latest snapshot per UUID from the supplied session branch", () => {
    const first = makeRunRecord();
    const latest = makeRunRecord({ status: "completed", paneState: "closed", updatedAt: "2026-01-01T00:02:00.000Z" });
    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: first },
      { type: "message", message: {} },
      { type: "custom", customType: "heishi:subagent-run", data: latest },
    ]);

    assert.deepEqual(restored, [latest]);
  });

  it("normalizes legacy version-1 records to sub mode", () => {
    const legacy = { ...makeRunRecord(), version: 1 } as Record<string, unknown>;
    delete legacy["mode"];
    delete legacy["hostTarget"];

    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: legacy },
    ]);

    assert.equal(restored[0]?.version, 4);
    assert.equal(restored[0]?.mode, "sub");
    assert.equal(restored[0]?.workspace, "shared");
  });

  it("restores targetless closed legacy records", () => {
    for (const version of [1, 2, 3] as const) {
      const legacy = {
        ...makeRunRecord({ status: "completed", paneState: "closed" }),
        version,
      } as Record<string, unknown>;
      delete legacy["hostTarget"];
      delete legacy["tmuxTarget"];
      delete legacy["tmuxWindowId"];
      delete legacy["tmuxSessionId"];
      if (version === 1) delete legacy["mode"];
      if (version <= 2) delete legacy["workspace"];

      assert.equal(restoreRunSnapshots([
        { type: "custom", customType: "heishi:subagent-run", data: legacy },
      ]).length, 1, `version ${version}`);
    }
  });

  it("normalizes version-3 tmux records into version-4 host targets", () => {
    const legacy = { ...makeRunRecord(), version: 3 } as Record<string, unknown>;
    delete legacy["hostTarget"];

    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: legacy },
    ]);

    assert.deepEqual(restored[0]?.hostTarget, {
      host: "tmux",
      paneId: "%1",
      windowId: "@1",
      sessionId: "$1",
    });

    const disconnected = { ...legacy, paneState: "disconnected", status: "failed" } as Record<string, unknown>;
    delete disconnected["tmuxWindowId"];
    delete disconnected["tmuxSessionId"];
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: disconnected },
    ])[0]?.hostTarget, { host: "tmux", paneId: "%1" });
  });

  it("restores cmux UUID targets and rejects malformed IDs", () => {
    const target = {
      host: "cmux" as const,
      windowId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      socketPath: "/tmp/cmux.sock",
      closeKind: "workspace" as const,
      groupId: "55555555-5555-4555-8555-555555555555",
      groupAnchorWorkspaceId: "66666666-6666-4666-8666-666666666666",
    };
    const cmux = makeRunRecord({ hostTarget: target });
    delete cmux.tmuxTarget;
    delete cmux.tmuxWindowId;
    delete cmux.tmuxSessionId;
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: cmux },
    ])[0]?.hostTarget, target);

    const { groupId: _groupId, groupAnchorWorkspaceId: _groupAnchorWorkspaceId, ...ungrouped } = target;
    const dedicatedTarget = { ...ungrouped, closeKind: "surface" as const, dedicatedWorkspace: true as const };
    assert.deepEqual(restoreRunSnapshots([{
      type: "custom",
      customType: "heishi:subagent-run",
      data: { ...cmux, hostTarget: dedicatedTarget },
    }])[0]?.hostTarget, dedicatedTarget);

    for (const malformedTarget of [
      { ...target, surfaceId: "surface:1" },
      { ...target, groupAnchorWorkspaceId: undefined },
      { ...dedicatedTarget, closeKind: "workspace" },
    ]) {
      const malformed = { ...cmux, hostTarget: malformedTarget };
      assert.deepEqual(restoreRunSnapshots([
        { type: "custom", customType: "heishi:subagent-run", data: malformed },
      ]), []);
    }
  });

  it("restores headless process targets and rejects invalid process IDs", () => {
    const target = { host: "headless" as const, pid: 4242, startedAt: "Tue Oct 28 10:26:15 2026" };
    const headless = makeRunRecord({ hostTarget: target });
    delete headless.tmuxTarget;
    delete headless.tmuxWindowId;
    delete headless.tmuxSessionId;
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: headless },
    ])[0]?.hostTarget, target);

    for (const malformedTarget of [
      ...[0, -1, 1.5, "4242"].map((pid) => ({ ...target, pid })),
      { ...target, startedAt: "" },
      { host: "headless", pid: 4242 },
    ]) {
      assert.deepEqual(restoreRunSnapshots([{
        type: "custom",
        customType: "heishi:subagent-run",
        data: { ...headless, hostTarget: malformedTarget },
      }]), []);
    }
  });

  it("rejects pane states without the metadata needed to manage them", () => {
    for (const malformed of [
      { ...makeRunRecord(), hostTarget: undefined },
      {
        ...makeRunRecord({ status: "failed", paneState: "disconnected" }),
        hostTarget: undefined,
      },
    ]) {
      assert.deepEqual(restoreRunSnapshots([
        { type: "custom", customType: "heishi:subagent-run", data: malformed },
      ]), []);
    }

    const disconnected = makeRunRecord({ status: "failed", paneState: "disconnected" });
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: disconnected },
    ]), [disconnected]);
  });

  it("rejects defined empty or malformed tmux IDs even for closed panes", () => {
    for (const overrides of [
      { tmuxTarget: "" },
      { tmuxTarget: "pane-1" },
      { tmuxTarget: "%" },
      { tmuxTarget: "%bad" },
      { tmuxTarget: "%bad target" },
      { tmuxWindowId: "" },
      { tmuxWindowId: "window-1" },
      { tmuxWindowId: "@" },
      { tmuxWindowId: "@window" },
      { tmuxSessionId: "" },
      { tmuxSessionId: "session-1" },
      { tmuxSessionId: "$" },
      { tmuxSessionId: "$session" },
    ]) {
      const closed = { ...makeRunRecord({ status: "completed", paneState: "closed" }), ...overrides };
      assert.deepEqual(restoreRunSnapshots([
        { type: "custom", customType: "heishi:subagent-run", data: closed },
      ]), []);
    }

    const closedWithoutTargets = makeRunRecord({ status: "completed", paneState: "closed" });
    delete closedWithoutTargets.hostTarget;
    delete closedWithoutTargets.tmuxTarget;
    delete closedWithoutTargets.tmuxWindowId;
    delete closedWithoutTargets.tmuxSessionId;
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: closedWithoutTargets },
    ]), [closedWithoutTargets]);
  });

  it("rejects persisted records with invalid enum fields", () => {
    for (const overrides of [
      { mode: "invalid" },
      { status: "invalid" },
      { paneState: "invalid" },
      { placement: "invalid" },
      { thinking: "invalid" },
      { tmuxTarget: 42 },
      { cwd: "" },
      { cwd: "relative/repo" },
      { report: { status: "completed", summary: 42, structured: true } },
    ]) {
      const restored = restoreRunSnapshots([
        { type: "custom", customType: "heishi:subagent-run", data: { ...makeRunRecord(), ...overrides } },
      ]);
      assert.deepEqual(restored, []);
    }
  });

  it("restores precise worktree metadata only for its matching main run", () => {
    const runId = "12345678-1234-1234-1234-123456789abc";
    const worktree = {
      path: `/agent/heishi/worktrees/repo-abc/${runId}`,
      branch: `heishi/${runId}`,
      baseCommit: "abc123",
      state: "present" as const,
      gitCommonDir: "/repo/.git",
      repositoryName: "repo",
      relativeCwd: ".",
    };
    const valid = makeRunRecord({ mode: "main", workspace: "worktree", worktree, runId });
    const mismatched = makeRunRecord({ mode: "main", workspace: "worktree", worktree });

    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: valid },
    ]), [valid]);
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: mismatched },
    ]), []);
  });

  it("accepts only reachable lifecycle states for present worktrees", () => {
    const runId = "12345678-1234-1234-1234-123456789abc";
    const worktree = {
      path: `/agent/heishi/worktrees/repo-abc/${runId}`,
      branch: `heishi/${runId}`,
      baseCommit: "abc123",
      state: "present" as const,
      gitCommonDir: "/repo/.git",
      repositoryName: "repo",
      relativeCwd: ".",
    };
    const base = makeRunRecord({ mode: "main", workspace: "worktree", worktree, runId });
    const restores = (overrides: Partial<RunRecord>) => restoreRunSnapshots([{
      type: "custom",
      customType: "heishi:subagent-run",
      data: { ...base, ...overrides },
    }]);

    assert.deepEqual(restores({ status: "created", paneState: "closed" }), []);
    assert.deepEqual(restores({ status: "running", paneState: "closed" }), []);
    assert.deepEqual(restores({ status: "running", paneState: "disconnected" }), []);
    assert.equal(restores({ status: "starting", paneState: "closed" }).length, 1);
    assert.equal(restores({ status: "starting", paneState: "open" }).length, 1);
    assert.deepEqual(restores({ status: "starting", paneState: "disconnected" }), []);
    for (const status of ["completed", "blocked", "failed", "cancelled"] as const) {
      for (const paneState of ["open", "closed", "disconnected"] as const) {
        assert.equal(restores({ status, paneState }).length, 1, `${status}/${paneState}`);
      }
    }
  });

  it("rejects unsafe relative worktree cwd metadata", () => {
    const runId = "12345678-1234-1234-1234-123456789abc";
    const baseWorktree = {
      path: `/agent/heishi/worktrees/repo-abc/${runId}`,
      branch: `heishi/${runId}`,
      baseCommit: "abc123",
      state: "present" as const,
      gitCommonDir: "/repo/.git",
      repositoryName: "repo",
      relativeCwd: ".",
    };
    for (const relativeCwd of ["", "..", "../outside", "src/../../outside", "/absolute", "C:\\absolute"] as const) {
      const restored = restoreRunSnapshots([{
        type: "custom",
        customType: "heishi:subagent-run",
        data: makeRunRecord({
          mode: "main",
          workspace: "worktree",
          worktree: { ...baseWorktree, relativeCwd },
          runId,
        }),
      }]);
      assert.deepEqual(restored, [], relativeCwd);
    }
  });

  it("requires resume commits only for removed worktrees", () => {
    const runId = "12345678-1234-1234-1234-123456789abc";
    const common = {
      path: `/agent/heishi/worktrees/repo-abc/${runId}`,
      branch: `heishi/${runId}`,
      baseCommit: "abc123",
      gitCommonDir: "/repo/.git",
      repositoryName: "repo",
      relativeCwd: ".",
    };
    const snapshot = (worktree: unknown) => restoreRunSnapshots([{
      type: "custom",
      customType: "heishi:subagent-run",
      data: {
        ...makeRunRecord({
          mode: "main",
          workspace: "worktree",
          runId,
          status: "completed",
          paneState: "closed",
        }),
        worktree,
      },
    }]);

    assert.deepEqual(snapshot({ ...common, state: "removed" }), []);
    assert.deepEqual(snapshot({ ...common, state: "present", resumeCommit: "obsolete" }), []);
    assert.equal(snapshot({ ...common, state: "removed", resumeCommit: "def456" }).length, 1);
    assert.equal(snapshot({ ...common, state: "present" }).length, 1);
  });

  it("rejects active or open removed worktrees and restores terminal closed ones", () => {
    const runId = "12345678-1234-1234-1234-123456789abc";
    const removedWorktree = {
      path: `/agent/heishi/worktrees/repo-abc/${runId}`,
      branch: `heishi/${runId}`,
      baseCommit: "abc123",
      state: "removed" as const,
      resumeCommit: "def456",
      gitCommonDir: "/repo/.git",
      repositoryName: "repo",
      relativeCwd: ".",
    };
    const base = makeRunRecord({
      mode: "main",
      workspace: "worktree",
      worktree: removedWorktree,
      runId,
      status: "completed",
      paneState: "closed",
    });
    const snapshots = (run: RunRecord) => restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: run },
    ]);

    assert.deepEqual(snapshots({ ...base, status: "running" }), []);
    assert.deepEqual(snapshots({ ...base, paneState: "open" }), []);
    for (const status of ["completed", "blocked", "failed", "cancelled"] as const) {
      const terminal = { ...base, status };
      assert.deepEqual(snapshots(terminal), [terminal]);
    }
  });

  it("restores worktree preparation failures without fabricated metadata", () => {
    const failed = makeRunRecord({
      mode: "main",
      workspace: "worktree",
      status: "failed",
      paneState: "closed",
      error: "Source directory is not a Git checkout",
    });
    const invalidCompleted = { ...failed, status: "completed" };
    const malformed = { ...failed, worktree: { path: "/outside" } };

    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: failed },
    ]), [failed]);
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: invalidCompleted },
    ]), []);
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: malformed },
    ]), []);
    assert.deepEqual(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: { ...failed, status: "starting", paneState: "open" } },
    ]), []);
  });

  it("normalizes version-2 records to shared workspace", () => {
    const legacy = { ...makeRunRecord(), version: 2 } as Record<string, unknown>;
    delete legacy["workspace"];
    delete legacy["hostTarget"];

    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: legacy },
    ]);

    assert.equal(restored[0]?.version, 4);
    assert.equal(restored[0]?.workspace, "shared");
  });

  it("marks restored open panes disconnected when tmux no longer has them", async () => {
    const restored = await reconcileRuns([makeRunRecord()], restorationHosts({
      exists: async () => false,
      close: async () => undefined,
    }));

    assert.equal(restored[0]?.paneState, "disconnected");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /no longer exists/);
  });

  it("marks restored headless workers closed when their process has exited", async () => {
    const run = makeRunRecord({ hostTarget: { host: "headless", pid: 4242, startedAt: "Tue Oct 28 10:26:15 2026" } });
    delete run.tmuxTarget;
    delete run.tmuxWindowId;
    delete run.tmuxSessionId;
    const missingProcess = Object.assign(new Error("ps exited"), { code: 1 });
    const hosts = new TerminalHostResolver([
      new HeadlessHost({ exec: async () => { throw missingProcess; } }),
    ]);

    const restored = await reconcileRuns([run], hosts);

    assert.equal(restored[0]?.paneState, "closed");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /exited with the previous parent session/);
  });

  it("closes restored panes that no longer have a parent IPC connection", async () => {
    const closed: string[] = [];
    let exists = true;
    const restored = await reconcileRuns([makeRunRecord()], restorationHosts({
      exists: async () => exists,
      close: async (target) => { closed.push(target); exists = false; },
    }));

    assert.deepEqual(closed, ["%1"]);
    assert.equal(restored[0]?.paneState, "closed");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /connection/);
  });

  it("keeps restored panes open when close verification still finds them", async () => {
    const restored = await reconcileRuns([makeRunRecord()], restorationHosts({
      exists: async () => true,
      close: async () => undefined,
    }));

    assert.equal(restored[0]?.paneState, "open");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /still exists after close/u);
    assert.equal(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: restored[0] },
    ]).length, 1);
  });
});
