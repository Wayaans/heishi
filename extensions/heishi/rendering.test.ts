import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reportMarkdown, runIdentity } from "./rendering.js";

describe("subagent report rendering", () => {
  it("renders every substantive report field once as Markdown", () => {
    const markdown = reportMarkdown({
      status: "completed",
      summary: "Implemented the fix.",
      verification: "`bun test` passed.",
      remainingRisk: "Manual tmux verification remains.",
      structured: true,
    });

    assert.equal(markdown.match(/Implemented the fix\./gu)?.length, 1);
    assert.doesNotMatch(markdown, /\*\*Status:\*\*/u);
    assert.match(markdown, /# Report/u);
    assert.match(markdown, /## Verification\n\n`bun test` passed\./u);
    assert.match(markdown, /## Remaining risk\n\nManual tmux verification remains\./u);
  });

  it("marks main run identities while leaving sub results unchanged", () => {
    const base = { runId: "12345678-1234-1234-1234-123456789abc", alias: "Circe", status: "running" as const };

    assert.equal(runIdentity(base), "Circe · 123456");
    assert.equal(runIdentity({ ...base, mode: "main" }), "Circe · 123456 · main");
  });

  it("makes omitted optional fields explicit", () => {
    const markdown = reportMarkdown({
      status: "blocked",
      summary: "Missing project information.",
      structured: true,
    });

    assert.match(markdown, /## Verification\n\nNot provided\./u);
    assert.match(markdown, /## Remaining risk\n\nNone reported\./u);
  });
});
