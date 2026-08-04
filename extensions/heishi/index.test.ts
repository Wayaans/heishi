import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import heishi from "./index.js";

interface RegisteredTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, {
      description?: string;
      anyOf?: Array<{ const?: string }>;
    }>;
  };
  renderResult?: (
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: unknown,
    theme: unknown,
  ) => { render(width: number): string[] };
}

describe("Heishi tool prompt metadata", () => {
  it("makes the subagent workflow and concurrent starts discoverable to the main agent", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI;

    heishi(pi);

    const start = requireTool(tools, "subagent_start");
    const control = requireTool(tools, "subagent_control");
    const wait = requireTool(tools, "subagent_wait");
    for (const tool of [start, control, wait]) {
      assert.ok(tool.promptSnippet?.trim(), `${tool.name} should have a prompt snippet`);
      assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes(`\`${tool.name}\``)), `${tool.name} guidelines should name the tool`);
      for (const [name, schema] of Object.entries(tool.parameters.properties ?? {})) {
        assert.ok(schema.description?.trim(), `${tool.name}.${name} should have a description`);
      }
    }

    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("multiple `subagent_start` tool calls in the same turn")
        && guideline.includes("concurrently");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("use `subagent_control` first only when live interaction is needed")
        && guideline.includes("otherwise use `subagent_wait` immediately")
        && guideline.includes("Do not inspect, implement, or answer");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => guideline.includes("non-overlapping work") && guideline.includes("worktrees")));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("After `subagent_wait` returns")
        && guideline.includes("`resume`")
        && guideline.includes("`prompt` or `follow_up`");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("Use `steer` only while")
        && guideline.includes("do not use `steer` after `subagent_wait`");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("After `prompt`, `follow_up`, or `steer`")
        && guideline.includes("`subagent_wait`");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("`placement` parameter is optional")
        && guideline.includes("Omit it unless the user explicitly requests")
        && guideline.includes("falls back to `session`");
    }));
    assert.match(
      start.parameters.properties?.["placement"]?.description ?? "",
      /Omit unless the user explicitly requests one; omission falls back to session/u,
    );
    assert.deepEqual(
      start.parameters.properties?.["placement"]?.anyOf?.map((placement) => placement.const),
      ["pane", "window", "session"],
    );
    assert.deepEqual(
      control.parameters.properties?.["action"]?.anyOf?.map((action) => action.const),
      ["prompt", "steer", "follow_up", "abort", "resume"],
    );
  });

  it("renders the run duration at the end of a settled result", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI;
    heishi(pi);

    const renderResult = requireTool(tools, "subagent_wait").renderResult;
    assert.ok(renderResult);
    const rendered = renderResult({
      content: [],
      details: {
        runId: "12345678-1234-1234-1234-123456789abc",
        alias: "Atalanta",
        status: "completed",
        model: "openai/model",
        thinking: "high",
        durationMs: 83_000,
      },
    }, {}, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(200).join("\n").trimEnd();

    assert.match(rendered, /Duration: 1m 23s$/u);
  });

  it("shows provider, model, and thinking only for resume control results", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI;
    heishi(pi);

    const renderResult = requireTool(tools, "subagent_control").renderResult;
    assert.ok(renderResult);
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const details = {
      runId: "12345678-1234-1234-1234-123456789abc",
      alias: "Atalanta",
      status: "completed",
      model: "openai-codex/gpt-5.6-luna",
      thinking: "high",
    };

    const resumed = renderResult({
      content: [],
      details: { ...details, action: "resume" },
    }, {}, theme).render(200).join("\n");
    const prompted = renderResult({
      content: [],
      details: { ...details, action: "prompt" },
    }, {}, theme).render(200).join("\n");

    assert.match(resumed, /Resumed with: openai-codex\/gpt-5\.6-luna \/ high/u);
    assert.doesNotMatch(prompted, /openai-codex\/gpt-5\.6-luna|high/u);
  });

  it("renders running location metadata without repeating model and thinking", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI;
    heishi(pi);

    const renderResult = requireTool(tools, "subagent_start").renderResult;
    assert.ok(renderResult);
    const rendered = renderResult({
      content: [],
      details: {
        runId: "12345678-1234-1234-1234-123456789abc",
        alias: "Atalanta",
        status: "running",
        tmuxTarget: "%9",
        tmuxWindowId: "@2",
        tmuxSessionId: "$1",
        model: "openai/model",
        thinking: "high",
      },
    }, {}, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(200).join("\n");

    assert.match(rendered, /^→ Atalanta · 123456  running/u);
    assert.match(rendered, /pane id %9 · window id @2 · session id \$1/u);
    assert.doesNotMatch(rendered, /openai\/model|high/u);
  });
});

function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} to be registered`);
  return tool;
}
