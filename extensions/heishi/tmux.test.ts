import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tmux, buildPiCommand, type CommandExecutor } from "./tmux.js";

class FakeExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  failTitle = false;

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args });
    if (this.failTitle && args[0] === "select-pane") throw new Error("title failed");
    if (args[0] === "split-window" || args[0] === "new-window") return { stdout: "%17\n", stderr: "" };
    return { stdout: "$1\n", stderr: "" };
  }
}

describe("tmux adapter", () => {
  it("requires both the tmux environment and a functioning command", async () => {
    const executor = new FakeExecutor();
    const tmux = new Tmux(executor, {});

    await assert.rejects(() => tmux.validate(), /inside tmux/);
    assert.equal(executor.calls.length, 0);
  });

  it("constructs a detached pane with worker metadata and no task text", async () => {
    const executor = new FakeExecutor();
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    const target = await tmux.launch({
      placement: "pane",
      cwd: "/work/repo",
      title: "Atalanta · a1b2c3",
      command: ["pi", "--model", "provider/model'; touch /tmp/pwned; '"],
      environment: { HEISHI_RUN_ID: "a1b2c3" },
    });

    assert.equal(target, "%17");
    const launch = executor.calls[0];
    assert.equal(launch?.command, "tmux");
    assert.deepEqual(launch?.args.slice(0, 8), [
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-c", "/work/repo", "-e",
    ]);
    assert.ok(launch?.args.includes("HEISHI_RUN_ID=a1b2c3"));
    const shellCommand = launch?.args.at(-1) ?? "";
    assert.equal(shellCommand, "exec 'pi' '--model' 'provider/model'\"'\"'; touch /tmp/pwned; '\"'\"''");
    assert.equal(shellCommand.includes("task text"), false);
  });

  it("kills a created pane when title setup fails", async () => {
    const executor = new FakeExecutor();
    executor.failTitle = true;
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    await assert.rejects(() => tmux.launch({
      placement: "pane",
      cwd: "/work/repo",
      title: "Circe · abc123",
      command: ["pi"],
      environment: {},
    }), /title failed/);

    assert.ok(executor.calls.some((call) => call.args[0] === "kill-pane" && call.args[2] === "%17"));
  });
});

describe("Pi command construction", () => {
  it("loads only the bridge while preserving sessions and project context", () => {
    assert.deepEqual(buildPiCommand({
      piPath: "/bin/pi",
      extensionPath: "/repo/extensions/heishi/index.ts",
      model: "openai/model",
      thinking: "high",
      name: "Subagent: Circe · 123456",
    }), [
      "/bin/pi",
      "--no-extensions",
      "-e", "/repo/extensions/heishi/index.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--model", "openai/model",
      "--thinking", "high",
      "--name", "Subagent: Circe · 123456",
    ]);
  });
});
