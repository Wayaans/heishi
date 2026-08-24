import { ProcessCommandExecutor, type CommandExecutor } from "./command-executor.js";
import {
  tmuxHostTarget,
  type HostLaunch,
  type HostTarget,
  type Placement,
  type TerminalHost,
  type TmuxHostTarget,
} from "./terminal-host.js";
import { shellQuote } from "./worker-command.js";

export { THINKING_LEVELS, type Placement, type ThinkingLevel } from "./terminal-host.js";
export { buildPiCommand, type PiCommandOptions } from "./worker-command.js";

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

export class TmuxHost implements TerminalHost {
  readonly kind = "tmux" as const;

  constructor(private readonly tmux: TmuxAdapter) {}

  validate(): Promise<void> {
    return this.tmux.validate();
  }

  async launch(spec: HostLaunch): Promise<TmuxHostTarget> {
    const target = await this.tmux.launch(spec);
    return tmuxHostTarget(target);
  }

  exists(target: HostTarget): Promise<boolean> {
    return this.tmux.exists(requireTmuxTarget(target).paneId);
  }

  focus(target: HostTarget): Promise<void> {
    return this.tmux.focus(requireTmuxTarget(target).paneId);
  }

  close(target: HostTarget): Promise<void> {
    return this.tmux.close(requireTmuxTarget(target).paneId);
  }
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
    const ids = result.stdout.trim().split(/\s+/u);
    const [paneId, windowId, sessionId] = ids;
    if (ids.length !== 3
      || !isTmuxId(paneId, "%")
      || !isTmuxId(windowId, "@")
      || !isTmuxId(sessionId, "$")) {
      if (isTmuxId(paneId, "%")) {
        await this.executor.exec("tmux", ["kill-pane", "-t", paneId]).catch(() => undefined);
      }
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
    const result = await this.executor.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
    return result.stdout.split("\n").some((paneId) => paneId.trim() === target);
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

function requireTmuxTarget(target: HostTarget): TmuxHostTarget {
  if (target.host !== "tmux") throw new Error("Tmux host received a cmux target");
  return target;
}

function isTmuxId(value: string | undefined, prefix: "%" | "@" | "$"): value is string {
  return value?.startsWith(prefix) === true && /^[0-9]+$/u.test(value.slice(1));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
