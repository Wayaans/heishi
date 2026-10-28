import { ProcessCommandExecutor, type CommandExecutor } from "./command-executor.js";
import type {
  HostTarget,
  TerminalHost,
  TerminalHostKind,
  TerminalHostPreference,
  TerminalHosts,
} from "./terminal-host.js";

export class TerminalHostResolver implements TerminalHosts {
  private readonly hosts: ReadonlyMap<TerminalHostKind, TerminalHost>;

  constructor(
    hosts: readonly TerminalHost[],
    private readonly nestedHost: () => Promise<TerminalHostKind | undefined> = detectNestedHost,
  ) {
    this.hosts = new Map(hosts.map((host) => [host.kind, host]));
  }

  async resolve(preference: TerminalHostPreference): Promise<TerminalHost> {
    if (preference !== "auto") {
      const host = this.requireHost(preference);
      try {
        await host.validate();
        return host;
      } catch (error) {
        throw new Error(`${preference} terminal host is unavailable: ${errorMessage(error)}`);
      }
    }

    const results = await Promise.all(
      (["tmux", "cmux"] as const).map(async (kind) => {
        const host = this.hosts.get(kind);
        if (!host) return { kind, error: "not configured" } as const;
        try {
          await host.validate();
          return { kind, host } as const;
        } catch (error) {
          return { kind, error: errorMessage(error) } as const;
        }
      }),
    );
    const available = results.filter((result): result is { kind: "tmux" | "cmux"; host: TerminalHost } => "host" in result);
    const onlyAvailable = available.length === 1 ? available[0] : undefined;
    if (onlyAvailable) return onlyAvailable.host;
    if (available.length === 2) {
      const nested = await this.nestedHost();
      if (nested) return this.requireHost(nested);
      throw new Error("Both tmux and cmux are available, but Heishi cannot identify the controlling terminal. Select one in /heishi settings.");
    }
    const headless = this.hosts.get("headless");
    if (headless) return headless;
    const failures = results.map((result) => `${result.kind}: ${"error" in result ? result.error : "unavailable"}`);
    throw new Error(`No managed terminal host is available (${failures.join("; ")})`);
  }

  forTarget(target: HostTarget): TerminalHost {
    return this.requireHost(target.host);
  }

  private requireHost(kind: TerminalHostKind): TerminalHost {
    const host = this.hosts.get(kind);
    if (!host) throw new Error(`Terminal host ${kind} is not configured`);
    return host;
  }
}

async function detectNestedHost(
  executor: CommandExecutor = new ProcessCommandExecutor(),
): Promise<TerminalHostKind | undefined> {
  try {
    const [tmux, processTty] = await Promise.all([
      executor.exec("tmux", ["display-message", "-p", "#{pane_tty}"]),
      executor.exec("ps", ["-o", "tty=", "-p", String(process.pid)]),
    ]);
    const tmuxTty = normalizeTty(tmux.stdout);
    const currentTty = normalizeTty(processTty.stdout);
    if (!tmuxTty || !currentTty) return undefined;
    return tmuxTty === currentTty ? "tmux" : "cmux";
  } catch {
    return undefined;
  }
}

function normalizeTty(value: string): string | undefined {
  const tty = value.trim();
  if (!tty || tty === "??") return undefined;
  return tty.startsWith("/dev/") ? tty.slice(5) : tty;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
