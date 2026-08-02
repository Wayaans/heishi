import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RunCoordinator } from "./coordinator.js";
import { IpcHub } from "./ipc.js";
import { MutationLease } from "./lease.js";
import { showSubagentOverlay } from "./overlay.js";
import { reconcileRuns, restoreRunSnapshots, RUN_ENTRY_TYPE } from "./registry.js";
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
]);

export default function heishi(pi: ExtensionAPI): void {
  if (process.env["HEISHI_WORKER"] === "1") {
    registerWorkerBridge(pi);
    return;
  }

  const tmux = new Tmux();
  const ipc = new IpcHub();
  const lease = new MutationLease(undefined, undefined, (target) => tmux.exists(target));
  const extensionPath = fileURLToPath(import.meta.url);
  let coordinator: RunCoordinator | undefined;

  const createCoordinator = (ctx: ExtensionContext): RunCoordinator => new RunCoordinator({
    cwd: ctx.cwd,
    extensionPath,
    piPath: "pi",
    tmux,
    ipc,
    lease,
    persist: (record) => pi.appendEntry(RUN_ENTRY_TYPE, record),
  });

  const requireCoordinator = (): RunCoordinator => {
    if (!coordinator) throw new Error("Subagent coordinator is not initialized");
    return coordinator;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (coordinator) await coordinator.shutdown();
    coordinator = createCoordinator(ctx);
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

  pi.on("before_agent_start", (event) => {
    if (!coordinator?.hasMutationLease()) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nA subagent currently owns the mutation lease for this checkout. Do not edit files or run mutating commands until that subagent settles. Read-only inspection is allowed. This is cooperative protection; use a separate worktree for hard isolation.`,
    };
  });

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start an asynchronous subagent in tmux. You must explicitly provide the model and thinking level.",
    parameters: Type.Object({
      task: Type.String(),
      alias: Type.Optional(Type.String()),
      model: Type.String(),
      thinking: ThinkingSchema,
      placement: Type.Optional(Type.Union([Type.Literal("pane"), Type.Literal("window")])),
    }),
    async execute(_toolCallId, params, signal) {
      const input: StartInput = {
        task: params.task,
        model: params.model,
        thinking: params.thinking,
      };
      if (params.alias !== undefined) input.alias = params.alias;
      if (params.placement !== undefined) input.placement = params.placement;
      const result = await requireCoordinator().start(input, signal);
      return toolResult(
        result,
        "The subagent now owns this checkout's mutation lease. Do not edit files or run mutating commands until it settles.",
      );
    },
  });

  pi.registerTool({
    name: "subagent_control",
    label: "Control Subagent",
    description: "Prompt, steer, follow up, abort, focus, or resume a subagent by its authoritative run UUID.",
    parameters: Type.Object({
      runId: Type.String(),
      action: Type.Union([
        Type.Literal("prompt"),
        Type.Literal("steer"),
        Type.Literal("follow_up"),
        Type.Literal("abort"),
        Type.Literal("focus"),
        Type.Literal("resume"),
      ]),
      message: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const input: ControlInput = { runId: params.runId, action: params.action };
      if (params.message !== undefined) input.message = params.message;
      return toolResult(await requireCoordinator().control(input));
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait until a subagent's current work is fully settled and return its report and verified session metadata.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params, signal) {
      return toolResult(await requireCoordinator().wait(params.runId, signal));
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
}

function toolResult(
  result: RunResult,
  guidance?: string,
): { content: Array<{ type: "text"; text: string }>; details: RunResult } {
  const resultText = JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text", text: guidance ? `${guidance}\n\n${resultText}` : resultText }],
    details: result,
  };
}
