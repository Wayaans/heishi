import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileRuns, restoreRunSnapshots, restoreSessionMode, restoreSessionWorkspace } from "./registry.js";
import type { RunRecord } from "./types.js";

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 3,
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

    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: legacy },
    ]);

    assert.equal(restored[0]?.version, 3);
    assert.equal(restored[0]?.mode, "sub");
    assert.equal(restored[0]?.workspace, "shared");
  });

  it("rejects pane states without the metadata needed to manage them", () => {
    for (const malformed of [
      { ...makeRunRecord(), tmuxTarget: undefined },
      { ...makeRunRecord(), tmuxWindowId: undefined },
      { ...makeRunRecord(), tmuxSessionId: undefined },
      {
        ...makeRunRecord({ status: "failed", paneState: "disconnected" }),
        tmuxTarget: undefined,
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

  it("restores the latest valid mode from the active branch", () => {
    assert.equal(restoreSessionMode([
      { type: "custom", customType: "heishi:mode", data: { mode: "main" } },
      { type: "custom", customType: "heishi:mode", data: { mode: "invalid" } },
      { type: "custom", customType: "heishi:mode", data: { mode: "sub" } },
    ]), "sub");
    assert.equal(restoreSessionMode([]), undefined);
  });

  it("normalizes version-2 records to shared workspace", () => {
    const legacy = { ...makeRunRecord(), version: 2 } as Record<string, unknown>;
    delete legacy["workspace"];

    const restored = restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: legacy },
    ]);

    assert.equal(restored[0]?.version, 3);
    assert.equal(restored[0]?.workspace, "shared");
  });

  it("restores the latest valid workspace from the active branch", () => {
    assert.equal(restoreSessionWorkspace([
      { type: "custom", customType: "heishi:workspace", data: { workspace: "worktree" } },
      { type: "custom", customType: "heishi:workspace", data: { workspace: "invalid" } },
      { type: "custom", customType: "heishi:workspace", data: { workspace: "shared" } },
    ]), "shared");
    assert.equal(restoreSessionWorkspace([]), undefined);
  });

  it("marks restored open panes disconnected when tmux no longer has them", async () => {
    const restored = await reconcileRuns([makeRunRecord()], { exists: async () => false, close: async () => undefined });

    assert.equal(restored[0]?.paneState, "disconnected");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /no longer exists/);
  });

  it("closes restored panes that no longer have a parent IPC connection", async () => {
    const closed: string[] = [];
    let exists = true;
    const restored = await reconcileRuns([makeRunRecord()], {
      exists: async () => exists,
      close: async (target) => { closed.push(target); exists = false; },
    });

    assert.deepEqual(closed, ["%1"]);
    assert.equal(restored[0]?.paneState, "closed");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /connection/);
  });

  it("keeps restored panes open when close verification still finds them", async () => {
    const restored = await reconcileRuns([makeRunRecord()], {
      exists: async () => true,
      close: async () => undefined,
    });

    assert.equal(restored[0]?.paneState, "open");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /still exists after close/u);
    assert.equal(restoreRunSnapshots([
      { type: "custom", customType: "heishi:subagent-run", data: restored[0] },
    ]).length, 1);
  });
});
