import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import {
  allowedPairs,
  availableModelChoices,
  loadConfig,
  loadEffectiveConfig,
  resolveEffectiveConfig,
  saveConfig,
  validateMainOverrides,
  type DelegationPair,
  type HeishiConfig,
  type ModelChoice,
} from "./model-config.js";

const globalConfig: HeishiConfig = {
  mode: "sub",
  workspace: "shared",
  models: [{ model: "provider/global", thinking: "high" }],
  worktree: { cleanupApproval: "ask" },
};
const projectConfig: HeishiConfig = {
  mode: "main",
  models: [{ model: "provider/project", thinking: "medium" }],
  worktree: { cleanupApproval: "allow" },
};

describe("Heishi delegation model configuration", () => {
  it("overrides global settings field by field for trusted projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-config-"));
    try {
      const globalPath = join(root, "global.json");
      const projectPath = join(root, "project", "heishi.json");
      await saveConfig(globalPath, globalConfig);
      await saveConfig(projectPath, projectConfig);

      assert.deepEqual((await loadEffectiveConfig(globalPath, projectPath, true)).config, {
        mode: "main",
        workspace: "shared",
        models: projectConfig.models,
        cleanupApproval: "allow",
      });
      assert.deepEqual((await loadEffectiveConfig(globalPath, projectPath, false)).config, {
        mode: "sub",
        workspace: "shared",
        models: globalConfig.models,
        cleanupApproval: "ask",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to global configuration when a trusted project has no file", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-config-"));
    try {
      const globalPath = join(root, "global.json");
      await saveConfig(globalPath, globalConfig);

      const loaded = await loadEffectiveConfig(globalPath, join(root, "missing.json"), true);
      assert.deepEqual(loaded.config, {
        mode: "sub",
        workspace: "shared",
        models: globalConfig.models,
        cleanupApproval: "ask",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits missing project fields and defaults missing global fields", () => {
    assert.deepEqual(resolveEffectiveConfig({}, { workspace: "worktree" }), {
      mode: "sub",
      workspace: "worktree",
      models: [],
      cleanupApproval: "ask",
    });
    assert.deepEqual(resolveEffectiveConfig(globalConfig, { workspace: "worktree" }), {
      mode: "sub",
      workspace: "worktree",
      models: globalConfig.models,
      cleanupApproval: "ask",
    });
  });

  it("loads and saves partial scoped configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-config-"));
    try {
      const path = join(root, "heishi.json");
      const partial: HeishiConfig = { workspace: "worktree", worktree: { cleanupApproval: "allow" } };
      await saveConfig(path, partial);
      assert.deepEqual((await loadConfig(path)).config, partial);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only permits configured pairs that remain available and supported", () => {
    const choices: ModelChoice[] = [{ model: model("provider", "allowed"), levels: ["off", "high"] }];
    const config: { models: DelegationPair[] } = {
      models: [
        { model: "provider/allowed", thinking: "high" },
        { model: "provider/allowed", thinking: "max" },
        { model: "provider/missing", thinking: "off" },
      ],
    };

    assert.deepEqual(allowedPairs(config, choices), [
      { model: "provider/allowed", thinking: "high" },
    ]);
  });

  it("uses authenticated models and honors scoped thinking pins", () => {
    const authenticated = model("provider", "authenticated");
    const unavailable = model("provider", "unavailable");
    const scope: ScopedModel[] = [
      { model: authenticated, thinkingLevel: "high" },
      { model: unavailable, thinkingLevel: "high" },
    ];

    const choices = availableModelChoices([authenticated], scope);
    assert.equal(choices.length, 1);
    assert.equal(choices[0]?.model.id, "authenticated");
    assert.deepEqual(choices[0]?.levels, ["high"]);
  });

  it("omits scoped thinking pins the model cannot execute", () => {
    const nonReasoning = { ...model("provider", "plain"), reasoning: false };
    const scope: ScopedModel[] = [{ model: nonReasoning, thinkingLevel: "high" }];

    assert.deepEqual(availableModelChoices([nonReasoning], scope), []);
  });

  it("validates main overrides against every authenticated model without scoped filtering", () => {
    const authenticated = model("provider", "authenticated");

    assert.doesNotThrow(() => validateMainOverrides("provider/authenticated", "high", [authenticated]));
    assert.doesNotThrow(() => validateMainOverrides("provider/authenticated", undefined, [authenticated]));
    assert.doesNotThrow(() => validateMainOverrides(undefined, undefined, [authenticated]));
    assert.throws(() => validateMainOverrides(undefined, "high", [authenticated]), /requires an explicit model/u);
    assert.throws(() => validateMainOverrides("provider/missing", undefined, [authenticated]), /not authenticated/u);
  });

  it("rejects a main thinking level unsupported by the selected model", () => {
    const nonReasoning = { ...model("provider", "plain"), reasoning: false };

    assert.throws(
      () => validateMainOverrides("provider/plain", "high", [nonReasoning]),
      /does not support thinking high/u,
    );
  });
});

function model(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}
