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
  type DelegationConfig,
  type DelegationPair,
} from "./model-config.js";
import { pickDelegationPairs } from "./model-picker.js";
import { showSubagentOverlay } from "./overlay.js";
import { reconcileRuns, restoreRunSnapshots, RUN_ENTRY_TYPE } from "./registry.js";
import { reportMarkdown, runIdentity, shortRunId } from "./rendering.js";
import { Tmux } from "./tmux.js";
import type { ControlInput, RunResult, StartInput } from "./types.js";
import { registerWorkerBridge } from "./worker.js";

const ThinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
], { description: "Explicit thinking level for the subagent; no default or fallback is applied" });

export default function heishi(pi: ExtensionAPI): void {
  if (process.env["HEISHI_WORKER"] === "1") {
    registerWorkerBridge(pi);
    return;
  }

  const tmux = new Tmux();
  const ipc = new IpcHub();
  const extensionPath = fileURLToPath(import.meta.url);
  let coordinator: RunCoordinator | undefined;
  let delegationConfig: DelegationConfig = { models: [] };
  let delegationConfigError: string | undefined;

  const createCoordinator = (ctx: ExtensionContext): RunCoordinator => new RunCoordinator({
    cwd: ctx.cwd,
    extensionPath,
    piPath: "pi",
    tmux,
    ipc,
    persist: (record) => pi.appendEntry(RUN_ENTRY_TYPE, record),
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
    description: "Start an asynchronous persistent subagent in an interactive tmux session. The subagent does not receive the parent conversation, so provide a self-contained task plus an explicit model and thinking level.",
    promptSnippet: "Start persistent interactive tmux subagents for delegated work",
    promptGuidelines: [
      "Use `subagent_start` for delegated multi-step work that benefits from a persistent interactive tmux session or live steering.",
      "Give `subagent_start` a self-contained task because the subagent does not receive the parent conversation.",
      "Always provide `subagent_start` an explicit model in `provider/model` form and an explicit thinking level; there are no defaults or silent fallbacks.",
      "Choose the `subagent_start` model and thinking level only from the Heishi delegation pool included in the system prompt.",
      "For multiple independent delegated tasks, emit multiple `subagent_start` tool calls in the same turn; they run concurrently. Use separate calls rather than combining unrelated work into one task.",
      "Concurrent `subagent_start` runs share the checkout and may write at the same time; assign non-overlapping work or use separate worktrees to avoid conflicting edits.",
      "After `subagent_start` returns, use `subagent_control` for live interaction and `subagent_wait` for the settled structured report.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained delegated task, including all context the subagent needs from the parent conversation" }),
      alias: Type.Optional(Type.String({ description: "Optional display alias; if omitted, a Greek mythological name is chosen" })),
      model: Type.String({ description: "Required model in provider/model form, for example openai-codex/gpt-5.6-sol" }),
      thinking: ThinkingSchema,
      placement: Type.Optional(Type.Union(
        [Type.Literal("pane"), Type.Literal("window")],
        { description: "Where to open the worker; defaults to a detached tmux window" },
      )),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pairs = effectivePairs(ctx);
      if (pairs.length === 0) {
        throw new Error(delegationConfigError ?? "Heishi delegation models are not configured; use /heishi model");
      }
      if (!pairs.some((pair) => pair.model === params.model && pair.thinking === params.thinking)) {
        throw new Error(`Subagent model/thinking pair is not allowed: ${params.model} / ${params.thinking}`);
      }

      const input: StartInput = {
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
      container.addChild(new Text(
        `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_start"))}  ${theme.fg("accent", alias)}${theme.fg("dim", ` · ${args.model ?? "…"} / ${args.thinking ?? "…"}`)}`,
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
      "Use `resume` only to reconnect a disconnected subagent before another control action.",
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
        if (run && !effectivePairs(ctx).some((pair) => pair.model === run.model && pair.thinking === run.thinking)) {
          throw new Error(`Subagent model/thinking pair is no longer allowed: ${run.model} / ${run.thinking}`);
        }
      }
      return toolResult(await requireCoordinator().control(input));
    },
    renderCall(args, theme) {
      const runId = typeof args.runId === "string" ? shortRunId(args.runId) : "…";
      let text = `${theme.fg("accent", "◐")} ${theme.fg("toolTitle", theme.bold("subagent_control"))}  ${theme.fg("accent", args.action ?? "…")}${theme.fg("dim", ` · ${runId}`)}`;
      if (args.message?.trim()) text += `\n  ${theme.fg("muted", args.message.trim())}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      return renderRunResult(result.details as RunResult | undefined, result, theme);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait until a subagent's current delegated work reaches agent_settled, then return its structured report and verified session metadata.",
    promptSnippet: "Wait for a tmux subagent to settle and return its structured report",
    promptGuidelines: [
      "Use `subagent_wait` with the full run UUID after starting or controlling a subagent when the parent needs its final result.",
      "Treat the result of `subagent_wait`, which waits for `agent_settled`, as completion; do not infer completion from tmux pane output or `agent_end`.",
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
      const details = result.details as RunResult | undefined;
      if (!details) return fallbackResult(result);
      if (!details.report) return renderRunResult(details, result, theme);
      const container = new Container();
      container.addChild(new Text(runStatusHeader(details, theme), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(reportMarkdown(details.report), 0, 0, getMarkdownTheme()));
      return container;
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const pairs = effectivePairs(ctx);
    const guidance = pairs.length === 0
      ? "Heishi subagent delegation is disabled. Do not call subagent_start or use subagent_control to resume or assign new work. The user can configure it with /heishi model."
      : [
          "Heishi subagent delegation must use one of these exact model/thinking pairs:",
          ...pairs.map((pair) => `- ${pair.model} / ${pair.thinking}`),
          "Choose the pair that best fits each delegated task and pass both values explicitly to subagent_start. Do not resume or assign new work to an existing subagent whose pair is not listed.",
        ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.registerCommand("heishi", {
    description: "Configure Heishi",
    handler: async (args, ctx) => {
      if (args.trim() !== "model") {
        ctx.ui.notify("Usage: /heishi model", "info");
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

  function effectivePairs(ctx: ExtensionContext): DelegationPair[] {
    return allowedPairs(
      delegationConfig,
      availableModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels),
    );
  }
}

interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
}

function fallbackResult(result: RenderableResult): Text {
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  return new Text(text, 0, 0);
}

function renderRunResult(details: RunResult | undefined, result: RenderableResult, theme: Theme): Text {
  if (!details) return fallbackResult(result);
  return new Text(runStatusHeader(details, theme), 0, 0);
}

function runStatusHeader(result: RunResult, theme: Theme): string {
  const color = result.status === "completed"
    ? "success"
    : result.status === "failed"
      ? "error"
      : result.status === "blocked" || result.status === "cancelled"
        ? "warning"
        : "accent";
  const icon = result.status === "completed" ? "✓" : result.status === "failed" ? "✕" : result.status === "running" ? "◐" : "!";
  const pane = result.tmuxTarget ? ` · pane ${result.tmuxTarget}` : "";
  const error = result.error ? `\n  ${theme.fg("error", result.error)}` : "";
  return `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(runIdentity(result)))}  ${theme.fg(color, result.status)}${theme.fg("dim", `${pane} · ${result.model} / ${result.thinking}`)}${error}`;
}

function toolResult(
  result: RunResult,
): { content: Array<{ type: "text"; text: string }>; details: RunResult } {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}
