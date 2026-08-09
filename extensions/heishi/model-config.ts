import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "./tmux.js";

export interface DelegationPair {
  model: string;
  thinking: ThinkingLevel;
}

export interface DelegationConfig {
  models: DelegationPair[];
}

export interface ModelChoice {
  model: Model<any>;
  levels: ThinkingLevel[];
}

export interface LoadedConfig {
  config: DelegationConfig;
  exists: boolean;
  error?: string;
}

const THINKING_LEVEL_SET = new Set<ThinkingLevel>(THINKING_LEVELS);

export async function loadConfig(path: string): Promise<LoadedConfig> {
  if (!existsSync(path)) return { config: { models: [] }, exists: false };

  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return { config: parseConfig(parsed), exists: true };
  } catch (error) {
    return {
      config: { models: [] },
      exists: true,
      error: `Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadEffectiveConfig(
  globalPath: string,
  projectPath: string,
  projectTrusted: boolean,
): Promise<LoadedConfig> {
  if (projectTrusted) {
    const project = await loadConfig(projectPath);
    if (project.exists) return project;
  }
  return loadConfig(globalPath);
}

export async function saveConfig(path: string, config: DelegationConfig): Promise<void> {
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

export function allowedPairs(config: DelegationConfig, choices: readonly ModelChoice[]): DelegationPair[] {
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

function parseConfig(value: unknown): DelegationConfig {
  if (!isRecord(value) || !Array.isArray(value["models"])) {
    throw new Error("expected an object with a models array");
  }

  const models: DelegationPair[] = [];
  const seen = new Set<string>();
  for (const entry of value["models"]) {
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
  return { models };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value as ThinkingLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
