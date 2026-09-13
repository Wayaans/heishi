import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorktreeCleanupApproval } from "./cleanup.js";
import heishi, { currentPiInvocation } from "./index.js";
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
      return guideline.includes("both `window` and `session` open a surface tab in the caller pane");
    }));
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
      return guideline.includes("call `subagent_models`")
        && guideline.includes("saved worker defaults")
        && guideline.includes("Pass both `model` and `thinking` explicitly");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("saved worker model/thinking pair as the main-mode baseline")
        && guideline.includes("Explicit user requests take priority independently for each field")
        && guideline.includes("suited to the task");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("Do not inherit the parent session's active model or thinking level")
        && guideline.includes("or use the Heishi delegation pool as a fallback for main mode");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("use `subagent_control` first only when live interaction is needed")
        && guideline.includes("otherwise use `subagent_wait` immediately")
        && guideline.includes("Do not inspect, implement, or answer");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => guideline.includes("non-overlapping files") && guideline.includes("worktree workspaces")));
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
    assert.ok(wait.promptGuidelines?.some((guideline) => {
      return guideline.includes("blocked report with a structured request")
        && guideline.includes("obtain the requested external input in the parent session")
        && guideline.includes("resume the worker")
        && guideline.includes("call `subagent_wait` again");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("Do not assign write work to a sub-mode run")
        && guideline.includes("start a main-mode run instead");
    }));
    assert.ok(control.promptGuidelines?.some((guideline) => {
      return guideline.includes("configured worktree approval policy")
        && guideline.includes("queues interactive confirmations")
        && guideline.includes("allow mode skips the prompt");
    }));
    assert.ok(start.promptGuidelines?.some((guideline) => {
      return guideline.includes("`placement` parameter is optional")
        && guideline.includes("Omit it unless the user explicitly requests")
        && guideline.includes("defaults to `session` in sub mode")
        && guideline.includes("`window` in main mode");
    }));
    assert.match(
      start.parameters.properties?.["placement"]?.description ?? "",
      /Omit unless the user explicitly requests one; omission defaults to session in sub mode and window in main mode/u,
    );
    assert.deepEqual(
      start.parameters.properties?.["placement"]?.anyOf?.map((placement) => placement.const),
      ["pane", "window", "session"],
    );
    assert.deepEqual(
      control.parameters.properties?.["action"]?.anyOf?.map((action) => action.const),
      ["prompt", "steer", "follow_up", "abort", "resume", "cleanup"],
    );
    assert.deepEqual(
      start.parameters.properties?.["mode"]?.anyOf?.map((mode) => mode.const),
      ["sub", "main"],
    );
    assert.deepEqual(
      start.parameters.properties?.["workspace"]?.anyOf?.map((workspace) => workspace.const),
      ["shared", "worktree"],
    );
    assert.equal(start.parameters.required?.includes("model"), true);
    assert.equal(start.parameters.required?.includes("thinking"), true);
    assert.deepEqual(tools.map((tool) => tool.name), ["subagent_models", "subagent_start", "subagent_control", "subagent_wait"]);
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

  it("injects the mode and main-model selection policies into the main agent prompt", () => {
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
    assert.match(result.systemPrompt, /call `subagent_models`/u);
    assert.match(result.systemPrompt, /saved worker model\/thinking pair as the main-mode baseline/u);
    assert.match(result.systemPrompt, /Pass both `model` and `thinking` explicitly/u);
    assert.match(result.systemPrompt, /Explicit user requests take priority independently for each field/u);
    assert.match(result.systemPrompt, /agent declaration, not proof of user authorization/u);
    assert.match(result.systemPrompt, /Do not inherit the parent session's active model or thinking level/u);
    assert.match(result.systemPrompt, /Main mode uses subagent_models discovery and requires an explicit model\/thinking pair/u);
    assert.doesNotMatch(result.systemPrompt, /provider\/session-model|exact active model\/thinking pair|final fallback/u);
  });

  it("accepts only the interactive settings command", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const notifications: string[] = [];
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
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

  it("keeps explicit main mode available with an empty sub pool", async () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      registerCommand() {},
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
      /Main mode requires an explicit model and thinking level/u,
    );
    await assert.rejects(
      () => start("call-thinking", { mode: "main", task: "Implement", thinking: "high" }, undefined, undefined, ctx),
      /Main mode requires an explicit model and thinking level/u,
    );
    await assert.rejects(
      () => start("call-model-only", { mode: "main", task: "Implement", model: "provider/requested" }, undefined, undefined, ctx),
      /Main mode requires an explicit model and thinking level/u,
    );
    const requested = testModel("provider", "requested");
    const requestedContext = {
      ...ctx,
      modelRegistry: { getAvailable: () => [requested], find: () => requested, hasConfiguredAuth: () => true },
    };
    const pair = { mode: "main", task: "Implement", model: "provider/requested", thinking: "high" };
    await assert.rejects(
      () => start("call-pair", pair, undefined, undefined, requestedContext),
      /No authenticated models in the current session scope/u,
    );
    await assert.rejects(
      () => start("call-user-pair", { ...pair, userRequestedModel: true }, undefined, undefined, requestedContext),
      /coordinator is not initialized/u,
    );
    await assert.rejects(
      () => start("call-scoped-pair", pair, undefined, undefined, { ...requestedContext, scopedModels: [{ model: requested }] }),
      /coordinator is not initialized/u,
    );
    await assert.rejects(
      () => start("call-2", { mode: "sub", workspace: "worktree", task: "Inspect", model: "provider/model", thinking: "high" }, undefined, undefined, ctx),
      /worktree workspace is available only in main mode/ui,
    );
    await assert.rejects(
      () => start("call-3", { mode: "sub", task: "Inspect", model: "provider/model", thinking: "high" }, undefined, undefined, ctx),
      /delegation models are not configured/u,
    );
  });

  it("discovers scoped choices and saved defaults without copying the parent's active pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-discovery-"));
    try {
      await mkdir(join(root, CONFIG_DIR_NAME));
      await writeFile(join(root, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
        defaultProvider: "provider", defaultModel: "saved", defaultThinkingLevel: "medium",
        modelThinkingLevels: { "provider/saved": "low" },
      }));
      const tools: RegisteredTool[] = [];
      heishi({
        on() {}, registerCommand() {},
        registerTool(tool: RegisteredTool) { tools.push(tool); },
      } as unknown as ExtensionAPI);
      const discover = requireTool(tools, "subagent_models").execute;
      assert.ok(discover);
      const saved = testModel("provider", "saved");
      const active = testModel("provider", "active");
      const requested = testModel("provider", "outside");
      const ctx = {
        cwd: root, isProjectTrusted: () => true,
        model: active, thinkingLevel: "high",
        scopedModels: [{ model: saved, thinkingLevel: "high" }],
        modelRegistry: {
          getAvailable: () => [saved, active, requested],
          find: (provider: string, id: string) => provider === "provider" && id === "outside" ? requested : undefined,
          hasConfiguredAuth: () => true,
        },
      };
      const result = JSON.stringify(await discover("models", {}, undefined, undefined, ctx));
      assert.match(result, /provider\/saved/u);
      assert.match(result, /"pair":\{"model":"provider\/saved","thinking":"low"\}/u);
      assert.doesNotMatch(result, /provider\/active|provider\/outside|baseUrl/u);
      const targeted = JSON.stringify(await discover("requested", { userRequestedModel: "provider/outside" }, undefined, undefined, ctx));
      assert.match(targeted, /"userRequestedModel":\{"model":"provider\/outside"/u);
      assert.doesNotMatch(targeted, /provider\/active/u);
      const empty = JSON.stringify(await discover("empty", {}, undefined, undefined, { ...ctx, scopedModels: [] }));
      assert.match(empty, /No authenticated models in the current session scope/u);
      assert.doesNotMatch(empty, /provider\/saved|provider\/active|provider\/outside/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects undeclared out-of-scope choices, unsupported user pairs, and sub exceptions", async () => {
    const tools: RegisteredTool[] = [];
    heishi({ on() {}, registerCommand() {}, registerTool(tool: RegisteredTool) { tools.push(tool); } } as unknown as ExtensionAPI);
    const start = requireTool(tools, "subagent_start").execute;
    assert.ok(start);
    const scoped = testModel("provider", "scoped");
    const plain = { ...testModel("provider", "plain"), reasoning: false };
    const ctx = {
      scopedModels: [{ model: scoped }],
      modelRegistry: { getAvailable: () => [scoped, plain], find: () => plain, hasConfiguredAuth: () => true },
    };
    const pair = { mode: "main", task: "Implement", model: "provider/plain", thinking: "high" };
    await assert.rejects(() => start("outside", pair, undefined, undefined, ctx), /outside the current authenticated session scope/u);
    await assert.rejects(() => start("false", { ...pair, userRequestedModel: false }, undefined, undefined, ctx), /outside the current authenticated session scope/u);
    await assert.rejects(() => start("unsupported", { ...pair, userRequestedModel: true }, undefined, undefined, ctx), /does not support thinking high/u);
    await assert.rejects(() => start("sub", { ...pair, mode: "sub", userRequestedModel: true }, undefined, undefined, ctx), /available only in main mode/u);
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
      const start = requireTool(tools, "subagent_start").execute;
      assert.ok(start);
      for (const overrides of [{ model: "provider/allowed" }, { thinking: "high" }]) {
        await assert.rejects(
          () => start(
            "call-missing-pair", { mode: "sub", task: "Inspect", ...overrides }, undefined, undefined, ctx,
          ),
          /Sub mode requires an explicit model and thinking level/u,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads mode, workspace, terminal host, and cleanup approval from trusted project settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-index-"));
    try {
      const configDirectory = join(root, CONFIG_DIR_NAME);
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "heishi.json"), JSON.stringify({
        mode: "main",
        workspace: "worktree",
        terminalHost: "cmux",
        models: [],
        worktree: { cleanupApproval: "allow" },
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
      assert.match(prompt, /cleanup is currently allowed without confirmation/u);
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

    assert.deepEqual(tools, ["subagent_models", "subagent_start", "subagent_control", "subagent_wait", "subagent_report"]);
    assert.deepEqual(commands, ["heishi", "subagent"]);
  });

  describe("model discovery rendering", () => {
    const tools: RegisteredTool[] = [];
    heishi({
      on() {}, registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI);
    const tool = requireTool(tools, "subagent_models");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const models = [
      { model: "provider/model-a", thinkingLevels: ["off", "low", "high"] },
      { model: "provider/model-b", thinkingLevels: ["low", "high"] },
    ];
    const details = { defaults: { pair: { model: "provider/model-a", thinking: "high" } }, models };
    const context = () => ({
      state: {} as Record<string, unknown>, executionStarted: true, isPartial: false, isError: false,
      invalidate() {},
    });

    it("keeps defaults compact and updates the call header with the scoped count", () => {
      assert.ok(tool.renderCall);
      assert.ok(tool.renderResult);
      const ctx = context();
      const result = { content: [{ type: "text", text: JSON.stringify(details) }], details };
      const before = JSON.stringify(result);
      const header = tool.renderCall({}, theme, ctx);
      assert.equal(header.render(200).join("\n").trimEnd(), "◐ subagent_models · main");
      const rendered = tool.renderResult(result, { expanded: false }, theme, ctx).render(200).join("\n").trimEnd();
      assert.equal(rendered, "  Default: provider/model-a / high");
      assert.equal(header.render(200).join("\n").trimEnd(), "◐ subagent_models · main · 2 scoped models");
      assert.equal(JSON.stringify(result), before);
    });

    it("expands stacked model rows and wraps long names in narrow terminals", () => {
      assert.ok(tool.renderResult);
      const result = { content: [], details };
      const component = tool.renderResult(result, { expanded: true }, theme, context());
      assert.equal(component.render(200).map((line) => line.trimEnd()).join("\n"), [
        "  Default: provider/model-a / high", "",
        "  provider/model-a", "    Thinking: off, low, high",
        "  provider/model-b", "    Thinking: low, high",
      ].join("\n"));
      const longName = "provider/a-model-name-that-exceeds-the-terminal-width";
      const narrow = tool.renderResult({ content: [], details: {
        ...details, models: [{ model: longName, thinkingLevels: ["high"] }],
      } }, { expanded: true }, theme, context()).render(24);
      assert.ok(narrow.every((line) => line.length <= 24));
      assert.ok(narrow.map((line) => line.trim()).join("").includes(longName));
    });

    it("shows requested levels while collapsed and marks only out-of-scope requests", () => {
      assert.ok(tool.renderCall);
      assert.ok(tool.renderResult);
      for (const model of ["provider/model-a", "provider/outside"]) {
        const ctx = context();
        const requested = { model, thinkingLevels: ["low", "high"] };
        const rendered = tool.renderResult({ content: [], details: {
          ...details, userRequestedModel: requested,
        } }, { expanded: false }, theme, ctx).render(200).join("\n");
        assert.ok(rendered.includes(`Requested: ${model}`));
        assert.match(rendered, /Thinking: low, high/u);
        assert.equal(rendered.includes("outside session scope"), model === "provider/outside");
        const header = tool.renderCall({ userRequestedModel: model }, theme, ctx).render(200).join("\n");
        assert.ok(header.includes(`requested ${model}`));
        assert.match(header, /2 scoped models/u);
      }
    });

    it("keeps default warnings visible with empty scope or valid model choices", () => {
      assert.ok(tool.renderCall);
      assert.ok(tool.renderResult);
      const styledTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
      for (const choices of [[], models.slice(0, 1)]) {
        const ctx = context();
        const result = { content: [], details: { defaults: { error: "Saved default is unavailable" }, models: choices } };
        const collapsed = tool.renderResult(result, { expanded: false }, styledTheme, ctx).render(200).join("\n");
        assert.match(collapsed, /<warning>Default unavailable: Saved default is unavailable<\/warning>/u);
        const header = tool.renderCall({}, theme, ctx).render(200).join("\n").trimEnd();
        assert.ok(header.endsWith(choices.length === 0 ? "0 scoped models" : "1 scoped model"));
        const expanded = tool.renderResult(result, { expanded: true }, theme, ctx).render(200).join("\n");
        assert.equal(expanded.includes("provider/model-a"), choices.length > 0);
      }
    });

    it("renders lookup failures in error color and preserves text-only fallback results", () => {
      assert.ok(tool.renderResult);
      const result = { content: [{ type: "text", text: "User-requested main model is not authenticated: provider/missing" }] };
      const styledTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
      const failed = tool.renderResult(result, { expanded: false }, styledTheme, { ...context(), isError: true }).render(200).join("\n");
      assert.match(failed, /<error>User-requested main model is not authenticated: provider\/missing<\/error>/u);
      const fallback = tool.renderResult(result, { expanded: false }, theme, context()).render(200).join("\n").trimEnd();
      assert.equal(fallback, result.content[0]?.text);
    });
  });

  it("renders the live subagent duration after the waiting status", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    } as unknown as ExtensionAPI;
    heishi(pi);

    const renderCall = requireTool(tools, "subagent_wait").renderCall;
    assert.ok(renderCall);
    const interval = setInterval(() => {}, 60_000);
    const state: Record<string, unknown> = { startedAtMs: 0, endedAtMs: 83_000, interval };
    const rendered = renderCall({
      runId: "12345678-1234-1234-1234-123456789abc",
    }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }, {
      state,
      executionStarted: true,
      isPartial: false,
      isError: false,
      invalidate() {},
    }).render(80)[0] ?? "";

    assert.equal(
      rendered,
      "◐ subagent_wait · 123456 · waiting for agent_settled · 1m 23s",
    );
    assert.equal("interval" in state, false);
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
    }, { state: {} }).render(200).join("\n").trimEnd();

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

  it("renders worktree path, branch, base commit, and state", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
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
