import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { TerminalHostPreference, ThinkingLevel } from "./terminal-host.js";
import type { WorkerMode, WorkspaceKind } from "./types.js";

export type CleanupApproval = "ask" | "allow";

export interface HeishiConfig {
  mode?: WorkerMode;
  workspace?: WorkspaceKind;
  terminalHost?: TerminalHostPreference;
  worktree?: {
    cleanupApproval?: CleanupApproval;
  };
}

export interface EffectiveHeishiConfig {
  mode: WorkerMode;
  workspace: WorkspaceKind;
  terminalHost: TerminalHostPreference;
  cleanupApproval: CleanupApproval;
}

export interface LoadedConfig {
  config: HeishiConfig;
  exists: boolean;
  error?: string;
}

export interface LoadedEffectiveConfig {
  config: EffectiveHeishiConfig;
  error?: string;
}

const DEFAULT_CONFIG: EffectiveHeishiConfig = {
  mode: "sub",
  workspace: "shared",
  terminalHost: "auto",
  cleanupApproval: "ask",
};

export async function loadConfig(path: string): Promise<LoadedConfig> {
  if (!existsSync(path)) return { config: {}, exists: false };

  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return { config: parseConfig(parsed), exists: true };
  } catch (error) {
    return {
      config: {},
      exists: true,
      error: `Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadEffectiveConfig(
  globalPath: string,
  projectPath: string,
  projectTrusted: boolean,
): Promise<LoadedEffectiveConfig> {
  const global = await loadConfig(globalPath);
  const project = projectTrusted ? await loadConfig(projectPath) : undefined;
  const errors = [global.error, project?.error].filter((error): error is string => error !== undefined);
  const loaded: LoadedEffectiveConfig = {
    config: resolveEffectiveConfig(global.config, project?.config),
  };
  if (errors.length > 0) loaded.error = errors.join("\n");
  return loaded;
}

export function resolveEffectiveConfig(
  global: HeishiConfig,
  project?: HeishiConfig,
): EffectiveHeishiConfig {
  return {
    mode: project?.mode ?? global.mode ?? DEFAULT_CONFIG.mode,
    workspace: project?.workspace ?? global.workspace ?? DEFAULT_CONFIG.workspace,
    terminalHost: project?.terminalHost ?? global.terminalHost ?? DEFAULT_CONFIG.terminalHost,
    cleanupApproval: project?.worktree?.cleanupApproval
      ?? global.worktree?.cleanupApproval
      ?? DEFAULT_CONFIG.cleanupApproval,
  };
}

export async function saveConfig(path: string, config: HeishiConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Checks an explicitly requested worker model; omitted values let the worker use Pi's defaults. */
export function validateRequestedModel(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
): void {
  if (model === undefined) return;
  const separator = model.indexOf("/");
  const found = separator > 0 ? registry.find(model.slice(0, separator), model.slice(separator + 1)) : undefined;
  if (!found || !registry.hasConfiguredAuth(found)) {
    throw new Error(`Requested worker model is not available or authenticated: ${model}`);
  }
  if (thinking !== undefined && !getSupportedThinkingLevels(found).includes(thinking)) {
    throw new Error(`Requested worker model ${model} does not support thinking ${thinking}`);
  }
}

function parseConfig(value: unknown): HeishiConfig {
  if (!isRecord(value)) throw new Error("expected an object");

  const config: HeishiConfig = {};
  const mode = value["mode"];
  if (mode !== undefined) {
    if (mode !== "sub" && mode !== "main") throw new Error("mode must be sub or main");
    config.mode = mode;
  }

  const workspace = value["workspace"];
  if (workspace !== undefined) {
    if (workspace !== "shared" && workspace !== "worktree") {
      throw new Error("workspace must be shared or worktree");
    }
    config.workspace = workspace;
  }

  const terminalHost = value["terminalHost"];
  if (terminalHost !== undefined) {
    if (terminalHost !== "auto" && terminalHost !== "tmux" && terminalHost !== "cmux" && terminalHost !== "headless") {
      throw new Error("terminalHost must be auto, tmux, cmux, or headless");
    }
    config.terminalHost = terminalHost;
  }

  const worktree = value["worktree"];
  if (worktree !== undefined) config.worktree = parseWorktreeConfig(worktree);
  return config;
}

function parseWorktreeConfig(value: unknown): NonNullable<HeishiConfig["worktree"]> {
  if (!isRecord(value)) throw new Error("worktree must be an object");
  const cleanupApproval = value["cleanupApproval"];
  if (cleanupApproval === undefined) return {};
  if (cleanupApproval !== "ask" && cleanupApproval !== "allow") {
    throw new Error("worktree.cleanupApproval must be ask or allow");
  }
  return { cleanupApproval };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
