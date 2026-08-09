import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import heishi from "./index.js";

interface RegisteredTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    required?: string[];
    properties?: Record<string, {
      description?: string;
      anyOf?: Array<{ const?: string }>;
    }>;
  };
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
  renderResult?: (
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: unknown,
    theme: unknown,
  ) => { render(width: number): string[] };
}

interface RegisteredCommand {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler(args: string, ctx: unknown): Promise<void>;
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
    assert.deepEqual(
      start.parameters.properties?.["mode"]?.anyOf?.map((mode) => mode.const),
      ["sub", "main"],
    );
    assert.equal(start.parameters.required?.includes("model") ?? false, false);
    assert.equal(start.parameters.required?.includes("thinking") ?? false, false);
    assert.deepEqual(tools.map((tool) => tool.name), ["subagent_start", "subagent_control", "subagent_wait"]);
  });

  it("toggles and persists the session default mode", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const entries: Array<{ type: string; data: unknown }> = [];
    const notifications: string[] = [];
    const pi = {
      on() {},
      registerTool() {},
      appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    heishi(pi);
    const command = commands.get("heishi");
    assert.ok(command);
    const ctx = { ui: { notify(message: string) { notifications.push(message); } } };

    await command.handler("mode", ctx);
    await command.handler("mode main", ctx);
    await command.handler("mode sub", ctx);
    await command.handler("invalid", ctx);

    assert.deepEqual(entries, [
      { type: "heishi:mode", data: { mode: "main" } },
      { type: "heishi:mode", data: { mode: "sub" } },
    ]);
    assert.deepEqual(notifications, [
      "Heishi default mode: main",
      "Heishi default mode: main",
      "Heishi default mode: sub",
      "Usage: /heishi model | /heishi mode [sub|main]",
    ]);
  });

  it("lets explicit mode override the default and keeps main available with an empty sub pool", async () => {
    const tools: RegisteredTool[] = [];
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on() {},
      appendEntry() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    heishi(pi);
    const start = requireTool(tools, "subagent_start").execute;
    assert.ok(start);
    const ctx = {
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
      ui: { notify() {} },
    };

    await assert.rejects(
      () => start("call-1", { mode: "main", task: "Inspect" }, undefined, undefined, ctx),
      /coordinator is not initialized/u,
    );
    await commands.get("heishi")!.handler("mode main", ctx);
    await assert.rejects(
      () => start("call-2", { task: "Inspect" }, undefined, undefined, ctx),
      /coordinator is not initialized/u,
    );
    await assert.rejects(
      () => start("call-3", { mode: "sub", task: "Inspect", model: "provider/model", thinking: "high" }, undefined, undefined, ctx),
      /delegation models are not configured/u,
    );
  });

  it("rejects sub starts outside a non-empty configured pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-index-"));
    try {
      const configDirectory = join(root, CONFIG_DIR_NAME);
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "heishi.json"), JSON.stringify({
        models: [{ model: "provider/allowed", thinking: "high" }],
      }));
      const tools: RegisteredTool[] = [];
      let sessionStart!: (event: unknown, ctx: unknown) => Promise<void>;
      const pi = {
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
          if (event === "session_start") sessionStart = handler;
        },
        appendEntry() {},
        registerTool(tool: RegisteredTool) { tools.push(tool); },
        registerCommand() {},
      } as unknown as ExtensionAPI;
      heishi(pi);
      const available = testModel("provider", "allowed");
      const ctx = {
        cwd: root,
        scopedModels: [],
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => [available] },
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
      };
      await sessionStart({ reason: "startup" }, ctx);

      await assert.rejects(
        () => requireTool(tools, "subagent_start").execute!(
          "call-1",
          { mode: "sub", task: "Inspect", model: "provider/allowed", thinking: "medium" },
          undefined,
          undefined,
          ctx,
        ),
        /pair is not allowed/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores existing session mode and resets new and forked sessions to sub", async () => {
    const sessionHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
    const commands = new Map<string, RegisteredCommand>();
    const entries: Array<{ type: string; data: unknown }> = [];
    const pi = {
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === "session_start") sessionHandlers.push(handler);
      },
      registerTool() {},
      appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    heishi(pi);
    const sessionStart = sessionHandlers[0];
    assert.ok(sessionStart);
    const branch = [{ type: "custom", customType: "heishi:mode", data: { mode: "main" } }];
    const ctx = {
      cwd: "/repo",
      mode: "tui",
      scopedModels: [],
      isProjectTrusted: () => false,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: { getBranch: () => branch },
      ui: { notify() {} },
    };

    await sessionStart({ reason: "startup" }, ctx);
    await commands.get("heishi")!.handler("mode", ctx);
    assert.deepEqual(entries.at(-1), { type: "heishi:mode", data: { mode: "sub" } });

    for (const reason of ["new", "fork"]) {
      entries.length = 0;
      await sessionStart({ reason }, ctx);
      assert.deepEqual(entries, [{ type: "heishi:mode", data: { mode: "sub" } }]);
    }
  });

  it("completes root and nested Heishi arguments with full replacement values", () => {
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    heishi(pi);
    const complete = commands.get("heishi")?.getArgumentCompletions;
    assert.ok(complete);

    assert.deepEqual(complete("" )?.map((item) => item.value), ["model", "mode"]);
    assert.deepEqual(complete("m")?.map((item) => item.value), ["model", "mode"]);
    assert.deepEqual(complete("mode ")?.map((item) => item.value), ["mode sub", "mode main"]);
    assert.deepEqual(complete("mode m")?.map((item) => item.value), ["mode main"]);
  });

  it("registers the bridge and normal Heishi tools together in main workers", async () => {
    const socketPath = join(tmpdir(), `heishi-main-worker-${process.pid}-${Date.now()}.sock`);
    let workerConnected!: () => void;
    const connected = new Promise<void>((resolve) => { workerConnected = resolve; });
    const server = createServer((socket) => {
      workerConnected();
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const previous = {
      worker: process.env["HEISHI_WORKER"],
      mode: process.env["HEISHI_WORKER_MODE"],
      runId: process.env["HEISHI_RUN_ID"],
      token: process.env["HEISHI_TOKEN"],
      socket: process.env["HEISHI_SOCKET"],
    };
    const tools: string[] = [];
    const commands: string[] = [];
    try {
      process.env["HEISHI_WORKER"] = "1";
      process.env["HEISHI_WORKER_MODE"] = "main";
      process.env["HEISHI_RUN_ID"] = "run-main";
      process.env["HEISHI_TOKEN"] = "token";
      process.env["HEISHI_SOCKET"] = socketPath;
      heishi({
        on() {},
        registerTool(tool: RegisteredTool) { tools.push(tool.name); },
        registerCommand(name: string) { commands.push(name); },
      } as unknown as ExtensionAPI);
      await connected;
    } finally {
      restoreEnvironment("HEISHI_WORKER", previous.worker);
      restoreEnvironment("HEISHI_WORKER_MODE", previous.mode);
      restoreEnvironment("HEISHI_RUN_ID", previous.runId);
      restoreEnvironment("HEISHI_TOKEN", previous.token);
      restoreEnvironment("HEISHI_SOCKET", previous.socket);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    }

    assert.deepEqual(tools, ["subagent_start", "subagent_control", "subagent_wait", "subagent_report"]);
    assert.deepEqual(commands, ["heishi", "subagent"]);
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

function testModel(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} to be registered`);
  return tool;
}
