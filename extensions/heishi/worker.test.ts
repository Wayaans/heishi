import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWorkerMode, workerSystemPrompt } from "./worker.js";

describe("worker mode bootstrap", () => {
  it("keeps missing worker mode compatible with constrained sub workers", () => {
    assert.equal(resolveWorkerMode({}), "sub");
    assert.equal(resolveWorkerMode({ HEISHI_WORKER_MODE: "sub" }), "sub");
    assert.throws(() => resolveWorkerMode({ HEISHI_WORKER_MODE: "invalid" }), /Invalid Heishi worker mode/u);
  });

  it("makes sub workers explicitly parent-facing and context-isolated", () => {
    const prompt = workerSystemPrompt("sub");

    assert.match(prompt, /delegated worker, not a user-facing agent/u);
    assert.match(prompt, /only external communication channel is the parent agent/u);
    assert.match(prompt, /fresh, isolated session/u);
    assert.match(prompt, /do not have the parent conversation/u);
    assert.match(prompt, /Do not ask the user questions/u);
    assert.match(prompt, /status `blocked` and a structured `request`/u);
    assert.match(prompt, /Do not delegate to additional subagents/u);
  });

  it("gives main workers the same delegation contract plus normal resources", () => {
    const prompt = workerSystemPrompt("main");

    assert.match(prompt, /delegated worker, not a user-facing agent/u);
    assert.match(prompt, /only external communication channel is the parent agent/u);
    assert.match(prompt, /do not have the parent conversation/u);
    assert.match(prompt, /Do not ask the user questions/u);
    assert.match(prompt, /normal Pi coding agent with all loaded resources/u);
    assert.match(prompt, /prefer `subagent_report`/u);
    assert.match(prompt, /final assistant response/u);
    assert.doesNotMatch(prompt, /Do not delegate|Complete only/u);
  });
});
