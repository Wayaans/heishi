import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tmux, buildPiCommand, type CommandExecutor } from "./tmux.js";

class FakeExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  failTitle = false;
  sessionExists = false;
  raceOnSessionCreate = false;
  raceOnWindowCreate = false;
  paneList = "%17\n";
  launchOutput = "%17 @3 $1\n";
  failPaneList = false;

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args });
    if (this.failTitle && args[0] === "select-pane") throw new Error("title failed");
    if (this.failPaneList && args[0] === "list-panes") throw new Error("tmux server unavailable");
    if (args[0] === "list-panes") return { stdout: this.paneList, stderr: "" };
    if (args[0] === "has-session" && !this.sessionExists) throw new Error("session not found");
    if (args[0] === "new-session" && this.raceOnSessionCreate) {
      this.sessionExists = true;
      throw new Error("duplicate session");
    }
    if (args[0] === "new-window" && this.raceOnWindowCreate) {
      this.raceOnWindowCreate = false;
      this.sessionExists = false;
      throw new Error("session disappeared");
    }
    if (args[0] === "split-window" || args[0] === "new-window" || args[0] === "new-session") {
      return { stdout: this.launchOutput, stderr: "" };
    }
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

    assert.deepEqual(target, { paneId: "%17", windowId: "@3", sessionId: "$1" });
    const launch = executor.calls[0];
    assert.equal(launch?.command, "tmux");
    assert.deepEqual(launch?.args.slice(0, 8), [
      "split-window", "-d", "-P", "-F", "#{pane_id} #{window_id} #{session_id}", "-c", "/work/repo", "-e",
    ]);
    assert.ok(launch?.args.includes("HEISHI_RUN_ID=a1b2c3"));
    const shellCommand = launch?.args.at(-1) ?? "";
    assert.equal(shellCommand, "exec 'pi' '--model' 'provider/model'\"'\"'; touch /tmp/pwned; '\"'\"''");
    assert.equal(shellCommand.includes("task text"), false);
  });

  it("rejects nonnumeric or extra tmux launch IDs", async () => {
    const executor = new FakeExecutor();
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });
    const launch = () => tmux.launch({
      placement: "pane",
      cwd: "/work/repo",
      title: "Atalanta · a1b2c3",
      command: ["pi"],
      environment: {},
    });

    executor.launchOutput = "%bad @3 $1\n";
    await assert.rejects(launch, /did not return pane, window, and session IDs/u);
    executor.launchOutput = "%17 @3 $1 extra\n";
    await assert.rejects(launch, /did not return pane, window, and session IDs/u);
    assert.deepEqual(executor.calls.at(-1), { command: "tmux", args: ["kill-pane", "-t", "%17"] });
  });

  it("creates a detached named session with the worker as its first window", async () => {
    const executor = new FakeExecutor();
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    const target = await tmux.launch({
      placement: "session",
      sessionName: "heishi-subagents",
      cwd: "/work/repo",
      title: "Circe · abc123",
      command: ["pi"],
      environment: {},
    });

    assert.deepEqual(target, { paneId: "%17", windowId: "@3", sessionId: "$1" });
    assert.deepEqual(executor.calls[0]?.args, ["has-session", "-t", "=heishi-subagents"]);
    assert.deepEqual(executor.calls[1]?.args.slice(0, 11), [
      "new-session", "-d", "-P", "-F", "#{pane_id} #{window_id} #{session_id}",
      "-s", "heishi-subagents", "-n", "Circe · abc123", "-c", "/work/repo",
    ]);
  });

  it("opens a detached window when the named session already exists", async () => {
    const executor = new FakeExecutor();
    executor.sessionExists = true;
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    await tmux.launch({
      placement: "session",
      sessionName: "heishi-subagents",
      cwd: "/work/repo",
      title: "Achilles · 123abc",
      command: ["pi"],
      environment: {},
    });

    assert.equal(executor.calls[1]?.args[0], "new-window");
    assert.ok(executor.calls[1]?.args.includes("=heishi-subagents:"));
    assert.ok(executor.calls[1]?.args.includes("-d"));
  });

  it("retries in the named session when another launch creates it concurrently", async () => {
    const executor = new FakeExecutor();
    executor.raceOnSessionCreate = true;
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    await tmux.launch({
      placement: "session",
      sessionName: "heishi-subagents",
      cwd: "/work/repo",
      title: "Perseus · def456",
      command: ["pi"],
      environment: {},
    });

    assert.deepEqual(executor.calls.map((call) => call.args[0]), [
      "has-session", "new-session", "has-session", "new-window", "select-pane",
    ]);
    assert.ok(executor.calls[3]?.args.includes("=heishi-subagents:"));
  });

  it("recreates the named session when its final worker exits during launch", async () => {
    const executor = new FakeExecutor();
    executor.sessionExists = true;
    executor.raceOnWindowCreate = true;
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    await tmux.launch({
      placement: "session",
      sessionName: "heishi-subagents",
      cwd: "/work/repo",
      title: "Orpheus · 789abc",
      command: ["pi"],
      environment: {},
    });

    assert.deepEqual(executor.calls.map((call) => call.args[0]), [
      "has-session", "new-window", "has-session", "new-session", "select-pane",
    ]);
  });

  it("distinguishes an absent pane from a failed existence check", async () => {
    const executor = new FakeExecutor();
    const tmux = new Tmux(executor, { TMUX: "/tmp/tmux-501/default,1,0" });

    assert.equal(await tmux.exists("%17"), true);
    executor.paneList = "%18\n";
    assert.equal(await tmux.exists("%17"), false);
    executor.failPaneList = true;
    await assert.rejects(() => tmux.exists("%17"), /server unavailable/u);
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
  it("preserves the exact constrained sub command", () => {
    assert.deepEqual(buildPiCommand({
      mode: "sub",
      piPath: "/bin/pi",
      extensionPath: "/repo/extensions/heishi/index.ts",
      model: "openai/model",
      thinking: "high",
      name: "Subagent: Circe · 123456",
      projectTrusted: true,
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

  it("builds a trusted main command without disabling normal resources", () => {
    const command = buildPiCommand({
      mode: "main",
      piPath: "/bin/pi",
      extensionPath: "/repo/extensions/heishi/index.ts",
      model: "openai/model",
      thinking: "medium",
      name: "Subagent: Circe · 123456",
      projectTrusted: true,
    });

    assert.deepEqual(command, [
      "/bin/pi",
      "-e", "/repo/extensions/heishi/index.ts",
      "--model", "openai/model",
      "--thinking", "medium",
      "--name", "Subagent: Circe · 123456",
      "--approve",
    ]);
    assert.equal(command.some((argument) => argument.startsWith("--no-")), false);
  });

  it("lets Pi choose main model and thinking while mirroring untrusted project state", () => {
    assert.deepEqual(buildPiCommand({
      mode: "main",
      piPath: "/bin/pi",
      extensionPath: "/repo/extensions/heishi/index.ts",
      name: "Subagent: Circe · 123456",
      projectTrusted: false,
      sessionFile: "/sessions/main.jsonl",
    }), [
      "/bin/pi",
      "-e", "/repo/extensions/heishi/index.ts",
      "--name", "Subagent: Circe · 123456",
      "--no-approve",
      "--session", "/sessions/main.jsonl",
    ]);
  });
});
