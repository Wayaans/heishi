import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WorktreeCleanupApproval } from "./cleanup.js";
import { Cmux } from "./cmux.js";
import { RunCoordinator } from "./coordinator.js";
import { HeadlessHost } from "./headless.js";
import { IpcHub } from "./ipc.js";
import {
  allowedPairs,
  availableModelChoices,
  loadEffectiveConfig,
  mainModelChoices,
  modelReference,
  savedMainDefaults,
  userRequestedModelChoice,
  validateMainSelection,
  type DelegationPair,
  type EffectiveHeishiConfig,
} from "./model-config.js";
import { showSubagentOverlay } from "./overlay.js";
import {
  reconcileRuns,
  restoreRunSnapshots,
  RUN_ENTRY_TYPE,
} from "./registry.js";
import {
  displayWorktreePath,
  formatDuration,
  reportMarkdown,
  runIdentity,
  shortRunId,
} from "./rendering.js";
import { TerminalHostResolver } from "./terminal-host-resolver.js";
import { THINKING_LEVELS } from "./terminal-host.js";
import { Tmux, TmuxHost } from "./tmux.js";
import { showHeishiSettings } from "./settings.js";
import type { ControlInput, RunResult, StartInput, WaitResult } from "./types.js";
import { registerWorkerBridge, resolveWorkerMode } from "./worker.js";
import { GitWorktrees } from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";

const ThinkingSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  { description: "Required explicit thinking level. Main: use discovered saved defaults as the baseline, allow task-suited choices, and honor an explicit user request independently of model. Sub: use an allowed model/thinking pair" },
);

const ModelsParams = Type.Object({
  userRequestedModel: Type.Optional(Type.String({ description: "Exact provider/model reference explicitly requested by the user; permits targeted inspection outside scope, not broad catalogue browsing" })),
});

interface ModelsDetails {
  defaults: ReturnType<typeof savedMainDefaults>;
  models: Array<{ model: string; thinkingLevels: Array<typeof THINKING_LEVELS[number]> }>;
  userRequestedModel?: ModelsDetails["models"][number];
}

const MAIN_MODEL_GUIDELINES = [
  "Before main-mode `subagent_start`, call `subagent_models` to discover current-session scoped models, supported thinking levels, and saved worker defaults. Pass both `model` and `thinking` explicitly in every mode.",
  "Use the saved worker model/thinking pair as the main-mode baseline; you may choose scoped models and supported thinking levels suited to the task. Explicit user requests take priority independently for each field. Reject invalid or unsupported user pairs instead of substituting another pair.",
  "Set `subagent_start.userRequestedModel` to true only when the user explicitly requested that model. This declaration allows an authenticated model outside the current session scope, including when scope is empty. Use `subagent_models.userRequestedModel` for targeted discovery of that exact provider/model reference. This is an agent declaration, not proof of user authorization.",
  "Do not inherit the parent session's active model or thinking level, or use the Heishi delegation pool as a fallback for main mode.",
] as const;

const TASK_MODE_GUIDELINES = [
  "Before every `subagent_start`, classify the task by its intended repository side effects, then pass `mode` explicitly.",
  "Use `sub` mode for read-only work: exploring, researching, analyzing, auditing, reviewing, or returning a report without creating, editing, or deleting repository files.",
  "For a read-only task, explicitly tell the worker not to modify files and to return findings in its final report.",
  "Use `main` mode for write work: implementing, fixing, refactoring, or creating, editing, deleting, formatting, or generating repository files, including documentation and tests.",
  "For mixed investigation and write work, prefer a sub-mode investigation followed by a main-mode implementation. If the work cannot be split, use main mode.",
] as const;

const DELEGATION_BRIEF_GUIDELINES = [
  "A `subagent_start` worker starts in a fresh session and receives none of the parent conversation, prior tool results, assumptions, decisions, or user messages.",
  "Before composing `subagent_start.task`, load and follow the `writing-for-agents` skill when it is available. If it is unavailable, continue without it.",
  "Every `subagent_start.task` must be self-contained: include the objective, relevant background and decisions, exact scope and exclusions, important file paths or symbols, constraints and assumptions, expected deliverable, and required verification.",
  "Never write a `subagent_start.task` that relies on references such as ‘as discussed above’, ‘continue this’, or ‘inspect the issue’ without reproducing the necessary context.",
] as const;

export default function heishi(pi: ExtensionAPI): void {
  const workerMode = process.env["HEISHI_WORKER"] === "1"
    ? resolveWorkerMode(process.env)
    : undefined;
  if (workerMode === "sub") {
    registerWorkerBridge(pi);
    return;
  }

  const tmux = new Tmux();
  const hosts = new TerminalHostResolver([new TmuxHost(tmux), new Cmux(), new HeadlessHost()]);
  const ipc = new IpcHub();
  const worktrees = new GitWorktrees(getAgentDir());
  const worktreeCleanup = new WorktreeCleanupApproval();
  const extensionPath = fileURLToPath(import.meta.url);
  let coordinator: RunCoordinator | undefined;
  let config: EffectiveHeishiConfig = {
    mode: "sub",
    workspace: "shared",
    terminalHost: "auto",
    models: [],
    cleanupApproval: "ask",
  };
  let configError: string | undefined;

  const createCoordinator = (ctx: ExtensionContext): RunCoordinator => new RunCoordinator({
    cwd: ctx.cwd,
    extensionPath,
    piPath: currentPiInvocation(),
    hosts,
    hostPreference: () => config.terminalHost,
    ipc,
    worktrees,
    persist: (record) => pi.appendEntry(RUN_ENTRY_TYPE, record),
    projectTrusted: ctx.isProjectTrusted(),
  });

  const requireCoordinator = (): RunCoordinator => {
    if (!coordinator) throw new Error("Subagent coordinator is not initialized");
    return coordinator;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (coordinator) await coordinator.shutdown();
    coordinator = createCoordinator(ctx);
    const loaded = await loadEffectiveConfig(
      join(getAgentDir(), "heishi.json"),
      join(ctx.cwd, CONFIG_DIR_NAME, "heishi.json"),
      ctx.isProjectTrusted(),
    );
    config = loaded.config;
    configError = loaded.error;
    if (loaded.error) ctx.ui.notify(loaded.error, "warning");

    const restored = restoreRunSnapshots(ctx.sessionManager.getBranch());
    const reconciled = await reconcileRuns(restored, hosts);
    coordinator.restore(reconciled);
    for (const run of reconciled) {
      const previous = restored.find((candidate) => candidate.runId === run.runId);
      if (previous && previous !== run) {
        pi.appendEntry(RUN_ENTRY_TYPE, run);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await coordinator?.shutdown();
    coordinator = undefined;
  });

  pi.registerTool<typeof ModelsParams, ModelsDetails>({
    name: "subagent_models",
    label: "Discover Subagent Models",
    description: "List only current-session scoped main models and supported thinking levels, with saved worker defaults or a default-resolution error. Optionally inspect one explicit user-requested authenticated model outside scope. Output is limited to 50 KB or 2000 lines.",
    promptSnippet: "Discover scoped main-agent model choices and saved worker defaults",
    parameters: ModelsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const choices = mainModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels);
      const requested = params.userRequestedModel === undefined
        ? undefined
        : userRequestedModelChoice(params.userRequestedModel, ctx.modelRegistry);
      const details = {
        defaults: savedMainDefaults(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), choices),
        models: choices.map(({ model, levels }) => ({ model: modelReference(model), thinkingLevels: levels })),
        ...(requested ? { userRequestedModel: { model: modelReference(requested.model), thinkingLevels: requested.levels } } : {}),
      };
      const output = truncateHead(JSON.stringify(details, null, 2));
      return {
        content: [{ type: "text", text: output.content + (output.truncated ? "\n[Scoped model output truncated]" : "") }],
        details,
      };
    },
    renderCall(args, theme, context) {
      return {
        render(width) {
          const count = context.state["scopedModelCount"];
          const scoped = typeof count === "number" ? ` · ${count} scoped model${count === 1 ? "" : "s"}` : "";
          const requested = args.userRequestedModel ? ` · requested ${args.userRequestedModel}` : "";
          return new Text(
            `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_models"))}${theme.fg("dim", ` · main${scoped}${requested}`)}`,
            0,
            0,
          ).render(width);
        },
        invalidate() {},
      };
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        return new Text(theme.fg("error", text), 0, 0);
      }
      const details = result.details;
      if (!details) return fallbackResult(result);
      context.state["scopedModelCount"] = details.models.length;
      const defaults = details.defaults;
      let text = "pair" in defaults
        ? `  ${theme.fg("muted", "Default:")} ${theme.fg("accent", `${defaults.pair.model} / ${defaults.pair.thinking}`)}`
        : `  ${theme.fg("warning", `Default unavailable: ${defaults.error}`)}`;
      const requested = details.userRequestedModel;
      if (requested) {
        const outside = details.models.some(({ model }) => model === requested.model) ? "" : " · outside session scope";
        text += `\n  ${theme.fg("muted", "Requested:")} ${theme.fg("accent", requested.model)}${theme.fg("dim", outside)}`;
        text += `\n    ${theme.fg("dim", `Thinking: ${requested.thinkingLevels.join(", ")}`)}`;
      }
      if (expanded && details.models.length > 0) {
        text += "\n";
        for (const choice of details.models) {
          text += `\n  ${theme.fg("accent", choice.model)}\n    ${theme.fg("dim", `Thinking: ${choice.thinkingLevels.join(", ")}`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start an asynchronous persistent worker with an explicit model/thinking pair. Sub requires an allowed delegation pair. Main uses scoped choices from subagent_models, with an authenticated out-of-scope exception only for declared user-requested models. Main may use an isolated Git worktree workspace.",
    promptSnippet: "Start persistent interactive subagents in a managed terminal host",
    promptGuidelines: [
      "Use `subagent_start` for delegated multi-step work that benefits from a persistent interactive terminal session or live steering.",
      ...DELEGATION_BRIEF_GUIDELINES,
      "The optional `mode` parameter overrides the effective Heishi configuration for that run.",
      ...TASK_MODE_GUIDELINES,
      "Sub mode uses the constrained, fast resource profile and requires an explicit model/thinking pair from the Heishi delegation pool.",
      "Main mode loads normal Pi extensions, skills, tools, and prompt templates.",
      ...MAIN_MODEL_GUIDELINES,
      "The `placement` parameter is optional. Omit it unless the user explicitly requests a placement; omission defaults to `session` in sub mode and `window` in main mode.",
      "In cmux, both `window` and `session` open a surface tab in the caller pane. In tmux, the existing window and named-session mappings remain unchanged.",
      "The optional `workspace` parameter is independent of terminal placement. Main mode uses the effective Heishi workspace when it is omitted; sub mode always uses the shared checkout. An explicit `worktree` is valid only in main mode and isolates repository writes on a retained branch.",
      "For multiple independent delegated tasks, emit multiple `subagent_start` tool calls in the same turn; they run concurrently. Use separate calls rather than combining unrelated work into one task.",
      "Concurrent shared-workspace writers must edit non-overlapping files. Use main-mode worktree workspaces when writers need isolated checkouts.",
      "After every successful `subagent_start`, use `subagent_control` first only when live interaction is needed, then use `subagent_wait` for every started run; otherwise use `subagent_wait` immediately. Do not inspect, implement, or answer the user until all waits return.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union(
        [Type.Literal("sub"), Type.Literal("main")],
        { description: "Optional worker mode. Pass sub for read-only work or main for repository writes; omission uses the effective Heishi configuration" },
      )),
      task: Type.String({ description: "Self-contained delegated brief with objective, background and decisions, scope and exclusions, relevant paths or symbols, constraints and assumptions, expected deliverable, and verification; the worker receives no parent conversation" }),
      alias: Type.Optional(Type.String({ description: "Optional display alias; if omitted, a Greek mythological name is chosen" })),
      model: Type.String({ description: "Required exact provider/model reference. Main: choose from subagent_models using saved defaults as baseline unless the task or an explicit user request calls for another model. Sub: use the delegation pool" }),
      thinking: ThinkingSchema,
      userRequestedModel: Type.Optional(Type.Boolean({ description: "Main only. Set true only for an explicit user model request to allow an authenticated model outside current session scope. Agent declaration, not proof of authorization; unsupported thinking still errors" })),
      placement: Type.Optional(Type.Union(
        [Type.Literal("pane"), Type.Literal("window"), Type.Literal("session")],
        { description: "Optional worker placement. Omit unless the user explicitly requests one; omission defaults to session in sub mode and window in main mode" },
      )),
      workspace: Type.Optional(Type.Union(
        [Type.Literal("shared"), Type.Literal("worktree")],
        { description: "Optional repository workspace. Main mode uses the effective Heishi configuration when omitted; sub mode always uses shared and rejects an explicit worktree" },
      )),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mode = params.mode ?? config.mode;
      const workspace = resolveWorkspace(mode, params.workspace, config.workspace);
      if (mode === "sub") {
        if (params.userRequestedModel !== undefined) throw new Error("userRequestedModel is available only in main mode");
        const pairs = effectivePairs(ctx);
        if (pairs.length === 0) {
          throw new Error(configError ?? "Heishi delegation models are not configured; use /heishi settings");
        }
        if (params.model === undefined || params.thinking === undefined) {
          throw new Error("Sub mode requires an explicit model and thinking level");
        }
        if (!pairs.some((pair) => pair.model === params.model && pair.thinking === params.thinking)) {
          throw new Error(`Subagent model/thinking pair is not allowed: ${params.model} / ${params.thinking}`);
        }
      } else {
        const requested = params.userRequestedModel === true && params.model
          ? userRequestedModelChoice(params.model, ctx.modelRegistry)
          : undefined;
        validateMainSelection(
          params.model, params.thinking,
          mainModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels),
          requested,
        );
      }

      const input: StartInput = {
        mode,
        workspace,
        task: params.task,
        model: params.model,
        thinking: params.thinking,
      };
      if (params.alias !== undefined) input.alias = params.alias;
      if (params.placement !== undefined) input.placement = params.placement;
      return toolResult(await requireCoordinator().start(input, signal));
    },
    renderCall(args, theme) {
      const container = new Container();
      const alias = args.alias?.trim() || "random alias";
      const task = typeof args.task === "string" ? args.task : "";
      const mode = args.mode ? ` · ${args.mode}` : "";
      const workspace = args.workspace ? ` · ${args.workspace}` : "";
      const model = args.model ?? "…";
      container.addChild(new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_start"))}  ${theme.fg("accent", alias)}${theme.fg("dim", `${mode}${workspace} · ${model} / ${args.thinking ?? "…"}`)}`,
        0,
        0,
      ));
      if (task) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(task, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
    renderResult(result, _options, theme) {
      return renderRunResult(result.details as RunResult | undefined, result, theme);
    },
  });

  pi.registerTool({
    name: "subagent_control",
    label: "Control Subagent",
    description: "Prompt, steer, follow up, abort, resume, or clean up a persistent subagent by its authoritative run UUID.",
    promptSnippet: "Prompt, steer, follow up, abort, resume, or clean up a managed subagent run",
    promptGuidelines: [
      "Use `subagent_control` with the full authoritative run UUID returned by `subagent_start`; aliases are display-only.",
      "Include `message` when using `subagent_control` actions `prompt`, `steer`, or `follow_up`.",
      "Use `subagent_control` action `steer` during active work, `follow_up` to queue work after the current turn, and `prompt` to start new work while idle.",
      "After `subagent_wait` returns, the worker is settled and auto-closed. Use `subagent_control` with `resume` before assigning new work with `prompt` or `follow_up`.",
      "Use `steer` only while a subagent is actively running and connected; do not use `steer` after `subagent_wait`. Resume it and use `prompt` or `follow_up` instead.",
      "After `prompt`, `follow_up`, or `steer`, use `subagent_wait` before the main agent inspects, implements, or answers with the delegated result.",
      "Do not assign write work to a sub-mode run through `prompt`, `follow_up`, or `steer`; start a main-mode run instead.",
      "`subagent_control` action `cleanup` follows the configured worktree approval policy. Ask mode queues interactive confirmations that name the run and worktree path; allow mode skips the prompt. Cleanup always refuses modified, untracked, or ignored files, removes only the worktree, and retains its branch.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "Full authoritative run UUID returned by subagent_start" }),
      action: Type.Union([
        Type.Literal("prompt"),
        Type.Literal("steer"),
        Type.Literal("follow_up"),
        Type.Literal("abort"),
        Type.Literal("resume"),
        Type.Literal("cleanup"),
      ], { description: "Control action to perform on the subagent run" }),
      message: Type.Optional(Type.String({ description: "Required for prompt, steer, and follow_up; omitted for abort, resume, and cleanup" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const activeCoordinator = requireCoordinator();
      if (params.action === "cleanup") {
        return controlToolResult(
          await worktreeCleanup.execute(activeCoordinator, params.runId, config.cleanupApproval, ctx, _signal),
          params.action,
        );
      }
      const input: ControlInput = { runId: params.runId, action: params.action };
      if (params.message !== undefined) input.message = params.message;
      if (params.action === "prompt" || params.action === "follow_up" || params.action === "resume") {
        const run = activeCoordinator.list().find((candidate) => candidate.runId === params.runId);
        if (run?.mode === "sub" && !effectivePairs(ctx).some((pair) => pair.model === run.model && pair.thinking === run.thinking)) {
          throw new Error(`Subagent model/thinking pair is no longer allowed: ${run.model} / ${run.thinking}`);
        }
      }
      return controlToolResult(await activeCoordinator.control(input), params.action);
    },
    renderCall(args, theme) {
      const runId = typeof args.runId === "string" ? shortRunId(args.runId) : "…";
      let text = `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_control"))}  ${theme.fg("accent", args.action ?? "…")}${theme.fg("dim", ` · ${runId}`)}`;
      if (args.message?.trim()) text += `\n  ${theme.fg("muted", args.message.trim())}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      return renderControlRunResult(result.details as ControlRunResult | undefined, result, theme);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait until a subagent's current delegated work reaches agent_settled, then return its structured report, verified session metadata, and run duration.",
    promptSnippet: "Wait for a managed subagent to settle and return its structured report",
    promptGuidelines: [
      "Use `subagent_wait` with the full run UUID after every successful `subagent_start` and after `subagent_control` starts or changes work; waiting is mandatory before the main agent inspects, implements, or answers with the delegated result.",
      "Treat the result of `subagent_wait`, which waits for `agent_settled`, as completion; do not infer completion from terminal output or `agent_end`.",
      "When `subagent_wait` returns a blocked report with a structured request, obtain the requested external input in the parent session, resume the worker, send the answer with `subagent_control` action `prompt`, and call `subagent_wait` again.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "Full authoritative run UUID returned by subagent_start" }),
    }),
    async execute(_toolCallId, params, signal) {
      return toolResult(await requireCoordinator().wait(params.runId, signal));
    },
    renderCall(args, theme, context) {
      const fullRunId = typeof args.runId === "string" ? args.runId : undefined;
      const runId = fullRunId ? shortRunId(fullRunId) : "…";
      const state = context.state as WaitRenderState;
      if (context.executionStarted && state.startedAtMs === undefined) {
        const runStartedAt = fullRunId ? runStartedAtMs(coordinator, fullRunId) : undefined;
        state.startedAtMs = runStartedAt ?? Date.now();
      }
      if (context.executionStarted && context.isPartial && state.interval === undefined) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!context.isPartial || context.isError) stopWaitTimer(state);

      const text = `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_wait"))}${theme.fg("dim", ` · ${runId} · waiting for agent_settled`)}`;
      const component = context.lastComponent instanceof WaitCallComponent
        ? context.lastComponent
        : new WaitCallComponent();
      component.update(text, theme, state.startedAtMs ?? Date.now(), state.endedAtMs);
      return component;
    },
    renderResult(result, _options, theme, context) {
      stopWaitTimer(context.state as WaitRenderState);
      const details = result.details as WaitResult | undefined;
      if (!details) return fallbackResult(result);
      const container = new Container();
      container.addChild(new Text(runStatusHeader(details, theme), 0, 0));
      if (details.report) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(reportMarkdown(details.report), 0, 0, getMarkdownTheme()));
      }
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Duration: ${formatDuration(details.durationMs)}`), 0, 0));
      return container;
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const pairs = effectivePairs(ctx);
    const modeGuidance = [
      `The current Heishi default mode is \`${config.mode}\`.`,
      "Omitting subagent_start.mode uses this effective configured value. An explicit mode overrides it for that run.",
      `The current Heishi main-mode workspace default is \`${config.workspace}\`.`,
      "Omitting subagent_start.workspace uses this effective configured value in main mode. Sub mode always uses the shared checkout and rejects an explicit worktree.",
      `The current Heishi terminal host is \`${config.terminalHost}\`.`,
      "Auto mode detects tmux or cmux for each new start and resume, and falls back to a headless background process when neither is available. Active workers keep their recorded host.",
    ].join("\n");
    const poolGuidance = pairs.length === 0
      ? "The Heishi delegation pool is empty, so sub mode is disabled. Main mode uses subagent_models discovery and requires an explicit model/thinking pair; it is independent of this pool."
      : [
          "The Heishi delegation pool contains these exact model/thinking pairs:",
          ...pairs.map((pair) => `- ${pair.model} / ${pair.thinking}`),
          "Sub mode must use one of these pairs. Do not resume or assign new work to an existing sub-mode run whose pair is not listed.",
        ].join("\n");
    const taskModeGuidance = TASK_MODE_GUIDELINES.join("\n");
    const delegationBriefGuidance = DELEGATION_BRIEF_GUIDELINES.join("\n");
    const mainModelGuidance = MAIN_MODEL_GUIDELINES.join("\n");
    const cleanupGuidance = config.cleanupApproval === "ask"
      ? "Worktree cleanup currently requires interactive confirmation."
      : "Worktree cleanup is currently allowed without confirmation, but all worktree safety checks still apply.";
    return { systemPrompt: `${event.systemPrompt}\n\n${modeGuidance}\n${taskModeGuidance}\n${delegationBriefGuidance}\n${mainModelGuidance}\n${cleanupGuidance}\n${poolGuidance}` };
  });

  pi.registerCommand("heishi", {
    description: "Configure Heishi",
    getArgumentCompletions: heishiArgumentCompletions,
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command !== "" && command !== "settings") {
        ctx.ui.notify("Usage: /heishi [settings]", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Heishi settings require the interactive TUI", "warning");
        return;
      }

      const globalPath = join(getAgentDir(), "heishi.json");
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "heishi.json");
      if (await showHeishiSettings(ctx, { global: globalPath, project: projectPath })) {
        const loaded = await loadEffectiveConfig(globalPath, projectPath, ctx.isProjectTrusted());
        config = loaded.config;
        configError = loaded.error;
        if (loaded.error) ctx.ui.notify(loaded.error, "warning");
      }
    },
  });

  pi.registerCommand("subagent", {
    description: "Manage subagents in the current session",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The Subagents overlay is available only in the interactive TUI", "warning");
        return;
      }
      await showSubagentOverlay(requireCoordinator(), ctx);
    },
  });

  if (workerMode === "main") registerWorkerBridge(pi);

  function effectivePairs(ctx: ExtensionContext): DelegationPair[] {
    return allowedPairs(
      config,
      availableModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels),
    );
  }
}

export function currentPiInvocation(
  argv: readonly string[] = process.argv,
  executablePath = process.execPath,
): string[] {
  const currentScript = argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    const absoluteScript = resolve(currentScript);
    if (existsSync(absoluteScript)) return [executablePath, absoluteScript];
  }
  const executable = basename(executablePath).toLowerCase();
  return /^(node|bun)(\.exe)?$/u.test(executable) ? ["pi"] : [executablePath];
}

function heishiArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  return "settings".startsWith(prefix) ? [{ value: "settings", label: "settings" }] : null;
}

interface WaitRenderState {
  startedAtMs?: number;
  endedAtMs?: number;
  interval?: ReturnType<typeof setInterval>;
}

class WaitCallComponent implements Component {
  private text = "";
  private theme: Theme | undefined;
  private startedAtMs = 0;
  private endedAtMs: number | undefined;

  update(text: string, theme: Theme, startedAtMs: number, endedAtMs?: number): void {
    this.text = text;
    this.theme = theme;
    this.startedAtMs = startedAtMs;
    this.endedAtMs = endedAtMs;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const elapsed = formatDuration((this.endedAtMs ?? Date.now()) - this.startedAtMs);
    const duration = this.theme?.fg("dim", ` · ${elapsed}`) ?? ` · ${elapsed}`;
    return [truncateToWidth(`${this.text}${duration}`, width)];
  }

  invalidate(): void {}
}

function runStartedAtMs(coordinator: RunCoordinator | undefined, runId: string): number | undefined {
  const startedAt = coordinator?.list().find((run) => run.runId === runId)?.startedAt;
  if (!startedAt) return undefined;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function stopWaitTimer(state: WaitRenderState): void {
  state.endedAtMs ??= Date.now();
  if (state.interval === undefined) return;
  clearInterval(state.interval);
  delete state.interval;
}

interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
}

interface ControlRunResult extends RunResult {
  action: ControlInput["action"];
}

function fallbackResult(result: RenderableResult): Text {
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  return new Text(text, 0, 0);
}

function renderRunResult(details: RunResult | undefined, result: RenderableResult, theme: Theme): Text {
  if (!details) return fallbackResult(result);
  const startedWith = details.status === "running"
    ? `\n  ${theme.fg("dim", `Started with: ${details.model ?? "…"} / ${details.thinking ?? "…"}`)}`
    : "";
  return new Text(`${runStatusHeader(details, theme)}${startedWith}`, 0, 0);
}

function renderControlRunResult(details: ControlRunResult | undefined, result: RenderableResult, theme: Theme): Text {
  if (!details) return fallbackResult(result);
  const resumedWith = details.action === "resume"
    ? `\n  ${theme.fg("dim", `Resumed with: ${details.model ?? "…"} / ${details.thinking ?? "…"}`)}`
    : "";
  return new Text(`${runStatusHeader(details, theme)}${resumedWith}`, 0, 0);
}

function runStatusHeader(result: RunResult, theme: Theme): string {
  const color = result.status === "completed"
    ? "success"
    : result.status === "failed"
      ? "error"
      : result.status === "blocked" || result.status === "cancelled"
        ? "warning"
        : "accent";
  const icon = result.status === "completed" ? "✓" : result.status === "failed" ? "✕" : result.status === "running" ? "→" : "!";
  const target = result.hostTarget;
  const location = target?.host === "tmux"
    ? `tmux · pane ${target.paneId}${target.windowId ? ` · window ${target.windowId}` : ""}${target.sessionId ? ` · session ${target.sessionId}` : ""}`
    : target?.host === "cmux"
      ? `cmux · ${target.closeKind} ${target.closeKind === "surface" ? target.surfaceId : target.workspaceId}`
      : target?.host === "headless"
        ? `headless · pid ${target.pid}`
        : "";
  const worktree = result.workspace === "worktree"
    ? `\n  ${theme.fg("dim", result.worktree
        ? `Worktree: ${displayWorktreePath(result.worktree.path)} · ${result.worktree.branch} · base ${result.worktree.baseCommit} · ${result.worktree.state}`
        : "Worktree: not prepared")}`
    : "";
  const metadata = location ? ` · ${location}` : "";
  const error = result.error ? `\n  ${theme.fg("error", result.error)}` : "";
  return `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(runIdentity(result)))}  ${theme.fg(color, result.status)}${theme.fg("dim", metadata)}${worktree}${error}`;
}

function toolResult(
  result: RunResult,
): { content: Array<{ type: "text"; text: string }>; details: RunResult } {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function controlToolResult(
  result: RunResult,
  action: ControlInput["action"],
): { content: Array<{ type: "text"; text: string }>; details: ControlRunResult } {
  const details = { ...result, action };
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}
