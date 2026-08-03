import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Placement = "pane" | "window";

export interface CommandExecutor {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export class ProcessCommandExecutor implements CommandExecutor {
  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(command, args, { encoding: "utf8" });
  }
}

export interface TmuxLaunch {
  placement: Placement;
  cwd: string;
  title: string;
  command: string[];
  environment: Record<string, string>;
}

export interface TmuxTarget {
  paneId: string;
  windowId: string;
  sessionId: string;
}

export interface TmuxAdapter {
  validate(): Promise<void>;
  launch(spec: TmuxLaunch): Promise<TmuxTarget>;
  exists(target: string): Promise<boolean>;
  focus(target: string): Promise<void>;
  close(target: string): Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export class Tmux implements TmuxAdapter {
  constructor(
    private readonly executor: CommandExecutor = new ProcessCommandExecutor(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async validate(): Promise<void> {
    if (!this.environment["TMUX"]) {
      throw new Error("Subagents can only start inside tmux");
    }
    try {
      await this.executor.exec("tmux", ["display-message", "-p", "#{session_id}"]);
    } catch (error) {
      throw new Error(`tmux is not functioning: ${errorMessage(error)}`);
    }
  }

  async launch(spec: TmuxLaunch): Promise<TmuxTarget> {
    if (spec.command.length === 0) throw new Error("Subagent command is empty");
    const operation = spec.placement === "pane" ? "split-window" : "new-window";
    const args = [operation, "-d", "-P", "-F", "#{pane_id} #{window_id} #{session_id}", "-c", spec.cwd];
    if (spec.placement === "window") args.push("-n", spec.title);
    for (const [key, value] of Object.entries(spec.environment)) args.push("-e", `${key}=${value}`);
    args.push(`exec ${spec.command.map(shellQuote).join(" ")}`);

    const result = await this.executor.exec("tmux", args);
    const [paneId, windowId, sessionId] = result.stdout.trim().split(" ");
    if (!paneId?.startsWith("%") || !windowId?.startsWith("@") || !sessionId?.startsWith("$")) {
      throw new Error(`tmux did not return pane, window, and session IDs: ${result.stdout.trim()}`);
    }
    try {
      await this.executor.exec("tmux", ["select-pane", "-t", paneId, "-T", spec.title]);
      return { paneId, windowId, sessionId };
    } catch (error) {
      await this.executor.exec("tmux", ["kill-pane", "-t", paneId]).catch(() => undefined);
      throw error;
    }
  }

  async exists(target: string): Promise<boolean> {
    try {
      await this.executor.exec("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"]);
      return true;
    } catch {
      return false;
    }
  }

  async focus(target: string): Promise<void> {
    const result = await this.executor.exec("tmux", [
      "display-message", "-p", "-t", target, "#{session_name}:#{window_index}",
    ]);
    await this.executor.exec("tmux", ["switch-client", "-t", result.stdout.trim()]);
    await this.executor.exec("tmux", ["select-pane", "-t", target]);
  }

  async close(target: string): Promise<void> {
    try {
      await this.executor.exec("tmux", ["kill-pane", "-t", target]);
    } catch {
      // Closing is idempotent: the interactive worker may exit before the parent kills its pane.
    }
  }
}

export interface PiCommandOptions {
  piPath: string;
  extensionPath: string;
  model: string;
  thinking: ThinkingLevel;
  name: string;
  sessionFile?: string;
}

export function buildPiCommand(options: PiCommandOptions): string[] {
  const command = [
    options.piPath,
    "--no-extensions",
    "-e", options.extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--model", options.model,
    "--thinking", options.thinking,
    "--name", options.name,
  ];
  if (options.sessionFile) command.push("--session", options.sessionFile);
  return command;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
