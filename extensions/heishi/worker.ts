import { connect, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JsonlDecoder, PROTOCOL_VERSION, encodeMessage, type ProtocolEnvelope } from "./protocol.js";

const SUBAGENT_PROMPT = `You are a delegated subagent running in an isolated Pi session.
Complete only the task assigned by the parent agent. Work independently and efficiently.
Do not delegate to additional subagents.
Follow the loaded AGENTS.md instructions and use available coding tools as needed.
You may receive steering and follow-up tasks from the parent.
Finish delegated work by calling subagent_report exactly once with outcome, concise summary, verification, blockers, and remaining risks.`;

interface WorkerConfiguration {
  runId: string;
  token: string;
  socketPath: string;
  resume: boolean;
}

export function registerWorkerBridge(pi: ExtensionAPI): void {
  const configuration = readConfiguration();
  const socket = connect(configuration.socketPath);
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new JsonlDecoder();
  let context: ExtensionContext | undefined;
  let taskSubmitted = configuration.resume;
  let reportCalled = false;
  let queuedFollowUps = 0;
  let finalAssistantText = "";
  let shuttingDown = false;

  const send = (type: string, payload: Record<string, unknown> = {}): void => {
    if (socket.destroyed) return;
    socket.write(encodeMessage({
      ...payload,
      type,
      runId: configuration.runId,
      version: PROTOCOL_VERSION,
    }));
  };

  pi.registerTool({
    name: "subagent_report",
    label: "Subagent Report",
    description: "Report the final outcome of the delegated subagent work. Call exactly once when the work is finished.",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.String(),
      verification: Type.Optional(Type.String()),
      remainingRisk: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (queuedFollowUps > 0) {
        throw new Error("Complete the queued follow-up before calling subagent_report");
      }
      if (reportCalled) throw new Error("subagent_report has already been called for the current work");
      reportCalled = true;
      send("report", { report: params });
      return {
        content: [{ type: "text", text: "Subagent report delivered to the parent." }],
        details: params,
        terminate: true,
      };
    },
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_PROMPT}`,
  }));

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      await connected;
      send("hello", { token: configuration.token });
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!model || !ctx.thinkingLevel || !sessionFile) {
        throw new Error("Subagent could not determine its effective model, thinking level, or persistent session file");
      }
      send("ready", {
        model,
        thinking: ctx.thinkingLevel,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile,
      });
    } catch (error) {
      send("error", { message: errorMessage(error) });
    }
  });

  pi.on("agent_start", () => {
    const startsQueuedFollowUp = queuedFollowUps > 0;
    if (startsQueuedFollowUp) {
      queuedFollowUps -= 1;
      beginWork();
    }
    send("progress", {
      message: "Subagent started working",
      workStarted: true,
      ...(startsQueuedFollowUp ? { resetReport: true } : {}),
    });
  });

  pi.on("tool_execution_start", (event) => {
    send("progress", { message: `Using ${event.toolName}` });
  });

  pi.on("agent_end", (event) => {
    finalAssistantText = extractFinalAssistantText(event.messages) || finalAssistantText;
  });

  pi.on("agent_settled", () => {
    send("settled", { finalText: finalAssistantText, structuredReport: reportCalled });
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    socket.destroy();
  });

  socket.on("data", (chunk) => {
    try {
      for (const message of decoder.push(chunk)) void route(message);
    } catch (error) {
      send("error", { message: errorMessage(error) });
    }
  });
  socket.on("close", () => {
    if (!shuttingDown) context?.shutdown();
  });
  socket.on("error", (error) => {
    send("error", { message: error.message });
  });

  async function route(message: ProtocolEnvelope): Promise<void> {
    if (message.runId !== configuration.runId) return;
    const requestId = message.requestId;
    try {
      if (!context) throw new Error("Subagent session is not ready");
      if (message.type === "task") {
        if (taskSubmitted) throw new Error("The initial subagent task has already been submitted");
        taskSubmitted = true;
        beginWork();
        pi.sendUserMessage(requireMessage(message, "task"));
      } else if (message.type === "prompt") {
        if (!context.isIdle()) throw new Error("Subagent is busy; use steer or follow_up");
        beginWork();
        pi.sendUserMessage(requireMessage(message, "message"));
      } else if (message.type === "steer") {
        if (context.isIdle()) throw new Error("Subagent is idle; use prompt");
        pi.sendUserMessage(requireMessage(message, "message"), { deliverAs: "steer" });
      } else if (message.type === "follow_up") {
        const text = requireMessage(message, "message");
        if (context.isIdle()) {
          beginWork();
          pi.sendUserMessage(text);
        } else {
          queuedFollowUps += 1;
          try {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
          } catch (error) {
            queuedFollowUps -= 1;
            throw error;
          }
        }
      } else if (message.type === "abort") {
        context.abort();
      } else {
        throw new Error(`Unsupported subagent command: ${message.type}`);
      }
      acknowledge(requestId, true);
    } catch (error) {
      acknowledge(requestId, false, errorMessage(error));
    }
  }

  function beginWork(): void {
    reportCalled = false;
    finalAssistantText = "";
  }

  function acknowledge(requestId: string | undefined, ok: boolean, error?: string): void {
    if (!requestId) return;
    send("ack", { requestId, ok, ...(error ? { error } : {}) });
  }
}

function readConfiguration(): WorkerConfiguration {
  const runId = process.env["HEISHI_RUN_ID"];
  const token = process.env["HEISHI_TOKEN"];
  const socketPath = process.env["HEISHI_SOCKET"];
  if (!runId || !token || !socketPath) throw new Error("Subagent bridge configuration is incomplete");
  return { runId, token, socketPath, resume: process.env["HEISHI_RESUME"] === "1" };
}

function requireMessage(message: ProtocolEnvelope, field: "task" | "message"): string {
  const value = message[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${field} is required`);
  return value;
}

function extractFinalAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record["role"] !== "assistant" || !Array.isArray(record["content"])) continue;
    const texts = record["content"]
      .filter((part): part is { type: "text"; text: string } => {
        return typeof part === "object" && part !== null
          && (part as Record<string, unknown>)["type"] === "text"
          && typeof (part as Record<string, unknown>)["text"] === "string";
      })
      .map((part) => part.text);
    if (texts.length > 0) return texts.join("\n").trim();
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
