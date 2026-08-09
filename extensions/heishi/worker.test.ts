import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWorkerMode, workerSystemPrompt } from "./worker.js";

const EXISTING_SUBAGENT_PROMPT = `You are a delegated subagent running in an isolated Pi session.
Complete only the task assigned by the parent agent. Work independently and efficiently.
Do not delegate to additional subagents.
Follow the loaded AGENTS.md instructions and use available coding tools as needed.
You may receive steering and follow-up tasks from the parent.
Finish delegated work by calling subagent_report exactly once with outcome, concise summary, verification, blockers, and remaining risks.`;

describe("worker mode bootstrap", () => {
  it("keeps missing worker mode compatible with constrained sub workers", () => {
    assert.equal(resolveWorkerMode({}), "sub");
    assert.equal(resolveWorkerMode({ HEISHI_WORKER_MODE: "sub" }), "sub");
    assert.throws(() => resolveWorkerMode({ HEISHI_WORKER_MODE: "invalid" }), /Invalid Heishi worker mode/u);
  });

  it("preserves the exact sub prompt", () => {
    assert.equal(workerSystemPrompt("sub"), EXISTING_SUBAGENT_PROMPT);
  });

  it("gives main workers only the managed reporting contract", () => {
    const prompt = workerSystemPrompt("main");

    assert.match(prompt, /normal Pi coding agent with all loaded resources/u);
    assert.match(prompt, /prefer `subagent_report`/u);
    assert.match(prompt, /final assistant response/u);
    assert.doesNotMatch(prompt, /Do not delegate|Complete only/u);
  });
});
