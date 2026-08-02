import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileRuns, restoreRunSnapshots } from "./registry.js";
import type { RunRecord } from "./types.js";

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
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

  it("marks restored open panes disconnected when tmux no longer has them", async () => {
    const restored = await reconcileRuns([makeRunRecord()], { exists: async () => false, close: async () => undefined });

    assert.equal(restored[0]?.paneState, "disconnected");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /no longer exists/);
  });

  it("closes restored panes that no longer have a parent IPC connection", async () => {
    const closed: string[] = [];
    const restored = await reconcileRuns([makeRunRecord()], {
      exists: async () => true,
      close: async (target) => { closed.push(target); },
    });

    assert.deepEqual(closed, ["%1"]);
    assert.equal(restored[0]?.paneState, "closed");
    assert.equal(restored[0]?.status, "failed");
    assert.match(restored[0]?.error ?? "", /connection/);
  });
});
