import { join } from "node:path";
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
import { RunCoordinator } from "./coordinator.js";
import { IpcHub } from "./ipc.js";
import {
  allowedPairs,
  availableModelChoices,
  loadConfig,
  loadEffectiveConfig,
  saveConfig,
  validateMainOverrides,
  type DelegationConfig,
  type DelegationPair,
} from "./model-config.js";
import { pickDelegationPairs } from "./model-picker.js";
import { showSubagentOverlay } from "./overlay.js";
import {
  MODE_ENTRY_TYPE,
  reconcileRuns,
  restoreRunSnapshots,
  restoreSessionMode,
  RUN_ENTRY_TYPE,
} from "./registry.js";
import { reportMarkdown, runIdentity, shortRunId } from "./rendering.js";
import { THINKING_LEVELS, Tmux } from "./tmux.js";
import type { ControlInput, RunResult, StartInput, WaitResult, WorkerMode } from "./types.js";
import { registerWorkerBridge, resolveWorkerMode } from "./worker.js";

const ThinkingSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  { description: "Optional thinking level. Required for sub mode and when main mode chooses from the Heishi delegation pool; an explicitly user-requested main model may omit it" },
);

const MAIN_MODEL_GUIDELINES = [
  "In main mode, use any authenticated model explicitly requested by the user, even when it is outside the Heishi delegation pool.",
  "When the user does not specify a main-mode model, deliberately choose and pass the exact model/thinking pair from the Heishi delegation pool that best fits the task; do not select randomly or rely on Pi's default model.",
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
  const ipc = new IpcHub();
  const extensionPath = fileURLToPath(import.meta.url);
  let coordinator: RunCoordinator | undefined;
  let delegationConfig: DelegationConfig = { models: [] };
  let delegationConfigError: string | undefined;
  let defaultMode: WorkerMode = "sub";

  const createCoordinator = (ctx: ExtensionContext): RunCoordinator => new RunCoordinator({
    cwd: ctx.cwd,
    extensionPath,
    piPath: "pi",
    tmux,
    ipc,
    persist: (record) => pi.appendEntry(RUN_ENTRY_TYPE, record),
    projectTrusted: ctx.isProjectTrusted(),
  });

  const requireCoordinator = (): RunCoordinator => {
    if (!coordinator) throw new Error("Subagent coordinator is not initialized");
    return coordinator;
  };

  pi.on("session_start", async (event, ctx) => {
    if (coordinator) await coordinator.shutdown();
    coordinator = createCoordinator(ctx);
    const startsNewSession = event.reason === "new" || event.reason === "fork";
    defaultMode = startsNewSession ? "sub" : restoreSessionMode(ctx.sessionManager.getBranch()) ?? "sub";
    if (startsNewSession) pi.appendEntry(MODE_ENTRY_TYPE, { mode: "sub" });
    const loaded = await loadEffectiveConfig(
      join(getAgentDir(), "heishi.json"),
      join(ctx.cwd, CONFIG_DIR_NAME, "heishi.json"),
      ctx.isProjectTrusted(),
    );
    delegationConfig = loaded.config;
    delegationConfigError = loaded.error;
    if (loaded.error) ctx.ui.notify(loaded.error, "warning");

    const restored = restoreRunSnapshots(ctx.sessionManager.getBranch());
    const reconciled = await reconcileRuns(restored, tmux);
    coordinator.restore(reconciled);
    for (const run of reconciled) {
      const previous = restored.find((candidate) => candidate.runId === run.runId);
      if (previous && (previous.status !== run.status || previous.paneState !== run.paneState)) {
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
    description: "Start an asynchronous persistent worker in sub or main mode. Sub requires an allowed model/thinking pair; main uses an explicitly user-requested authenticated model or a deliberately selected pair from the Heishi delegation pool.",
    promptSnippet: "Start persistent interactive tmux subagents for delegated work",
    promptGuidelines: [
      "Use `subagent_start` for delegated multi-step work that benefits from a persistent interactive tmux session or live steering.",
      ...DELEGATION_BRIEF_GUIDELINES,
      "The optional `mode` parameter overrides the current Heishi session default for that run.",
      ...TASK_MODE_GUIDELINES,
      "Sub mode uses the constrained, fast resource profile and requires an explicit model/thinking pair from the Heishi delegation pool.",
      "Main mode loads normal Pi extensions, skills, tools, and prompt templates.",
      ...MAIN_MODEL_GUIDELINES,
      "The `placement` parameter is optional. Omit it unless the user explicitly requests a placement; omission defaults to `session` in sub mode and `window` in main mode.",
      "For multiple independent delegated tasks, emit multiple `subagent_start` tool calls in the same turn; they run concurrently. Use separate calls rather than combining unrelated work into one task.",
      "Concurrent `subagent_start` runs share the checkout and may write at the same time; assign non-overlapping work or use separate worktrees to avoid conflicting edits.",
      "After every successful `subagent_start`, use `subagent_control` first only when live interaction is needed, then use `subagent_wait` for every started run; otherwise use `subagent_wait` immediately. Do not inspect, implement, or answer the user until all waits return.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union(
        [Type.Literal("sub"), Type.Literal("main")],
        { description: "Optional worker mode. Pass sub for read-only work or main for repository writes; omission uses the current session default" },
      )),
      task: Type.String({ description: "Self-contained delegated brief with objective, background and decisions, scope and exclusions, relevant paths or symbols, constraints and assumptions, expected deliverable, and verification; the worker receives no parent conversation" }),
      alias: Type.Optional(Type.String({ description: "Optional display alias; if omitted, a Greek mythological name is chosen" })),
      model: Type.Optional(Type.String({ description: "Model in provider/model form. Required in sub mode. In main mode, use an explicitly user-requested authenticated model or choose a model/thinking pair from the Heishi delegation pool" })),
      thinking: Type.Optional(ThinkingSchema),
      placement: Type.Optional(Type.Union(
        [Type.Literal("pane"), Type.Literal("window"), Type.Literal("session")],
        { description: "Optional worker placement. Omit unless the user explicitly requests one; omission defaults to session in sub mode and window in main mode" },
      )),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mode = params.mode ?? defaultMode;
      if (mode === "sub") {
        const pairs = effectivePairs(ctx);
        if (pairs.length === 0) {
          throw new Error(delegationConfigError ?? "Heishi delegation models are not configured; use /heishi model");
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
      container.addChild(new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_start"))}  ${theme.fg("accent", alias)}${theme.fg("dim", `${mode} · ${args.model ?? "…"} / ${args.thinking ?? "…"}`)}`,
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
    description: "Prompt, steer, follow up, abort, or resume a persistent subagent by its authoritative run UUID.",
    promptSnippet: "Prompt, steer, follow up, abort, or resume a tmux subagent run",
    promptGuidelines: [
      "Use `subagent_control` with the full authoritative run UUID returned by `subagent_start`; aliases are display-only.",
      "Include `message` when using `subagent_control` actions `prompt`, `steer`, or `follow_up`.",
      "Use `subagent_control` action `steer` during active work, `follow_up` to queue work after the current turn, and `prompt` to start new work while idle.",
      "After `subagent_wait` returns, the worker is settled and auto-closed. Use `subagent_control` with `resume` before assigning new work with `prompt` or `follow_up`.",
      "Use `steer` only while a subagent is actively running and connected; do not use `steer` after `subagent_wait`. Resume it and use `prompt` or `follow_up` instead.",
      "After `prompt`, `follow_up`, or `steer`, use `subagent_wait` before the main agent inspects, implements, or answers with the delegated result.",
      "Do not assign write work to a sub-mode run through `prompt`, `follow_up`, or `steer`; start a main-mode run instead.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "Full authoritative run UUID returned by subagent_start" }),
      action: Type.Union([
        Type.Literal("prompt"),
        Type.Literal("steer"),
        Type.Literal("follow_up"),
        Type.Literal("abort"),
        Type.Literal("resume"),
      ], { description: "Control action to perform on the subagent run" }),
      message: Type.Optional(Type.String({ description: "Required for prompt, steer, and follow_up; omitted for abort and resume" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input: ControlInput = { runId: params.runId, action: params.action };
      if (params.message !== undefined) input.message = params.message;
      if (params.action === "prompt" || params.action === "follow_up" || params.action === "resume") {
        const run = requireCoordinator().list().find((candidate) => candidate.runId === params.runId);
        if (run?.mode === "sub" && !effectivePairs(ctx).some((pair) => pair.model === run.model && pair.thinking === run.thinking)) {
          throw new Error(`Subagent model/thinking pair is no longer allowed: ${run.model} / ${run.thinking}`);
        }
      }
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

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait until a subagent's current delegated work reaches agent_settled, then return its structured report, verified session metadata, and run duration.",
    promptSnippet: "Wait for a tmux subagent to settle and return its structured report",
    promptGuidelines: [
      "Use `subagent_wait` with the full run UUID after every successful `subagent_start` and after `subagent_control` starts or changes work; waiting is mandatory before the main agent inspects, implements, or answers with the delegated result.",
      "Treat the result of `subagent_wait`, which waits for `agent_settled`, as completion; do not infer completion from tmux pane output or `agent_end`.",
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
      `The current Heishi default mode is \`${defaultMode}\`.`,
      "Omitting subagent_start.mode uses this default. An explicit mode overrides it for that run.",
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
    return { systemPrompt: `${event.systemPrompt}\n\n${modeGuidance}\n${taskModeGuidance}\n${delegationBriefGuidance}\n${mainModelGuidance}\n${poolGuidance}` };
  });

  pi.registerCommand("heishi", {
    description: "Configure Heishi",
    getArgumentCompletions: heishiArgumentCompletions,
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "mode" || command === "mode sub" || command === "mode main") {
        const requested = command === "mode" ? (defaultMode === "sub" ? "main" : "sub") : command.slice(5) as WorkerMode;
        if (requested !== defaultMode) {
          defaultMode = requested;
          pi.appendEntry(MODE_ENTRY_TYPE, { mode: defaultMode });
        }
        ctx.ui.notify(`Heishi default mode: ${defaultMode}`, "info");
        return;
      }
      if (command !== "model") {
        ctx.ui.notify("Usage: /heishi model | /heishi mode [sub|main]", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/heishi model requires the interactive TUI", "warning");
        return;
      }

      await ctx.modelRegistry.refresh();
      const scopes = ctx.isProjectTrusted() ? ["Global", "Current project"] : ["Global"];
      const scope = await ctx.ui.select("Save Heishi delegation models to", scopes);
      if (!scope) return;

      const globalPath = join(getAgentDir(), "heishi.json");
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "heishi.json");
      const path = scope === "Current project" ? projectPath : globalPath;
      let initial = await loadConfig(path);
      if (scope === "Current project" && !initial.exists) initial = await loadConfig(globalPath);
      if (initial.error) ctx.ui.notify(initial.error, "warning");

      const choices = availableModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels);
      if (choices.length === 0) {
        ctx.ui.notify("No authenticated models are available", "warning");
        return;
      }
      const selected = await pickDelegationPairs(ctx, choices, initial.config.models);
      if (!selected) return;

      await saveConfig(path, { models: selected });
      const loaded = await loadEffectiveConfig(globalPath, projectPath, ctx.isProjectTrusted());
      delegationConfig = loaded.config;
      delegationConfigError = loaded.error;
      ctx.ui.notify(`Saved ${selected.length} Heishi delegation pair${selected.length === 1 ? "" : "s"} to ${path}`, "info");
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
      delegationConfig,
      availableModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels),
    );
  }
}

function heishiArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  if (prefix.startsWith("mode ")) {
    const nestedPrefix = prefix.slice("mode ".length);
    const items = [
      { value: "mode sub", label: "sub" },
      { value: "mode main", label: "main" },
    ].filter((item) => item.label.startsWith(nestedPrefix));
    return items.length > 0 ? items : null;
  }
  if (prefix.includes(" ")) return null;
  const items = [
    { value: "model", label: "model" },
    { value: "mode", label: "mode" },
  ].filter((item) => item.value.startsWith(prefix));
  return items.length > 0 ? items : null;
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
  const location = [
    result.tmuxTarget ? `pane id ${result.tmuxTarget}` : undefined,
    result.tmuxWindowId ? `window id ${result.tmuxWindowId}` : undefined,
    result.tmuxSessionId ? `session id ${result.tmuxSessionId}` : undefined,
  ].filter(Boolean).join(" · ");
  const metadata = location ? ` · ${location}` : "";
  const error = result.error ? `\n  ${theme.fg("error", result.error)}` : "";
  return `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(runIdentity(result)))}  ${theme.fg(color, result.status)}${theme.fg("dim", metadata)}${error}`;
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
