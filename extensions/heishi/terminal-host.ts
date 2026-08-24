export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type Placement = "pane" | "window" | "session";
export type TerminalHostKind = "tmux" | "cmux";
export type TerminalHostPreference = "auto" | TerminalHostKind;

export interface HostLaunch {
  placement: Placement;
  sessionName?: string;
  cwd: string;
  title: string;
  command: string[];
  environment: Record<string, string>;
  launcherDirectory: string;
}

export interface TmuxHostTarget {
  host: "tmux";
  paneId: string;
  windowId?: string;
  sessionId?: string;
  socketPath?: string;
}

export interface CmuxHostTarget {
  host: "cmux";
  surfaceId: string;
  paneId: string;
  workspaceId: string;
  windowId: string;
  socketPath: string;
  closeKind: "surface" | "workspace";
  groupId?: string;
  groupAnchorWorkspaceId?: string;
  dedicatedWorkspace?: boolean;
}

export type HostTarget = TmuxHostTarget | CmuxHostTarget;

export interface TerminalHost {
  readonly kind: TerminalHostKind;
  validate(): Promise<void>;
  launch(spec: HostLaunch): Promise<HostTarget>;
  exists(target: HostTarget): Promise<boolean>;
  focus(target: HostTarget): Promise<void>;
  close(target: HostTarget): Promise<void>;
}

export interface TerminalHosts {
  resolve(preference: TerminalHostPreference): Promise<TerminalHost>;
  forTarget(target: HostTarget): TerminalHost;
}

export function terminalTargetLabel(target: HostTarget): string {
  const id = target.host === "tmux"
    ? target.paneId
    : target.closeKind === "surface"
      ? target.surfaceId
      : target.workspaceId;
  return `${target.host} ${id}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function tmuxHostTarget(
  target: { paneId: string; windowId: string; sessionId: string },
  socketPath?: string,
): TmuxHostTarget {
  return {
    host: "tmux",
    paneId: target.paneId,
    windowId: target.windowId,
    sessionId: target.sessionId,
    ...(socketPath ? { socketPath } : {}),
  };
}
