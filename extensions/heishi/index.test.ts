import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorktreeCleanupApproval } from "./cleanup.js";
import heishi, { currentPiInvocation } from "./index.js";
import { RUN_ENTRY_TYPE } from "./registry.js";
import type { ControlInput, RunRecord, RunResult } from "./types.js";

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
  renderCall?: (
    args: Record<string, unknown>,
    theme: unknown,
    context: {
      state: Record<string, unknown>;
      lastComponent?: { render(width: number): string[] };
      executionStarted: boolean;
      isPartial: boolean;
      isError: boolean;
      invalidate(): void;
    },
  ) => { render(width: number): string[] };
  renderResult?: (
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: unknown,
    theme: unknown,
    context?: { state: Record<string, unknown>; isError?: boolean },
  ) => { render(width: number): string[] };
}

interface RegisteredCommand {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler(args: string, ctx: unknown): Promise<void>;
}

initTheme("dark", false);

describe("Heishi tool prompt metadata", () => {
  it("resolves a relative current script before workers change cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-index-test-"));
    try {
      const script = join(root, "pi.mjs");
      await writeFile(script, "");
      const invocation = currentPiInvocation(["node", relative(process.cwd(), script)], "/bin/node");
      assert.deepEqual(invocation, ["/bin/node", script]);
      assert.equal(isAbsolute(invocation[1] ?? ""), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes the subagent workflow and concurrent starts discoverable to the main agent", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;

    heishi(pi);

    const start = requireTool(tools, "subagent_start");
    const control = requireTool(tools, "subagent_control");
    for (const tool of [start, control]) {
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
      return guideline.includes("fresh session")
        && guideline.includes("none of the parent conversation")
        && guideline.includes("prior tool results");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("load and follow the `writing-for-agents` skill")
        && guideline.includes("when it is available")
        && guideline.includes("continue without it");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("Every `subagent_start.task` must be self-contained")
        && guideline.includes("objective")
        && guideline.includes("expected deliverable")
        && guideline.includes("required verification");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("as discussed above")
        && guideline.includes("reproducing the necessary context");
    }));
    assert.match(start.parameters.properties?.["task"]?.description ?? "", /worker receives no parent conversation/u);
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("classify the task by its intended repository side effects")
        && guideline.includes("pass `mode` explicitly");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("Use `sub` mode for read-only work")
        && guideline.includes("without creating, editing, or deleting repository files");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("Use `main` mode for write work")
        && guideline.includes("documentation and tests");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("mixed investigation and write work")
        && guideline.includes("sub-mode investigation followed by a main-mode implementation")
        && guideline.includes("use main mode");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("read-only task")
        && guideline.includes("not to modify files")
        && guideline.includes("final report");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("Omit `model` and `thinking` unless the user explicitly requests them")
        && guideline.includes("Pi's default model and thinking level");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("run in the background")
        && guideline.includes("arrives automatically")
        && guideline.includes("Do not poll");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("end your turn")
        && guideline.includes("Do not inspect, implement, or answer");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => guideline.includes("non-overlapping files") && guideline.includes("worktree workspaces")));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("action `prompt` to give a worker new work after its completion message arrives")
        && guideline.includes("resumes the closed worker automatically");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("Use `steer` only while a subagent is actively running")
        && guideline.includes("use `prompt` instead");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("reports `blocked` with a structured request")
        && guideline.includes("obtain the requested external input in the parent session")
        && guideline.includes("action `prompt`");
    }));
    assert.equal(
      [...(start.promptGuidelines ?? []), ...(control.promptGuidelines ?? [])].some((guideline) => {
        return /subagent_wait|subagent_models|delegation pool|follow_up|`resume`|cleanup|`placement`/u.test(guideline);
      }),
      false,
    );
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("Do not assign write work to a sub-mode run")
        && guideline.includes("start a main-mode run instead");
    }));
    assert.equal(start.parameters.properties?.["placement"], undefined);
    assert.deepEqual(
      control.parameters.properties?.["action"]?.anyOf?.map((action) => action.const),
      ["prompt", "steer", "abort"],
    );
    assert.deepEqual(
      start.parameters.properties?.["mode"]?.anyOf?.map((mode) => mode.const),
      ["sub", "main"],
    );
    assert.deepEqual(
      start.parameters.properties?.["workspace"]?.anyOf?.map((workspace) => workspace.const),
      ["shared", "worktree"],
    );
    assert.equal(start.parameters.required?.includes("model"), false);
    assert.equal(start.parameters.required?.includes("thinking"), false);
    assert.deepEqual(tools.map((tool) => tool.name), ["subagent_start", "subagent_control"]);
  });

  it("runs cleanup only after interactive confirmation", async () => {
    const { coordinator, controls, run } = cleanupFixture();
    const confirmations: Array<{ title: string; message: string }> = [];

    const result = await new WorktreeCleanupApproval().execute(coordinator, run.runId, "ask", {
      mode: "tui",
      ui: {
        async confirm(title, message) {
          confirmations.push({ title, message });
          return true;
        },
      },
    });

    assert.equal(result.worktree?.state, "removed");
    assert.deepEqual(coordinator.validations, [run.runId]);
    assert.deepEqual(controls, [{ runId: run.runId, action: "cleanup" }]);
    assert.match(confirmations[0]?.title ?? "", new RegExp(run.alias, "u"));
    assert.match(confirmations[0]?.message ?? "", new RegExp(run.alias, "u"));
    assert.match(confirmations[0]?.message ?? "", new RegExp(run.worktree?.path ?? "missing", "u"));
  });

  it("does not call cleanup when interactive confirmation is declined", async () => {
    const { coordinator, controls, run } = cleanupFixture();

    await assert.rejects(
      () => new WorktreeCleanupApproval().execute(coordinator, run.runId, "ask", {
        mode: "tui",
        ui: { confirm: async () => false },
      }),
      /cleanup cancelled/u,
    );

    assert.deepEqual(coordinator.validations, [run.runId]);
    assert.deepEqual(controls, []);
  });

  it("does not prompt when cleanup preflight rejects active, open, or dirty worktrees", async () => {
    for (const options of [
      { run: { status: "running" as const }, expected: /settled run/u },
      { run: { paneState: "open" as const }, expected: /pane is closed/u },
      { validationError: new Error("Worktree has modified, untracked, or ignored files; cleanup refused"), expected: /cleanup refused/u },
    ]) {
      const { coordinator, controls, run } = cleanupFixture(options);
      let confirmations = 0;

      await assert.rejects(
        () => new WorktreeCleanupApproval().execute(coordinator, run.runId, "ask", {
          mode: "tui",
          ui: {
            async confirm() {
              confirmations += 1;
              return true;
            },
          },
        }),
        options.expected,
      );

      assert.equal(confirmations, 0);
      assert.deepEqual(controls, []);
    }
  });

  it("rejects non-TUI cleanup without confirmation or coordinator cleanup", async () => {
    const { coordinator, controls, run } = cleanupFixture();
    let confirmations = 0;

    await assert.rejects(
      () => new WorktreeCleanupApproval().execute(coordinator, run.runId, "ask", {
        mode: "print",
        ui: {
          async confirm() {
            confirmations += 1;
            return true;
          },
        },
      }),
      /requires confirmation in the interactive TUI/u,
    );

    assert.equal(confirmations, 0);
    assert.deepEqual(coordinator.validations, []);
    assert.deepEqual(controls, []);
  });

  it("allows configured cleanup without a prompt in non-interactive mode", async () => {
    const { coordinator, controls, run } = cleanupFixture();
    let confirmations = 0;

    await new WorktreeCleanupApproval().execute(coordinator, run.runId, "allow", {
      mode: "print",
      ui: {
        async confirm() {
          confirmations += 1;
          return false;
        },
      },
    });

    assert.equal(confirmations, 0);
    assert.deepEqual(controls, [{ runId: run.runId, action: "cleanup" }]);
  });

  it("queues parallel cleanup confirmations and continues after each decision", async () => {
    const first = cleanupFixture({ run: { runId: "run-first", alias: "Atalanta" } });
    const second = cleanupFixture({ run: { runId: "run-second", alias: "Circe" } });
    const resolvers: Array<(confirmed: boolean) => void> = [];
    const titles: string[] = [];
    const approval = new WorktreeCleanupApproval();
    const ctx = {
      mode: "tui" as const,
      ui: {
        confirm(title: string) {
          titles.push(title);
          return new Promise<boolean>((resolve) => resolvers.push(resolve));
        },
      },
    };

    const firstCleanup = approval.execute(first.coordinator, first.run.runId, "ask", ctx);
    const secondCleanup = approval.execute(second.coordinator, second.run.runId, "ask", ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(titles.length, 1);
    assert.match(titles[0] ?? "", /Atalanta/u);
    assert.deepEqual(second.coordinator.validations, []);

    resolvers[0]?.(false);
    await assert.rejects(firstCleanup, /cleanup cancelled/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(titles.length, 2);
    assert.match(titles[1] ?? "", /Circe/u);

    resolvers[1]?.(true);
    await secondCleanup;
    assert.deepEqual(first.controls, []);
    assert.deepEqual(second.controls, [{ runId: second.run.runId, action: "cleanup" }]);
  });

  it("injects the mode and delegation policies into the main agent prompt", () => {
    type BeforeAgentStart = (
      event: { systemPrompt: string },
      ctx: {
        modelRegistry: { getAvailable(): Model<any>[] };
        scopedModels: [];
        model: Model<any>;
        thinkingLevel: "high";
      },
    ) => { systemPrompt: string };
    let beforeAgentStart: BeforeAgentStart | undefined;
    const pi = {
      on(event: string, handler: unknown) {
        if (event === "before_agent_start") beforeAgentStart = handler as BeforeAgentStart;
      },
      registerCommand() {},
      registerTool() {},
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;

    heishi(pi);
    assert.ok(beforeAgentStart);
    const result = beforeAgentStart(
      { systemPrompt: "Base prompt" },
      {
        modelRegistry: { getAvailable: () => [] },
        scopedModels: [],
        model: testModel("provider", "session-model"),
        thinkingLevel: "high",
      },
    );

    assert.match(result.systemPrompt, /classify the task by its intended repository side effects/u);
    assert.match(result.systemPrompt, /fresh session and receives none of the parent conversation/u);
    assert.match(result.systemPrompt, /load and follow the `writing-for-agents` skill when it is available/u);
    assert.match(result.systemPrompt, /Every `subagent_start\.task` must be self-contained/u);
    assert.match(result.systemPrompt, /Use `sub` mode for read-only work/u);
    assert.match(result.systemPrompt, /Use `main` mode for write work/u);
    assert.match(result.systemPrompt, /pass `mode` explicitly/u);
    assert.doesNotMatch(result.systemPrompt, /subagent_models|delegation pool|cleanup|provider\/session-model/u);
  });

  it("accepts only the interactive settings command", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const notifications: string[] = [];
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    heishi(pi);
    const command = commands.get("heishi");
    assert.ok(command);
    const ctx = {
      mode: "print",
      ui: { notify(message: string) { notifications.push(message); } },
    };

    await command.handler("mode", ctx);
    await command.handler("settings", ctx);

    assert.deepEqual(notifications, [
      "Usage: /heishi [settings]",
      "Heishi settings require the interactive TUI",
    ]);
  });

  it("starts without a model pool and validates only explicit model requests", async () => {
    const tools: RegisteredTool[] = [];
    heishi({
      on() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerCommand() {},
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI);
    const start = requireTool(tools, "subagent_start").execute;
    assert.ok(start);
    const plain = { ...testModel("provider", "plain"), reasoning: false };
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) => provider === "provider" && id === "plain" ? plain : undefined,
        hasConfiguredAuth: () => true,
      },
    };

    for (const mode of ["sub", "main"]) {
      await assert.rejects(
        () => start(`default-${mode}`, { mode, task: "Inspect" }, undefined, undefined, ctx),
        /coordinator is not initialized/u,
      );
    }
    await assert.rejects(
      () => start("explicit", { mode: "sub", task: "Inspect", model: "provider/plain", thinking: "off" }, undefined, undefined, ctx),
      /coordinator is not initialized/u,
    );
    await assert.rejects(
      () => start("missing", { mode: "main", task: "Inspect", model: "provider/missing" }, undefined, undefined, ctx),
      /not available or authenticated/u,
    );
    await assert.rejects(
      () => start("unsupported", { mode: "main", task: "Inspect", model: "provider/plain", thinking: "high" }, undefined, undefined, ctx),
      /does not support thinking high/u,
    );
    await assert.rejects(
      () => start("worktree", { mode: "sub", workspace: "worktree", task: "Inspect" }, undefined, undefined, ctx),
      /worktree workspace is available only in main mode/ui,
    );
  });

  it("loads mode, workspace, and terminal host from trusted project settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-index-"));
    try {
      const configDirectory = join(root, CONFIG_DIR_NAME);
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "heishi.json"), JSON.stringify({
        mode: "main",
        workspace: "worktree",
        terminalHost: "cmux",
      }));
      let sessionStart!: (event: unknown, ctx: unknown) => Promise<void>;
      let beforeAgentStart!: (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt: string };
      const pi = {
        on(event: string, handler: unknown) {
          if (event === "session_start") sessionStart = handler as typeof sessionStart;
          if (event === "before_agent_start") beforeAgentStart = handler as typeof beforeAgentStart;
        },
        registerTool() {},
        appendEntry() {},
        registerCommand() {},
        registerMessageRenderer() {},
      } as unknown as ExtensionAPI;
      heishi(pi);
      const model = testModel("provider", "session-model");
      const ctx = {
        cwd: root,
        scopedModels: [],
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => [] },
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        model,
        thinkingLevel: "high",
      };

      await sessionStart({ reason: "startup" }, ctx);
      const prompt = beforeAgentStart({ systemPrompt: "Base" }, ctx).systemPrompt;
      assert.match(prompt, /default mode is `main`/u);
      assert.match(prompt, /workspace default is `worktree`/u);
      assert.match(prompt, /terminal host is `cmux`/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("completes every supported Heishi argument", () => {
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    heishi(pi);
    const complete = commands.get("heishi")?.getArgumentCompletions;
    assert.ok(complete);

    assert.deepEqual(complete("")?.map((item) => item.value), ["settings"]);
    assert.deepEqual(complete("s")?.map((item) => item.value), ["settings"]);
    assert.equal(complete("settings "), null);
    assert.equal(complete("mode"), null);
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
        registerMessageRenderer() {},
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

    assert.deepEqual(tools, ["subagent_start", "subagent_control", "subagent_report"]);
    assert.deepEqual(commands, ["heishi", "subagent"]);
  });

  it("renders completions as a two-line box that expands to the full report", () => {
    const renderers = new Map<string, (message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] } | undefined>();
    heishi({
      on() {},
      registerCommand() {},
      registerTool() {},
      registerMessageRenderer(type: string, renderer: (message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] } | undefined) {
        renderers.set(type, renderer);
      },
    } as unknown as ExtensionAPI);
    const renderer = renderers.get("heishi:subagent-completion");
    assert.ok(renderer);
    const backgrounds: string[] = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => { backgrounds.push(color); return text; },
      bold: (text: string) => text,
    };
    const message = {
      role: "custom",
      customType: "heishi:subagent-completion",
      content: "",
      display: true,
      details: {
        runId: "12345678-1234-1234-1234-123456789abc",
        alias: "Atalanta",
        status: "completed",
        mode: "main",
        model: "openai/model",
        thinking: "high",
        hostTarget: { host: "headless", pid: 42, startedAt: "now" },
        workspace: "worktree",
        worktree: { path: "/agent/heishi/worktrees/repo-abc/run-id", branch: "heishi/run-id", baseCommit: "abc", state: "present" },
        report: { status: "completed", summary: "Implemented the change.", structured: true },
        durationMs: 83_000,
      },
    };
    const render = (expanded: boolean): string[] => (renderer(message, { expanded, outputPad: 0 }, theme)?.render(200) ?? [])
      .map((line) => line.trim())
      .filter(Boolean);

    const collapsed = render(false);
    assert.deepEqual(collapsed, [
      "✓ Atalanta · 123456  completed · 1m 23s",
      "main · openai/model / high · /worktrees/repo-abc/run-id · heishi/run-id · headless · pid 42",
    ]);
    assert.equal(backgrounds.includes("toolSuccessBg"), true);
    const narrow = (renderer(message, { expanded: false, outputPad: 0 }, theme)?.render(40) ?? []).filter((line) => line.trim());
    assert.equal(narrow.length, 2);

    const expanded = render(true).join("\n");
    assert.match(expanded, /Run: 12345678-1234-1234-1234-123456789abc/u);
    assert.match(expanded, /Implemented the change\./u);
    assert.equal(renderer({ ...message, details: { alias: "Atalanta" } }, { expanded: false, outputPad: 0 }, theme), undefined);
  });

  it("delivers restored undelivered completions once without starting a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-index-"));
    try {
      const pending: RunRecord = {
        version: 4,
        mode: "sub",
        workspace: "shared",
        runId: "12345678-1234-1234-1234-123456789abc",
        alias: "Atalanta",
        taskPreview: "Inspect",
        cwd: root,
        model: "openai/model",
        thinking: "high",
        placement: "session",
        status: "completed",
        paneState: "closed",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        report: { status: "completed", summary: "Done", structured: true },
        completionDelivered: false,
      };
      const delivered: RunRecord = { ...pending, runId: "abcdefab-1234-1234-1234-123456789abc", completionDelivered: true };
      const sent: Array<{ message: { customType: string; content: string; details: { runId: string; durationMs: number } }; options: unknown }> = [];
      const appended: RunRecord[] = [];
      let sessionStart!: (event: unknown, ctx: unknown) => Promise<void>;
      heishi({
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
          if (event === "session_start") sessionStart = handler;
        },
        appendEntry(_type: string, record: RunRecord) { appended.push(record); },
        sendMessage(message: (typeof sent)[number]["message"], options: unknown) { sent.push({ message, options }); },
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
      } as unknown as ExtensionAPI);
      const entries = [pending, delivered].map((data) => ({ type: "custom", customType: RUN_ENTRY_TYPE, data }));
      const ctx = {
        cwd: root,
        scopedModels: [],
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => [] },
        sessionManager: { getBranch: () => entries },
        ui: { notify() {} },
      };

      await sessionStart({ reason: "resume" }, ctx);

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.message.customType, "heishi:subagent-completion");
      assert.equal(sent[0]?.message.details.runId, pending.runId);
      assert.equal(sent[0]?.message.details.durationMs, 60_000);
      assert.match(sent[0]?.message.content ?? "", /settled with status completed/u);
      assert.equal(sent[0]?.options, undefined);
      assert.equal(appended.at(-1)?.runId, pending.runId);
      assert.equal(appended.at(-1)?.completionDelivered, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders control results as a status header without model details", () => {
    const tools: RegisteredTool[] = [];
    heishi({
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI);

    const renderResult = requireTool(tools, "subagent_control").renderResult;
    assert.ok(renderResult);
    const prompted = renderResult({
      content: [],
      details: {
        runId: "12345678-1234-1234-1234-123456789abc",
        alias: "Atalanta",
        status: "running",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "high",
        action: "prompt",
      },
    }, {}, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(200).join("\n");

    assert.match(prompted, /Atalanta · 123456  running/u);
    assert.doesNotMatch(prompted, /openai-codex\/gpt-5\.6-luna/u);
  });

  it("renders worktree path, branch, base commit, and state", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    heishi(pi);

    const renderResult = requireTool(tools, "subagent_start").renderResult;
    assert.ok(renderResult);
    const details = {
      runId: "12345678-1234-1234-1234-123456789abc",
      alias: "Atalanta",
      status: "running" as const,
      workspace: "worktree" as const,
      worktree: {
        path: "/agent/heishi/worktrees/repo-abc/run-id",
        branch: "heishi/run-id",
        baseCommit: "abc123",
        state: "present" as const,
      },
    };
    const rendered = renderResult({
      content: [],
      details,
    }, {}, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(200).join("\n");

    assert.match(rendered, /Worktree: \/worktrees\/repo-abc\/run-id · heishi\/run-id · base abc123 · present/u);
    assert.doesNotMatch(rendered, /\/agent\/heishi\/worktrees/u);
    assert.equal(details.worktree.path, "/agent/heishi/worktrees/repo-abc/run-id");
  });

  it("renders the explicit main model instead of a configured-default placeholder", () => {
    const tools: RegisteredTool[] = [];
    heishi({
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI);
    const renderCall = requireTool(tools, "subagent_start").renderCall;
    assert.ok(renderCall);
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const context = { state: {}, executionStarted: true, isPartial: false, isError: false, invalidate() {} };
    assert.doesNotMatch(renderCall({ mode: "main", thinking: "high" }, theme, context).render(200).join("\n"), /configured default/u);
    assert.match(renderCall({ mode: "main", model: "provider/requested", thinking: "low" }, theme, context).render(200).join("\n"), /provider\/requested \/ low/u);
    assert.doesNotMatch(renderCall({ mode: "sub", thinking: "high" }, theme, context).render(200).join("\n"), /configured default/u);
  });

  it("renders running location metadata and the resolved model and thinking", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerMessageRenderer() {},
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
        host: "tmux",
        hostTarget: { host: "tmux", paneId: "%9", windowId: "@2", sessionId: "$1" },
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
    assert.match(rendered, /tmux · pane %9 · window @2 · session \$1/u);
    assert.match(rendered, /Started with: openai\/model \/ high/u);
  });
});

function cleanupFixture(options: {
  run?: Partial<RunRecord>;
  validationError?: Error;
} = {}): {
  coordinator: {
    validations: string[];
    validateCleanup(runId: string): Promise<RunRecord>;
    control(input: ControlInput): Promise<RunResult>;
  };
  controls: ControlInput[];
  run: RunRecord;
} {
  const worktree = {
    path: "/agent/heishi/worktrees/repo-abc/run-cleanup",
    branch: "heishi/run-cleanup",
    baseCommit: "abc123",
    state: "present" as const,
    gitCommonDir: "/repo/.git",
    repositoryName: "repo",
    relativeCwd: ".",
  };
  const run: RunRecord = {
    version: 4,
    mode: "main",
    workspace: "worktree",
    worktree,
    runId: "run-cleanup",
    alias: "Atalanta",
    taskPreview: "Implement",
    cwd: "/repo",
    placement: "window",
    status: "completed",
    paneState: "closed",
    completionDelivered: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...options.run,
  };
  const controls: ControlInput[] = [];
  const validations: string[] = [];
  return {
    run,
    controls,
    coordinator: {
      validations,
      async validateCleanup(runId) {
        validations.push(runId);
        if (options.validationError) throw options.validationError;
        if (run.status === "created" || run.status === "starting" || run.status === "running") {
          throw new Error("Worktree cleanup requires a settled run");
        }
        if (run.paneState !== "closed") {
          throw new Error("Verify the subagent pane is closed before worktree cleanup");
        }
        return run;
      },
      async control(input) {
        controls.push(input);
        return {
          runId: run.runId,
          alias: run.alias,
          status: run.status,
          workspace: "worktree",
          worktree: {
            path: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
            state: "removed",
          },
        };
      },
    },
  };
}

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
