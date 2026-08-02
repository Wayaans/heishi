import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { describe, it } from "node:test";
import { IpcHub } from "./ipc.js";
import { JsonlDecoder, PROTOCOL_VERSION, encodeMessage, type ProtocolEnvelope } from "./protocol.js";

function send(socket: Socket, message: Omit<ProtocolEnvelope, "version">): void {
  socket.write(encodeMessage({ ...message, version: PROTOCOL_VERSION } as ProtocolEnvelope));
}

describe("worker IPC", () => {
  it("keeps Unix socket paths below the portable length limit", async () => {
    const hub = new IpcHub(`/tmp/${"long-directory/".repeat(10)}`);
    const channel = await hub.open("run-with-a-long-root", "token", () => undefined);

    assert.ok(Buffer.byteLength(channel.socketPath) <= 100);
    await channel.close();
  });

  it("does not let an unauthenticated connection starve the real subagent", async () => {
    const hub = new IpcHub();
    const channel = await hub.open("run-auth", "real-token", () => undefined);
    const intruder = connect(channel.socketPath);
    await new Promise<void>((resolve) => intruder.once("connect", resolve));
    const subagent = connect(channel.socketPath);
    await new Promise<void>((resolve) => subagent.once("connect", resolve));
    send(subagent, { type: "hello", runId: "run-auth", token: "real-token" });
    send(subagent, {
      type: "ready", runId: "run-auth", model: "openai/model", thinking: "high",
      sessionId: "session-auth", sessionFile: "/sessions/auth.jsonl",
    });

    try {
      const ready = await Promise.race([
        channel.waitForReady(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("real subagent was starved")), 50)),
      ]);
      assert.equal(ready.sessionId, "session-auth");
    } finally {
      intruder.destroy();
      subagent.destroy();
      await channel.close();
    }
  });

  it("authenticates, returns readiness, and correlates command acknowledgements", async () => {
    const events: ProtocolEnvelope[] = [];
    const hub = new IpcHub();
    const channel = await hub.open("run-1", "secret-token", (event) => { events.push(event); });
    const worker = connect(channel.socketPath);
    const decoder = new JsonlDecoder();

    worker.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.requestId) {
          send(worker, { type: "ack", runId: "run-1", requestId: message.requestId });
        }
      }
    });
    await new Promise<void>((resolve) => worker.once("connect", resolve));
    send(worker, { type: "hello", runId: "run-1", token: "secret-token" });
    send(worker, {
      type: "ready",
      runId: "run-1",
      model: "openai/model",
      thinking: "high",
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
    });

    assert.deepEqual(await channel.waitForReady(), {
      model: "openai/model",
      thinking: "high",
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
    });
    await channel.send("task", { task: "Inspect the repository" });
    send(worker, { type: "progress", runId: "run-1", message: "reading files" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events[0]?.type, "progress");

    const closed = new Promise<void>((resolve) => worker.once("close", () => resolve()));
    worker.destroy();
    await closed;

    const replacement = connect(channel.socketPath);
    await new Promise<void>((resolve) => replacement.once("connect", resolve));
    send(replacement, { type: "progress", runId: "run-1", message: "unauthenticated" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.filter((event) => event.type === "progress").length, 1);

    replacement.destroy();
    await channel.close();
  });
});
