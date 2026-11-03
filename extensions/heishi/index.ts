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
import {
  Box,
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
  loadEffectiveConfig,
  validateRequestedModel,
  type EffectiveHeishiConfig,
} from "./model-config.js";
import { showSubagentOverlay } from "./overlay.js";
import {
  parseRunCompletion,
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
import type { ControlInput, RunCompletion, RunResult, StartInput } from "./types.js";
import { registerWorkerBridge, resolveWorkerMode } from "./worker.js";
import { GitWorktrees } from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";

const COMPLETION_MESSAGE_TYPE = "heishi:subagent-completion";

const ThinkingSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  { description: "Optional thinking level. Omit unless the user explicitly requests one; omission uses Pi's default" },
);

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
    cleanupApproval: "ask",
  };

  const createCoordinator = (ctx: ExtensionContext): RunCoordinator => new RunCoordinator({
    cwd: ctx.cwd,
    extensionPath,
    piPath: currentPiInvocation(),
    hosts,
    hostPreference: () => config.terminalHost,
    ipc,
    worktrees,
    persist: (record) => pi.appendEntry(RUN_ENTRY_TYPE, record),
    notifyCompletion: (completion) => pi.sendMessage(completionMessage(completion), { deliverAs: "steer", triggerTurn: true }),
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
    // Restored results join the context without starting an unprompted turn.
    for (const completion of coordinator.takePendingCompletions()) {
      pi.sendMessage(completionMessage(completion));
    }
  });

  pi.on("session_shutdown", async () => {
    await coordinator?.shutdown();
    coordinator = undefined;
  });

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start an asynchronous persistent worker. It uses Pi's default model and thinking level unless the user explicitly requests others. Main may use an isolated Git worktree workspace.",
    promptSnippet: "Start persistent interactive subagents in a managed terminal host",
    promptGuidelines: [
      "Use `subagent_start` for delegated multi-step work that benefits from a persistent interactive terminal session or live steering.",
      ...DELEGATION_BRIEF_GUIDELINES,
      "The optional `mode` parameter overrides the effective Heishi configuration for that run.",
      ...TASK_MODE_GUIDELINES,
      "Sub mode uses the constrained, fast resource profile.",
      "Main mode loads normal Pi extensions, skills, tools, and prompt templates.",
      "Omit `model` and `thinking` unless the user explicitly requests them; omitted values use Pi's default model and thinking level.",
      "The optional `workspace` parameter is independent of terminal placement. Main mode uses the effective Heishi workspace when it is omitted; sub mode always uses the shared checkout. An explicit `worktree` is valid only in main mode and isolates repository writes on a retained branch.",
      "For multiple independent delegated tasks, emit multiple `subagent_start` tool calls in the same turn; they run concurrently. Use separate calls rather than combining unrelated work into one task.",
      "Concurrent shared-workspace writers must edit non-overlapping files. Use main-mode worktree workspaces when writers need isolated checkouts.",
      "Workers started by `subagent_start` run in the background. When a worker settles, its result arrives automatically as a Heishi subagent completion message with the run UUID, status, report, and duration. Do not poll for completion with sleep, shell commands, or repeated tool calls.",
      "While workers run, continue only with work that does not depend on their results. Otherwise end your turn and tell the user which workers are running; their completion messages will start a new turn. Do not inspect, implement, or answer with a delegated result before its completion message arrives.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union(
        [Type.Literal("sub"), Type.Literal("main")],
        { description: "Optional worker mode. Pass sub for read-only work or main for repository writes; omission uses the effective Heishi configuration" },
      )),
      task: Type.String({ description: "Self-contained delegated brief with objective, background and decisions, scope and exclusions, relevant paths or symbols, constraints and assumptions, expected deliverable, and verification; the worker receives no parent conversation" }),
      alias: Type.Optional(Type.String({ description: "Optional display alias; if omitted, a Greek mythological name is chosen" })),
      model: Type.Optional(Type.String({ description: "Optional exact provider/model reference. Omit unless the user explicitly requests a model; omission uses Pi's default" })),
      thinking: Type.Optional(ThinkingSchema),
      workspace: Type.Optional(Type.Union(
        [Type.Literal("shared"), Type.Literal("worktree")],
        { description: "Optional repository workspace. Main mode uses the effective Heishi configuration when omitted; sub mode always uses shared and rejects an explicit worktree" },
      )),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mode = params.mode ?? config.mode;
      const workspace = resolveWorkspace(mode, params.workspace, config.workspace);
      validateRequestedModel(params.model, params.thinking, ctx.modelRegistry);

      const input: StartInput = { mode, workspace, task: params.task };
      if (params.model !== undefined) input.model = params.model;
      if (params.thinking !== undefined) input.thinking = params.thinking;
      if (params.alias !== undefined) input.alias = params.alias;
      return toolResult(await requireCoordinator().start(input, signal));
    },
    renderCall(args, theme) {
      const container = new Container();
      const alias = args.alias?.trim() || "random alias";
      const task = typeof args.task === "string" ? args.task : "";
      const mode = args.mode ? ` · ${args.mode}` : "";
      const workspace = args.workspace ? ` · ${args.workspace}` : "";
      const model = args.model !== undefined || args.thinking !== undefined ? ` · ${args.model ?? "default"} / ${args.thinking ?? "default"}` : "";
      container.addChild(new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_start"))}  ${theme.fg("accent", alias)}${theme.fg("dim", `${mode}${workspace}${model}`)}`,
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
    description: "Prompt, steer, or abort a persistent subagent by its authoritative run UUID.",
    promptSnippet: "Prompt, steer, or abort a managed subagent run",
    promptGuidelines: [
      "Use `subagent_control` with the full authoritative run UUID returned by `subagent_start`; aliases are display-only.",
      "Include `message` when using `subagent_control` actions `prompt` or `steer`.",
      "Use `subagent_control` action `prompt` to give a worker new work after its completion message arrives. Heishi resumes the closed worker automatically, and a new completion message arrives when it settles. Do not inspect, implement, or answer with the delegated result before it arrives.",
      "Use `steer` only while a subagent is actively running, to change its current work. After its completion message arrives, use `prompt` instead.",
      "When a completion message reports `blocked` with a structured request, obtain the requested external input in the parent session, then send the answer with `subagent_control` action `prompt`.",
      "Do not assign write work to a sub-mode run through `prompt` or `steer`; start a main-mode run instead.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "Full authoritative run UUID returned by subagent_start" }),
      action: Type.Union([
        Type.Literal("prompt"),
        Type.Literal("steer"),
        Type.Literal("abort"),
      ], { description: "Control action to perform on the subagent run" }),
      message: Type.Optional(Type.String({ description: "Required for prompt and steer; omitted for abort" })),
    }),
    async execute(_toolCallId, params) {
      const input: ControlInput = { runId: params.runId, action: params.action };
      if (params.message !== undefined) input.message = params.message;
      return controlToolResult(await requireCoordinator().control(input), params.action);
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

  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    // Details are restored from session files, so validate them before rendering.
    const completion = parseRunCompletion(message.details);
    return completion ? renderCompletion(completion, expanded, outputPad, theme) : undefined;
  });

  pi.on("before_agent_start", (event) => {
    const modeGuidance = [
      `The current Heishi default mode is \`${config.mode}\`.`,
      "Omitting subagent_start.mode uses this effective configured value. An explicit mode overrides it for that run.",
      `The current Heishi main-mode workspace default is \`${config.workspace}\`.`,
      "Omitting subagent_start.workspace uses this effective configured value in main mode. Sub mode always uses the shared checkout and rejects an explicit worktree.",
      `The current Heishi terminal host is \`${config.terminalHost}\`.`,
      "Auto mode detects tmux or cmux for each new start and resume, and falls back to a headless background process when neither is available. Active workers keep their recorded host.",
    ].join("\n");
    const taskModeGuidance = TASK_MODE_GUIDELINES.join("\n");
    const delegationBriefGuidance = DELEGATION_BRIEF_GUIDELINES.join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${modeGuidance}\n${taskModeGuidance}\n${delegationBriefGuidance}` };
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
      const activeCoordinator = requireCoordinator();
      await showSubagentOverlay(
        activeCoordinator,
        ctx,
        (runId) => worktreeCleanup.execute(activeCoordinator, runId, config.cleanupApproval, ctx),
      );
    },
  });

  if (workerMode === "main") registerWorkerBridge(pi);
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
  const startedWith = details.status === "running"
    ? `\n  ${theme.fg("dim", `Started with: ${details.model ?? "…"} / ${details.thinking ?? "…"}`)}`
    : "";
  return new Text(`${runStatusHeader(details, theme)}${startedWith}`, 0, 0);
}

function renderControlRunResult(details: ControlRunResult | undefined, result: RenderableResult, theme: Theme): Text {
  if (!details) return fallbackResult(result);
  return new Text(runStatusHeader(details, theme), 0, 0);
}

function renderCompletion(completion: RunCompletion, expanded: boolean, outputPad: number, theme: Theme): Box {
  const { color, icon, background } = statusStyle(completion.status);
  const box = new Box(outputPad, 1, (text) => theme.bg(background, text));
  box.addChild(new SingleLine(
    `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(`${completion.alias} · ${shortRunId(completion.runId)}`))}  ${theme.fg(color, completion.status)}${theme.fg("dim", ` · ${formatDuration(completion.durationMs)}`)}`,
  ));
  const location = runLocation(completion);
  const metadata = theme.fg("dim", [
    ...(completion.mode === "main" ? ["main"] : []),
    `${completion.model ?? "default model"} / ${completion.thinking ?? "default thinking"}`,
    ...(completion.worktree ? [worktreeLabel(completion.worktree)] : []),
    ...(location ? [location] : []),
  ].join(" · "));
  if (!expanded) {
    box.addChild(new SingleLine(metadata));
    return box;
  }

  box.addChild(new Text(metadata, 0, 0));
  box.addChild(new Text(theme.fg("dim", `Run: ${completion.runId}`), 0, 0));
  if (completion.error) box.addChild(new Text(theme.fg("error", completion.error), 0, 0));
  if (completion.report) {
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(reportMarkdown(completion.report), 0, 0, getMarkdownTheme()));
  }
  return box;
}

/** Renders one line truncated to the available width, so collapsed completions never wrap. */
class SingleLine implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return width > 0 ? [truncateToWidth(this.text, width)] : [];
  }

  invalidate(): void {}
}

function statusStyle(status: RunResult["status"]): {
  color: "success" | "error" | "warning" | "accent";
  icon: string;
  background: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg";
} {
  if (status === "completed") return { color: "success", icon: "✓", background: "toolSuccessBg" };
  if (status === "failed") return { color: "error", icon: "✕", background: "toolErrorBg" };
  if (status === "blocked" || status === "cancelled") return { color: "warning", icon: "!", background: "toolPendingBg" };
  return { color: "accent", icon: status === "running" ? "→" : "!", background: "toolPendingBg" };
}

function worktreeLabel(worktree: NonNullable<RunResult["worktree"]>): string {
  return `${displayWorktreePath(worktree.path)} · ${worktree.branch}`;
}

function runLocation(result: RunResult): string {
  const target = result.hostTarget;
  if (target?.host === "tmux") {
    return `tmux · pane ${target.paneId}${target.windowId ? ` · window ${target.windowId}` : ""}${target.sessionId ? ` · session ${target.sessionId}` : ""}`;
  }
  if (target?.host === "cmux") return `cmux · ${target.closeKind} ${target.closeKind === "surface" ? target.surfaceId : target.workspaceId}`;
  if (target?.host === "headless") return `headless · pid ${target.pid}`;
  return "";
}

function runStatusHeader(result: RunResult, theme: Theme): string {
  const { color, icon } = statusStyle(result.status);
  const location = runLocation(result);
  const worktree = result.workspace === "worktree"
    ? `\n  ${theme.fg("dim", result.worktree
        ? `Worktree: ${worktreeLabel(result.worktree)} · base ${result.worktree.baseCommit} · ${result.worktree.state}`
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

function completionMessage(completion: RunCompletion) {
  return {
    customType: COMPLETION_MESSAGE_TYPE,
    content: `Heishi subagent ${completion.alias} (${completion.runId}) settled with status ${completion.status}.\n\n${JSON.stringify(completion, null, 2)}`,
    display: true,
    details: completion,
  };
}
