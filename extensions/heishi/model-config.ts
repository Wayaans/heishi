import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { SettingsManager, type ModelRegistry, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type TerminalHostPreference, type ThinkingLevel } from "./terminal-host.js";
import type { WorkerMode, WorkspaceKind } from "./types.js";

export interface DelegationPair {
  model: string;
  thinking: ThinkingLevel;
}

export type CleanupApproval = "ask" | "allow";

export interface HeishiConfig {
  mode?: WorkerMode;
  workspace?: WorkspaceKind;
  terminalHost?: TerminalHostPreference;
  models?: DelegationPair[];
  worktree?: {
    cleanupApproval?: CleanupApproval;
  };
}

export interface EffectiveHeishiConfig {
  mode: WorkerMode;
  workspace: WorkspaceKind;
  terminalHost: TerminalHostPreference;
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
  terminalHost: "auto",
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
    terminalHost: project?.terminalHost ?? global.terminalHost ?? DEFAULT_CONFIG.terminalHost,
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

export function mainModelChoices(
  availableModels: readonly ModelChoice["model"][],
  scopedModels: readonly ScopedModel[],
): ModelChoice[] {
  // Main selection uses scope membership, not cycling's optional thinking pins.
  const references = new Set(scopedModels.map(({ model }) => modelReference(model)));
  return availableModelChoices(availableModels.filter((model) => references.has(modelReference(model))), []);
}

export function savedMainDefaults(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
  choices: readonly ModelChoice[],
): { pair: DelegationPair } | { error: string } {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  if (settings.drainErrors().length > 0) return { error: "Cannot read saved worker model settings" };
  if (choices.length === 0) return { error: "No authenticated models in the current session scope; ordinary main selection is unavailable" };
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  if (!provider || !id) return { error: "Saved worker default provider/model is not configured" };
  const model = `${provider}/${id}`;
  const choice = choices.find((candidate) => modelReference(candidate.model) === model);
  if (!choice) return { error: "Saved worker default model is not in the current authenticated session scope" };

  // Newer Pi versions support per-model defaults. Read their data without requiring a newer SDK getter.
  let thinking: unknown = settings.getDefaultThinkingLevel();
  for (const source of [settings.getGlobalSettings(), ...(projectTrusted ? [settings.getProjectSettings()] : [])]) {
    if (!("modelThinkingLevels" in source)) continue;
    const levels = source.modelThinkingLevels;
    if (!isRecord(levels)) return { error: "Saved worker per-model thinking settings are invalid" };
    if (model in levels) thinking = levels[model];
  }
  if (!isThinkingLevel(thinking)) return { error: "Saved worker default thinking level is missing or invalid" };
  if (!choice.levels.includes(thinking)) return { error: "Saved worker default thinking level is unsupported by its model" };
  return { pair: { model, thinking } };
}

export function userRequestedModelChoice(reference: string, registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">): ModelChoice {
  const separator = reference.indexOf("/");
  const model = separator > 0 ? registry.find(reference.slice(0, separator), reference.slice(separator + 1)) : undefined;
  if (!model || !registry.hasConfiguredAuth(model)) throw new Error(`User-requested main model is not authenticated: ${reference}`);
  return { model, levels: getSupportedThinkingLevels(model) };
}

export function validateMainSelection(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  choices: readonly ModelChoice[],
  userRequestedModel?: ModelChoice,
): void {
  if (!model?.trim() || thinking === undefined) throw new Error("Main mode requires an explicit model and thinking level");
  const selected = userRequestedModel ?? choices.find((choice) => modelReference(choice.model) === model);
  if (!selected || modelReference(selected.model) !== model) {
    throw new Error(choices.length === 0
      ? "No authenticated models in the current session scope; ordinary main selection is unavailable"
      : `Main-agent model is outside the current authenticated session scope: ${model}`);
  }
  if (!selected.levels.includes(thinking)) {
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

  const terminalHost = value["terminalHost"];
  if (terminalHost !== undefined) {
    if (terminalHost !== "auto" && terminalHost !== "tmux" && terminalHost !== "cmux") {
      throw new Error("terminalHost must be auto, tmux, or cmux");
    }
    config.terminalHost = terminalHost;
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
