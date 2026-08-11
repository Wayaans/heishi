import { connect, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JsonlDecoder, PROTOCOL_VERSION, encodeMessage, type ProtocolEnvelope } from "./protocol.js";
import type { WorkerMode } from "./types.js";

const WORKER_CONTRACT = `You are a delegated worker, not a user-facing agent.
Your only external communication channel is the parent agent. Treat every message in this session as coming from the parent, even when Pi represents it as a user message. Return all outcomes, questions, blockers, and requests for confirmation to the parent.
You are running in a fresh, isolated session. You do not have the parent conversation, prior tool results, assumptions, decisions, or user messages. Use only the delegated task, resources available in this session, and later messages explicitly sent by the parent. Never assume context that was not included.
Do not ask the user questions, request confirmation, or open interactive UI. If external input is required, stop and call subagent_report with status \`blocked\` and a structured \`request\`. The parent will obtain the answer and send it back in a later message.
You may receive steering and follow-up tasks from the parent.`;

const SUBAGENT_PROMPT = `${WORKER_CONTRACT}
Complete only the task assigned by the parent agent. Work independently and efficiently.
Do not delegate to additional subagents.
Follow the loaded AGENTS.md instructions and use available coding tools as needed.
Finish delegated work by calling subagent_report exactly once with outcome, concise summary, verification, and remaining risks.`;

const MAIN_AGENT_PROMPT = `${WORKER_CONTRACT}
You are a managed Heishi main agent. Behave as a normal Pi coding agent with all loaded resources.
When the managed task is complete, prefer \`subagent_report\`; if it is not called, Heishi uses the final assistant response.`;

const ExternalInputRequestSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("question"),
    Type.Literal("confirmation"),
    Type.Literal("decision"),
    Type.Literal("missing_context"),
    Type.Literal("permission"),
  ]),
  prompt: Type.String({ minLength: 1, description: "The exact question or request the parent must resolve" }),
  detail: Type.Optional(Type.String({ description: "Context the parent needs to resolve the request" })),
  options: Type.Optional(Type.Array(Type.String(), { description: "Available choices, when applicable" })),
  recommendation: Type.Optional(Type.String({ description: "Recommended answer and rationale, when one exists" })),
});

interface WorkerConfiguration {
  mode: WorkerMode;
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
  let bridgeReady = false;
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

  const sendMetadata = (model: string, thinking: string): void => {
    if (configuration.mode === "main" && bridgeReady) send("metadata", { model, thinking });
  };

  pi.registerTool({
    name: "subagent_report",
    label: "Subagent Report",
    description: "Report the final outcome or a structured external-input blocker to the parent. Call exactly once when the work is finished or blocked.",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.String(),
      verification: Type.Optional(Type.String()),
      remainingRisk: Type.Optional(Type.String()),
      request: Type.Optional(ExternalInputRequestSchema),
    }),
    async execute(_toolCallId, params) {
      if (queuedFollowUps > 0) {
        throw new Error("Complete the queued follow-up before calling subagent_report");
      }
      if (reportCalled) throw new Error("subagent_report has already been called for the current work");
      if (params.status === "blocked" && (params.request === undefined || !params.request.prompt.trim())) {
        throw new Error("A blocked subagent report requires a structured request for the parent");
      }
      if (params.status !== "blocked" && params.request !== undefined) {
        throw new Error("Only a blocked subagent report may include a request");
      }
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
    systemPrompt: `${event.systemPrompt}\n\n${workerSystemPrompt(configuration.mode)}`,
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
      bridgeReady = true;
    } catch (error) {
      send("error", { message: errorMessage(error) });
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (ctx.thinkingLevel) sendMetadata(`${event.model.provider}/${event.model.id}`, ctx.thinkingLevel);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (ctx.model) sendMetadata(`${ctx.model.provider}/${ctx.model.id}`, event.level);
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
  return {
    mode: resolveWorkerMode(process.env),
    runId,
    token,
    socketPath,
    resume: process.env["HEISHI_RESUME"] === "1",
  };
}

export function resolveWorkerMode(environment: Readonly<Record<string, string | undefined>>): WorkerMode {
  const mode = environment["HEISHI_WORKER_MODE"];
  if (mode === undefined || mode === "sub") return "sub";
  if (mode === "main") return "main";
  throw new Error(`Invalid Heishi worker mode: ${mode}`);
}

export function workerSystemPrompt(mode: WorkerMode): string {
  return mode === "main" ? MAIN_AGENT_PROMPT : SUBAGENT_PROMPT;
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
