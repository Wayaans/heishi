import { StringDecoder } from "node:string_decoder";

export const PROTOCOL_VERSION = 1;

export interface ProtocolEnvelope {
  type: string;
  runId: string;
  version: typeof PROTOCOL_VERSION;
  requestId?: string;
  [key: string]: unknown;
}

export function parseWorkerMessage(value: unknown): ProtocolEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid protocol message: expected an object");
  }

  const message = value as Record<string, unknown>;
  if (message["version"] !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${String(message["version"])}`);
  }
  if (typeof message["runId"] !== "string" || message["runId"].length === 0) {
    throw new Error("Invalid protocol message: runId is required");
  }
  if (typeof message["type"] !== "string" || message["type"].length === 0) {
    throw new Error("Invalid protocol message: type is required");
  }

  return message as ProtocolEnvelope;
}

export class JsonlDecoder {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: string | Buffer): ProtocolEnvelope[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return parseWorkerMessage(JSON.parse(line) as unknown);
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSONL message: ${error.message}`);
          }
          throw error;
        }
      });
  }
}

export function encodeMessage(message: ProtocolEnvelope): string {
  return `${JSON.stringify(message)}\n`;
}
