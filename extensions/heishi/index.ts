import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WorktreeCleanupApproval } from "./cleanup.js";
import { Cmux } from "./cmux.js";
import { RunCoordinator } from "./coordinator.js";
import { IpcHub } from "./ipc.js";
import {
  allowedPairs,
  availableModelChoices,
  loadEffectiveConfig,
  modelReference,
  validateMainOverrides,
  type DelegationPair,
  type EffectiveHeishiConfig,
} from "./model-config.js";
import { showSubagentOverlay } from "./overlay.js";
import {
  reconcileRuns,
  restoreRunSnapshots,
  RUN_ENTRY_TYPE,
} from "./registry.js";
import { reportMarkdown, runIdentity, shortRunId } from "./rendering.js";
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
  { description: "Optional thinking level. Required for sub mode. In main mode, prioritize an explicit user request, then the parent session's exact level, and use a delegation-pool level only as the final fallback" },
);

const MAIN_MODEL_GUIDELINES = [
  "In main mode, first use any authenticated model or thinking level explicitly requested by the user, even when the model is outside the Heishi delegation pool.",
  "When the user does not explicitly request a main-mode model or thinking level, use the parent session's exact active model and thinking level.",
  "Use the Heishi delegation pool only as the final fallback when the parent session's exact model/thinking pair is unavailable; deliberately choose and pass the exact pool pair that best fits the task.",
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
  const hosts = new TerminalHostResolver([new TmuxHost(tmux), new Cmux()]);
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

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start an asynchronous persistent worker in sub or main mode. Sub requires an allowed model/thinking pair; main prioritizes a user-requested pair, then the parent session's exact pair, and finally a delegation-pool pair. Main may use an isolated Git worktree workspace.",
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
      model: Type.Optional(Type.String({ description: "Model in provider/model form. Required in sub mode. In main mode, prioritize an explicit user request, then the parent session's exact model, and use the delegation pool only as the final fallback" })),
      thinking: Type.Optional(ThinkingSchema),
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
        validateMainOverrides(params.model, params.thinking, ctx.modelRegistry.getAvailable());
      }

      const input: StartInput = {
        mode,
        workspace,
        task: params.task,
      };
      if (params.model !== undefined) input.model = params.model;
      if (params.thinking !== undefined) input.thinking = params.thinking;
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
      container.addChild(new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_start"))}  ${theme.fg("accent", alias)}${theme.fg("dim", `${mode}${workspace} · ${args.model ?? "…"} / ${args.thinking ?? "…"}`)}`,
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
    renderCall(args, theme) {
      const runId = typeof args.runId === "string" ? shortRunId(args.runId) : "…";
      return new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_wait"))}${theme.fg("dim", ` · ${runId} · waiting for agent_settled`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WaitResult | undefined;
      if (!details) return fallbackResult(result);
      const container = new Container();
      container.addChild(new Text(runStatusHeader(details, theme), 0, 0));
      if (details.report) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(reportMarkdown(details.report), 0, 0, getMarkdownTheme()));
      }
      const seconds = Math.max(0, Math.floor(details.durationMs / 1000));
      const minutes = Math.floor(seconds / 60);
      const duration = seconds < 60
        ? `${seconds}s`
        : minutes < 60
          ? `${minutes}m ${seconds % 60}s`
          : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Duration: ${duration}`), 0, 0));
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
      "Auto mode detects tmux or cmux for each new start and resume. Active workers keep their recorded host.",
    ].join("\n");
    const poolGuidance = pairs.length === 0
      ? "The Heishi delegation pool is empty, so sub mode is disabled. Main mode remains available when the user explicitly requests an authenticated model."
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
    const sessionModelGuidance = ctx.model && ctx.thinkingLevel
      ? `The parent session's exact active model/thinking pair is ${modelReference(ctx.model)} / ${ctx.thinkingLevel}.`
      : "The parent session's exact active model/thinking pair is unavailable; use the Heishi delegation pool as the final fallback for main mode.";
    return { systemPrompt: `${event.systemPrompt}\n\n${modeGuidance}\n${taskModeGuidance}\n${delegationBriefGuidance}\n${mainModelGuidance}\n${sessionModelGuidance}\n${cleanupGuidance}\n${poolGuidance}` };
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
  return new Text(runStatusHeader(details, theme), 0, 0);
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
      : "";
  const worktree = result.workspace === "worktree"
    ? `\n  ${theme.fg("dim", result.worktree
        ? `Worktree: ${result.worktree.path} · ${result.worktree.branch} · base ${result.worktree.baseCommit} · ${result.worktree.state}`
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
