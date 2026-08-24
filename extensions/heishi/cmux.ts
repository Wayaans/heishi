import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessCommandExecutor, type CommandExecutor } from "./command-executor.js";
import {
  isUuid,
  type CmuxHostTarget,
  type HostLaunch,
  type HostTarget,
  type TerminalHost,
} from "./terminal-host.js";
import { shellQuote } from "./worker-command.js";

const REQUIRED_METHODS = [
  "surface.split",
  "surface.create",
  "surface.list",
  "surface.focus",
  "surface.close",
  "window.focus",
  "workspace.create",
  "workspace.list",
  "workspace.select",
  "workspace.close",
  "workspace.group.list",
  "workspace.group.delete",
] as const;
const DEDICATED_WORKSPACE_TITLE = "Heishi subagents";
const processCommandExecutor = new ProcessCommandExecutor();
const managedWorkspaces = new WeakMap<CommandExecutor, Map<string, ManagedWorkspace>>();

interface CmuxContext {
  cliPath: string;
  socketPath: string;
  windowId: string;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

interface ManagedWorkspace {
  workspaceId: string | undefined;
  topologyOperation: Promise<void>;
}

export class Cmux implements TerminalHost {
  readonly kind = "cmux" as const;
  private context?: CmuxContext;

  constructor(
    private readonly executor: CommandExecutor = processCommandExecutor,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async validate(): Promise<void> {
    const socketHint = this.environment["CMUX_SOCKET_PATH"];
    if (!socketHint || !this.environment["CMUX_WORKSPACE_ID"] || !this.environment["CMUX_SURFACE_ID"]) {
      throw new Error("Subagents can only use cmux from a cmux caller terminal");
    }
    const cliPath = this.cliPath();
    const identifyArgs = [
      ...(socketHint ? ["--socket", socketHint] : []),
      "identify", "--json", "--id-format", "uuids",
    ];
    let identify: unknown;
    try {
      identify = parseJson((await this.executor.exec(cliPath, identifyArgs)).stdout, "cmux identify");
    } catch (error) {
      throw new Error(`cmux caller context is unavailable: ${errorMessage(error)}`);
    }
    const record = requireRecord(identify, "cmux identify");
    const caller = requireRecord(record["caller"], "cmux identify caller");
    const socketPath = requireString(record["socket_path"], "cmux socket path");
    const context: CmuxContext = {
      cliPath,
      socketPath,
      windowId: requireUuid(caller["window_id"], "cmux caller window ID"),
      workspaceId: requireUuid(caller["workspace_id"], "cmux caller workspace ID"),
      paneId: requireUuid(caller["pane_id"], "cmux caller pane ID"),
      surfaceId: requireUuid(caller["surface_id"], "cmux caller surface ID"),
    };
    const expectedWorkspaceId = requireUuid(this.environment["CMUX_WORKSPACE_ID"], "CMUX_WORKSPACE_ID");
    const expectedSurfaceId = requireUuid(this.environment["CMUX_SURFACE_ID"], "CMUX_SURFACE_ID");
    if (!uuidsEqual(context.workspaceId, expectedWorkspaceId)
      || !uuidsEqual(context.surfaceId, expectedSurfaceId)) {
      throw new Error("cmux identify did not confirm the caller terminal");
    }

    let capabilities: unknown;
    try {
      capabilities = parseJson((await this.executor.exec(cliPath, ["--socket", socketPath, "capabilities"])).stdout, "cmux capabilities");
    } catch (error) {
      throw new Error(`cmux capabilities are unavailable: ${errorMessage(error)}`);
    }
    const methods = requireStringArray(requireRecord(capabilities, "cmux capabilities")["methods"], "cmux methods");
    const missing = REQUIRED_METHODS.filter((method) => !methods.includes(method));
    if (missing.length > 0) throw new Error(`cmux is missing required methods: ${missing.join(", ")}`);
    this.context = context;
    managedWorkspaceFor(this.executor, context);
  }

  async launch(spec: HostLaunch): Promise<CmuxHostTarget> {
    if (spec.command.length === 0) throw new Error("Subagent command is empty");
    const context = this.requireContext();
    const launcherPath = await createLauncher(spec);
    const surfaceCommand = shellQuote(launcherPath);
    const workspaceCommand = `exec ${surfaceCommand}`;
    try {
      if (spec.placement === "pane") {
        const result = await this.rpc(context, "surface.split", {
          workspace_id: context.workspaceId,
          surface_id: context.surfaceId,
          direction: "right",
          working_directory: spec.cwd,
          initial_command: shellQuote(launcherPath),
          focus: false,
        });
        const surfaceId = requireUuid(result["surface_id"], "cmux split surface ID");
        try {
          return {
            host: "cmux",
            windowId: requireMatchingUuid(result["window_id"], "cmux split window ID", context.windowId),
            workspaceId: requireMatchingUuid(
              result["workspace_id"],
              "cmux split workspace ID",
              context.workspaceId,
            ),
            paneId: requireUuid(result["pane_id"], "cmux split pane ID"),
            surfaceId,
            socketPath: context.socketPath,
            closeKind: "surface",
          };
        } catch (error) {
          return this.rollbackAfterFailure(
            context,
            "surface.close",
            { surface_id: surfaceId },
            error,
          );
        }
      }
      return spec.placement === "session"
        ? await this.launchInDedicatedWorkspace(context, spec, surfaceCommand, workspaceCommand)
        : await this.createSurface(
            context,
            context.workspaceId,
            context.paneId,
            spec,
            surfaceCommand,
            false,
          );
    } catch (error) {
      await rm(launcherPath, { force: true });
      throw error;
    }
  }

  async exists(target: HostTarget): Promise<boolean> {
    const cmux = requireCmuxTarget(target);
    const context = this.contextForTarget(cmux);
    if (cmux.closeKind === "surface") {
      try {
        const result = await this.rpc(context, "surface.list", { workspace_id: cmux.workspaceId });
        return requireArray(result["surfaces"], "cmux surfaces").some((surface) => {
          return isRecord(surface)
            && typeof surface["id"] === "string"
            && uuidsEqual(surface["id"], cmux.surfaceId);
        });
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    }
    try {
      const result = await this.rpc(context, "workspace.list", { window_id: cmux.windowId });
      return requireArray(result["workspaces"], "cmux workspaces").some((workspace) => {
        return isRecord(workspace)
          && typeof workspace["id"] === "string"
          && uuidsEqual(workspace["id"], cmux.workspaceId);
      });
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async focus(target: HostTarget): Promise<void> {
    const cmux = requireCmuxTarget(target);
    const context = this.contextForTarget(cmux);
    await this.rpc(context, "window.focus", { window_id: cmux.windowId });
    await this.rpc(context, "workspace.select", { window_id: cmux.windowId, workspace_id: cmux.workspaceId });
    await this.rpc(context, "surface.focus", { workspace_id: cmux.workspaceId, surface_id: cmux.surfaceId });
  }

  async close(target: HostTarget): Promise<void> {
    const cmux = requireCmuxTarget(target);
    const context = this.contextForTarget(cmux);
    if (cmux.dedicatedWorkspace) {
      await this.closeDedicatedSurface(context, cmux);
      return;
    }
    const method = cmux.closeKind === "surface" ? "surface.close" : "workspace.close";
    const params = cmux.closeKind === "surface"
      ? { surface_id: cmux.surfaceId }
      : { workspace_id: cmux.workspaceId };
    try {
      await this.rpc(context, method, params);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (cmux.closeKind === "workspace" && cmux.groupId && cmux.groupAnchorWorkspaceId) {
      await this.removeEmptyLegacySessionGroup(context, cmux.groupId, cmux.groupAnchorWorkspaceId);
    }
  }

  private async createWorkspace(
    context: CmuxContext,
    spec: HostLaunch,
    initialCommand: string,
    groupId?: string,
  ): Promise<CmuxHostTarget> {
    const result = await this.rpc(context, "workspace.create", {
      window_id: context.windowId,
      title: spec.title,
      cwd: spec.cwd,
      initial_command: initialCommand,
      focus: false,
      ...(groupId ? { group_id: groupId } : {}),
    });
    const workspaceId = requireUuid(result["workspace_id"], "cmux workspace ID");
    try {
      const surfaceId = requireUuid(result["surface_id"], "cmux workspace surface ID");
      const windowId = requireMatchingUuid(result["window_id"], "cmux workspace window ID", context.windowId);
      const listed = await this.rpc(context, "surface.list", { workspace_id: workspaceId });
      const surface = requireArray(listed["surfaces"], "cmux surfaces").find((candidate) => {
        return isRecord(candidate)
          && typeof candidate["id"] === "string"
          && uuidsEqual(candidate["id"], surfaceId);
      });
      if (!isRecord(surface)) throw new Error("cmux did not list the created surface");
      return {
        host: "cmux",
        windowId,
        workspaceId,
        paneId: requireUuid(surface["pane_id"], "cmux workspace pane ID"),
        surfaceId,
        socketPath: context.socketPath,
        closeKind: "workspace",
      };
    } catch (error) {
      return this.rollbackAfterFailure(
        context,
        "workspace.close",
        { workspace_id: workspaceId },
        error,
      );
    }
  }

  private launchInDedicatedWorkspace(
    context: CmuxContext,
    spec: HostLaunch,
    surfaceCommand: string,
    workspaceCommand: string,
  ): Promise<CmuxHostTarget> {
    return this.withTopologyLock(context, async () => {
      const managedWorkspace = this.managedWorkspace(context);
      const workspaceId = managedWorkspace.workspaceId;
      if (workspaceId) {
        try {
          const surfaces = await this.listSurfaces(context, workspaceId);
          const first = surfaces[0];
          if (first) {
            return await this.createSurface(
              context,
              workspaceId,
              requireUuid(first["pane_id"], "cmux dedicated workspace pane ID"),
              spec,
              surfaceCommand,
              true,
            );
          }
          try {
            await this.rpc(context, "workspace.close", { workspace_id: workspaceId });
          } catch (error) {
            if (!isNotFound(error)) {
              throw new Error(
                `cmux could not close the empty dedicated workspace before recreation: ${errorMessage(error)}`,
              );
            }
          }
          managedWorkspace.workspaceId = undefined;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          managedWorkspace.workspaceId = undefined;
        }
      }
      return this.createDedicatedWorkspace(context, spec, workspaceCommand);
    });
  }

  private async createDedicatedWorkspace(
    context: CmuxContext,
    spec: HostLaunch,
    initialCommand: string,
  ): Promise<CmuxHostTarget> {
    const target = await this.createWorkspace(
      context,
      { ...spec, title: DEDICATED_WORKSPACE_TITLE },
      initialCommand,
    );
    this.managedWorkspace(context).workspaceId = target.workspaceId;
    return { ...target, closeKind: "surface", dedicatedWorkspace: true };
  }

  private async createSurface(
    context: CmuxContext,
    workspaceId: string,
    paneId: string,
    spec: HostLaunch,
    initialCommand: string,
    dedicatedWorkspace: boolean,
  ): Promise<CmuxHostTarget> {
    const result = await this.rpc(context, "surface.create", {
      workspace_id: workspaceId,
      pane_id: paneId,
      working_directory: spec.cwd,
      initial_command: initialCommand,
      focus: false,
    });
    const surfaceId = requireUuid(result["surface_id"], "cmux surface ID");
    try {
      return {
        host: "cmux",
        windowId: requireMatchingUuid(result["window_id"], "cmux surface window ID", context.windowId),
        workspaceId: requireMatchingUuid(result["workspace_id"], "cmux surface workspace ID", workspaceId),
        paneId: requireMatchingUuid(result["pane_id"], "cmux surface pane ID", paneId),
        surfaceId,
        socketPath: context.socketPath,
        closeKind: "surface",
        ...(dedicatedWorkspace ? { dedicatedWorkspace: true } : {}),
      };
    } catch (error) {
      return this.rollbackAfterFailure(
        context,
        "surface.close",
        { surface_id: surfaceId },
        error,
      );
    }
  }

  private async rollbackAfterFailure(
    context: CmuxContext,
    method: "surface.close" | "workspace.close",
    params: Record<string, unknown>,
    primaryError: unknown,
  ): Promise<never> {
    try {
      await this.rpc(context, method, params);
    } catch (rollbackError) {
      if (!isNotFound(rollbackError)) {
        throw new Error(
          `${errorMessage(primaryError)}; cmux rollback via ${method} also failed: ${errorMessage(rollbackError)}`,
          { cause: primaryError },
        );
      }
    }
    throw primaryError;
  }

  private async closeDedicatedSurface(context: CmuxContext, target: CmuxHostTarget): Promise<void> {
    await this.withTopologyLock(context, async () => {
      let surfaces: Array<Record<string, unknown>>;
      try {
        surfaces = await this.listSurfaces(context, target.workspaceId);
      } catch (error) {
        if (isNotFound(error)) {
          this.clearManagedWorkspace(context, target.workspaceId);
          return;
        }
        throw error;
      }
      if (surfaces.length === 0) {
        try {
          await this.rpc(context, "workspace.close", { workspace_id: target.workspaceId });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        this.clearManagedWorkspace(context, target.workspaceId);
        return;
      }
      if (!surfaces.some((surface) => {
        return typeof surface["id"] === "string" && uuidsEqual(surface["id"], target.surfaceId);
      })) return;
      if (surfaces.length === 1) {
        try {
          await this.rpc(context, "workspace.close", { workspace_id: target.workspaceId });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        this.clearManagedWorkspace(context, target.workspaceId);
        return;
      }
      try {
        await this.rpc(context, "surface.close", { surface_id: target.surfaceId });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    });
  }

  private async listSurfaces(
    context: CmuxContext,
    workspaceId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const listed = await this.rpc(context, "surface.list", { workspace_id: workspaceId });
    return requireArray(listed["surfaces"], "cmux surfaces").map((surface) => {
      return requireRecord(surface, "cmux surface");
    });
  }

  private async removeEmptyLegacySessionGroup(
    context: CmuxContext,
    groupId: string,
    anchorWorkspaceId: string,
  ): Promise<void> {
    await this.withTopologyLock(context, async () => {
      let groups: Array<Record<string, unknown>>;
      try {
        groups = await this.listGroups(context);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      const group = groups.find((candidate) => {
        return typeof candidate["id"] === "string" && uuidsEqual(candidate["id"], groupId);
      });
      if (!group) return;
      const members = requireStringArray(group["member_workspace_ids"], "cmux workspace group members");
      const member = members[0];
      if (members.length !== 1 || !member || !uuidsEqual(member, anchorWorkspaceId)) return;
      try {
        await this.rpc(context, "workspace.group.delete", {
          window_id: context.windowId,
          group_id: groupId,
          close_workspaces: true,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    });
  }

  private async listGroups(context: CmuxContext): Promise<Array<Record<string, unknown>>> {
    const result = await this.rpc(context, "workspace.group.list", { window_id: context.windowId });
    return requireArray(result["groups"], "cmux workspace groups").map((group) => {
      return requireRecord(group, "cmux workspace group");
    });
  }

  private async withTopologyLock<T>(context: CmuxContext, operation: () => Promise<T>): Promise<T> {
    const managedWorkspace = this.managedWorkspace(context);
    const previous = managedWorkspace.topologyOperation;
    let release = (): void => {};
    managedWorkspace.topologyOperation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async rpc(
    context: Pick<CmuxContext, "cliPath" | "socketPath">,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.executor.exec(context.cliPath, [
        "--socket", context.socketPath, "--id-format", "uuids", "rpc", method, JSON.stringify(params),
      ]);
      return requireRecord(parseJson(result.stdout, `cmux ${method}`), `cmux ${method}`);
    } catch (error) {
      throw new Error(`cmux ${method} failed: ${errorMessage(error)}`);
    }
  }

  private requireContext(): CmuxContext {
    if (!this.context) throw new Error("cmux must be validated before launch");
    return this.context;
  }

  private managedWorkspace(context: CmuxContext): ManagedWorkspace {
    return managedWorkspaceFor(this.executor, context);
  }

  private clearManagedWorkspace(context: CmuxContext, workspaceId: string): void {
    const managedWorkspace = this.managedWorkspace(context);
    if (managedWorkspace.workspaceId && uuidsEqual(managedWorkspace.workspaceId, workspaceId)) {
      managedWorkspace.workspaceId = undefined;
    }
  }

  private contextForTarget(target: CmuxHostTarget): CmuxContext {
    const current = this.context;
    return {
      cliPath: current?.cliPath ?? this.cliPath(),
      socketPath: target.socketPath,
      windowId: target.windowId,
      workspaceId: target.workspaceId,
      paneId: target.paneId,
      surfaceId: target.surfaceId,
    };
  }

  private cliPath(): string {
    const bundled = this.environment["CMUX_BUNDLED_CLI_PATH"];
    return bundled && existsSync(bundled) ? bundled : "cmux";
  }
}

function managedWorkspaceFor(executor: CommandExecutor, context: CmuxContext): ManagedWorkspace {
  let byContext = managedWorkspaces.get(executor);
  if (!byContext) {
    byContext = new Map();
    managedWorkspaces.set(executor, byContext);
  }
  const key = `${context.cliPath}\0${context.socketPath}\0${context.windowId.toLowerCase()}`;
  let managedWorkspace = byContext.get(key);
  if (!managedWorkspace) {
    managedWorkspace = { workspaceId: undefined, topologyOperation: Promise.resolve() };
    byContext.set(key, managedWorkspace);
  }
  return managedWorkspace;
}

async function createLauncher(spec: HostLaunch): Promise<string> {
  const path = join(spec.launcherDirectory, `launch-${randomUUID()}.sh`);
  const exports = {
    ...spec.environment,
    CMUX_PI_HOOKS_DISABLED: "1",
  };
  const lines = [
    "#!/bin/sh",
    `rm -f -- ${shellQuote(path)}`,
    ...Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `exec ${spec.command.map(shellQuote).join(" ")}`,
    "",
  ];
  await writeFile(path, lines.join("\n"), { encoding: "utf8", mode: 0o700 });
  return path;
}

function requireCmuxTarget(target: HostTarget): CmuxHostTarget {
  if (target.host !== "cmux") throw new Error("Cmux host received a tmux target");
  return target;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} returned malformed JSON`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned malformed JSON`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  const values = requireArray(value, label);
  if (!values.every((item) => typeof item === "string")) throw new Error(`${label} returned malformed JSON`);
  return values;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function requireUuid(value: unknown, label: string): string {
  const uuid = requireString(value, label);
  if (!isUuid(uuid)) throw new Error(`${label} is invalid: ${uuid}`);
  return uuid;
}

function requireMatchingUuid(value: unknown, label: string, expected: string): string {
  const uuid = requireUuid(value, label);
  if (!uuidsEqual(uuid, expected)) {
    throw new Error(`${label} does not match the requested context`);
  }
  return uuid;
}

function uuidsEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return /not[_ ]found|does not exist/iu.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
