import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { HeadlessHost } from "./headless.js";

// Stands in for `pi --mode rpc`: asks for a confirmation, records the reply, and exits when stdin closes.
const FAKE_RPC_WORKER = `
const { appendFileSync } = require("node:fs");
const output = process.env.HEISHI_TEST_OUTPUT;
appendFileSync(output, JSON.stringify(process.argv.slice(-2)) + "\\n");
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Allow?" }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => appendFileSync(output, chunk));
process.stdin.on("end", () => process.exit(0));
`;

// Ignores stdin EOF and SIGTERM, like a hung worker.
const STUBBORN_WORKER = `
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1000);
`;

describe("headless host", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("runs the worker in RPC mode, cancels dialogs, and closes through stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heishi-headless-"));
    directories.push(directory);
    const output = join(directory, "output.jsonl");
    const worker = join(directory, "worker.cjs");
    await writeFile(worker, FAKE_RPC_WORKER);
    const host = new HeadlessHost();

    const target = await host.launch({
      placement: "session",
      cwd: directory,
      title: "sub · Test · 123456",
      command: [process.execPath, worker],
      environment: { HEISHI_TEST_OUTPUT: output },
      launcherDirectory: directory,
    });

    assert.equal(target.host, "headless");
    assert.ok(target.startedAt);
    assert.equal(await host.exists(target), true);
    const lines = await waitForLines(output, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ""), ["--mode", "rpc"]);
    assert.deepEqual(JSON.parse(lines[1] ?? ""), { type: "extension_ui_response", id: "dialog-1", cancelled: true });
    await assert.rejects(() => host.focus(target), /no terminal to focus/u);

    await host.close(target);
    assert.equal(await host.exists(target), false);
  });

  it("closes a restored worker by signal and ignores a reused process ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heishi-headless-"));
    directories.push(directory);
    const worker = join(directory, "stubborn.cjs");
    await writeFile(worker, STUBBORN_WORKER);
    const target = await new HeadlessHost().launch({
      placement: "session",
      cwd: directory,
      title: "sub · Test · 123456",
      command: [process.execPath, worker],
      environment: {},
      launcherDirectory: directory,
    });

    const restoredHost = new HeadlessHost();
    assert.equal(await restoredHost.exists({ ...target, startedAt: "Thu Jan  1 00:00:00 1970" }), false);
    assert.equal(await restoredHost.exists(target), true);
    await restoredHost.close(target);
    assert.equal(await restoredHost.exists(target), false);
  });
});

async function waitForLines(path: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lines = (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} lines in ${path}`);
}
