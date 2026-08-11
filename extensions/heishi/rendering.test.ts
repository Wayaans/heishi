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

  it("renders blocked external-input requests and makes other omitted fields explicit", () => {
    const markdown = reportMarkdown({
      status: "blocked",
      summary: "Missing project information.",
      request: {
        kind: "missing_context",
        prompt: "Which deployment environment is in scope?",
        options: ["staging", "production"],
        recommendation: "Use staging for the first verification run.",
      },
      structured: true,
    });

    assert.match(markdown, /## External input required/u);
    assert.match(markdown, /Kind: missing_context/u);
    assert.match(markdown, /Which deployment environment is in scope\?/u);
    assert.match(markdown, /- staging\n- production/u);
    assert.match(markdown, /Recommendation: Use staging/u);
    assert.match(markdown, /## Verification\n\nNot provided\./u);
    assert.match(markdown, /## Remaining risk\n\nNone reported\./u);
  });
});
