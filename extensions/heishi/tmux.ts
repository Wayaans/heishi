import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type Placement = "pane" | "window" | "session";

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
  sessionName?: string;
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
    const format = "#{pane_id} #{window_id} #{session_id}";
    const namedSessionArgs = (operation: "new-session" | "new-window", sessionName: string): string[] => {
      return operation === "new-window"
        ? [operation, "-d", "-P", "-F", format, "-t", `=${sessionName}:`, "-n", spec.title, "-c", spec.cwd]
        : [operation, "-d", "-P", "-F", format, "-s", sessionName, "-n", spec.title, "-c", spec.cwd];
    };
    let args: string[];
    if (spec.placement === "session") {
      if (!spec.sessionName?.trim()) throw new Error("Named session placement requires a session name");
      const sessionTarget = `=${spec.sessionName}`;
      const exists = await this.executor.exec("tmux", ["has-session", "-t", sessionTarget])
        .then(() => true, () => false);
      args = namedSessionArgs(exists ? "new-window" : "new-session", spec.sessionName);
    } else {
      const operation = spec.placement === "pane" ? "split-window" : "new-window";
      args = [operation, "-d", "-P", "-F", format, "-c", spec.cwd];
      if (spec.placement === "window") args.push("-n", spec.title);
    }
    const completeArgs = (base: string[]): string[] => {
      for (const [key, value] of Object.entries(spec.environment)) base.push("-e", `${key}=${value}`);
      base.push(`exec ${spec.command.map(shellQuote).join(" ")}`);
      return base;
    };
    args = completeArgs(args);

    let result: { stdout: string; stderr: string };
    try {
      result = await this.executor.exec("tmux", args);
    } catch (error) {
      if (spec.placement !== "session" || !spec.sessionName) throw error;
      const sessionTarget = `=${spec.sessionName}`;
      const exists = await this.executor.exec("tmux", ["has-session", "-t", sessionTarget])
        .then(() => true, () => false);
      const retryOperation = args[0] === "new-session" && exists
        ? "new-window"
        : args[0] === "new-window" && !exists
          ? "new-session"
          : undefined;
      if (!retryOperation) throw error;
      args = completeArgs(namedSessionArgs(retryOperation, spec.sessionName));
      result = await this.executor.exec("tmux", args);
    }
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
  mode: "sub" | "main";
  piPath: string;
  extensionPath: string;
  model?: string;
  thinking?: ThinkingLevel;
  name: string;
  projectTrusted: boolean;
  sessionFile?: string;
}

export function buildPiCommand(options: PiCommandOptions): string[] {
  const command = options.mode === "main"
    ? buildMainPiCommand(options)
    : buildSubPiCommand(options);
  if (options.sessionFile) command.push("--session", options.sessionFile);
  return command;
}

function buildSubPiCommand(options: PiCommandOptions): string[] {
  if (!options.model || !options.thinking) throw new Error("Subagent model and thinking are required");
  return [
    options.piPath,
    "--no-extensions",
    "-e", options.extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--model", options.model,
    "--thinking", options.thinking,
    "--name", options.name,
  ];
}

function buildMainPiCommand(options: PiCommandOptions): string[] {
  const command = [options.piPath, "-e", options.extensionPath];
  if (options.model) command.push("--model", options.model);
  if (options.thinking) command.push("--thinking", options.thinking);
  command.push("--name", options.name, options.projectTrusted ? "--approve" : "--no-approve");
  return command;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
