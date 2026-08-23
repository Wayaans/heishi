import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "./tmux.js";
import type { WorkerMode, WorkspaceKind } from "./types.js";

export interface DelegationPair {
  model: string;
  thinking: ThinkingLevel;
}

export type CleanupApproval = "ask" | "allow";

export interface HeishiConfig {
  mode?: WorkerMode;
  workspace?: WorkspaceKind;
  models?: DelegationPair[];
  worktree?: {
    cleanupApproval?: CleanupApproval;
  };
}

export interface EffectiveHeishiConfig {
  mode: WorkerMode;
  workspace: WorkspaceKind;
  models: DelegationPair[];
  cleanupApproval: CleanupApproval;
}

export interface ModelChoice {
  model: Model<any>;
  levels: ThinkingLevel[];
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

const THINKING_LEVEL_SET = new Set<ThinkingLevel>(THINKING_LEVELS);
const DEFAULT_CONFIG: EffectiveHeishiConfig = {
  mode: "sub",
  workspace: "shared",
  models: [],
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
    models: [...(project?.models ?? global.models ?? DEFAULT_CONFIG.models)],
    cleanupApproval: project?.worktree?.cleanupApproval
      ?? global.worktree?.cleanupApproval
      ?? DEFAULT_CONFIG.cleanupApproval,
  };
}

export async function saveConfig(path: string, config: HeishiConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function availableModelChoices(
  availableModels: readonly Model<any>[],
  scopedModels: readonly ScopedModel[],
): ModelChoice[] {
  const availableReferences = new Set(availableModels.map(modelReference));
  const choices = scopedModels.length > 0
    ? scopedModels
        .filter(({ model }) => availableReferences.has(modelReference(model)))
        .map(({ model, thinkingLevel }) => {
          const supported = getSupportedThinkingLevels(model);
          return {
            model,
            levels: thinkingLevel && supported.includes(thinkingLevel) ? [thinkingLevel] : thinkingLevel ? [] : supported,
          };
        })
    : availableModels.map((model) => ({ model, levels: getSupportedThinkingLevels(model) }));

  return choices
    .filter(({ levels }) => levels.length > 0)
    .map(({ model, levels }) => ({ model, levels: levels as ThinkingLevel[] }))
    .sort((left, right) => modelReference(left.model).localeCompare(modelReference(right.model)));
}

export function allowedPairs(config: Pick<EffectiveHeishiConfig, "models">, choices: readonly ModelChoice[]): DelegationPair[] {
  const valid = new Map(choices.map((choice) => [modelReference(choice.model), new Set(choice.levels)]));
  return config.models.filter((pair) => valid.get(pair.model)?.has(pair.thinking) === true);
}

export function modelReference(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function validateMainOverrides(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  availableModels: readonly Model<any>[],
): void {
  if (thinking && !model) throw new Error("Main-agent thinking requires an explicit model");
  if (!model) return;

  const selected = availableModels.find((candidate) => modelReference(candidate) === model);
  if (!selected) throw new Error(`Main-agent model is not authenticated: ${model}`);
  if (thinking && !getSupportedThinkingLevels(selected).includes(thinking)) {
    throw new Error(`Main-agent model ${model} does not support thinking ${thinking}`);
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

  const modelEntries = value["models"];
  if (modelEntries !== undefined) config.models = parseModels(modelEntries);

  const worktree = value["worktree"];
  if (worktree !== undefined) config.worktree = parseWorktreeConfig(worktree);
  return config;
}

function parseModels(value: unknown): DelegationPair[] {
  if (!Array.isArray(value)) throw new Error("models must be an array");

  const models: DelegationPair[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["model"] !== "string" || !isThinkingLevel(entry["thinking"])) {
      throw new Error("every model entry must contain a model string and valid thinking level");
    }
    const pair = { model: entry["model"], thinking: entry["thinking"] };
    const key = `${pair.model}\u0000${pair.thinking}`;
    if (!seen.has(key)) {
      seen.add(key);
      models.push(pair);
    }
  }
  return models;
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

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value as ThinkingLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
