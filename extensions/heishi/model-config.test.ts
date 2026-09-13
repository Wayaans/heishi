import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ScopedModel } from "@earendil-works/pi-coding-agent";
import {
  allowedPairs,
  availableModelChoices,
  loadConfig,
  loadEffectiveConfig,
  resolveEffectiveConfig,
  saveConfig,
  mainModelChoices,
  savedMainDefaults,
  userRequestedModelChoice,
  validateMainSelection,
  type DelegationPair,
  type HeishiConfig,
  type ModelChoice,
} from "./model-config.js";

const globalConfig: HeishiConfig = {
  mode: "sub",
  workspace: "shared",
  terminalHost: "tmux",
  models: [{ model: "provider/global", thinking: "high" }],
  worktree: { cleanupApproval: "ask" },
};
const projectConfig: HeishiConfig = {
  mode: "main",
  terminalHost: "cmux",
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
        terminalHost: "cmux",
        models: projectConfig.models,
        cleanupApproval: "allow",
      });
      assert.deepEqual((await loadEffectiveConfig(globalPath, projectPath, false)).config, {
        mode: "sub",
        workspace: "shared",
        terminalHost: "tmux",
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
        terminalHost: "tmux",
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
      terminalHost: "auto",
      models: [],
      cleanupApproval: "ask",
    });
    assert.deepEqual(resolveEffectiveConfig(globalConfig, { workspace: "worktree" }), {
      mode: "sub",
      workspace: "worktree",
      terminalHost: "tmux",
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

  it("lists only authenticated main scope members with all supported levels, without broadening empty scopes", () => {
    const scoped = model("provider", "scoped");
    const outside = model("provider", "outside");
    const choices = mainModelChoices([scoped, outside], [{ model: scoped, thinkingLevel: "high" }, { model: model("provider", "missing") }]);
    assert.equal(choices.length, 1);
    assert.equal(choices[0]?.model.id, "scoped");
    assert.ok(choices[0]?.levels.includes("medium"));
    assert.deepEqual(mainModelChoices([scoped, outside], []), []);
    // Preserve sub's existing unrestricted-scope behavior.
    assert.equal(availableModelChoices([scoped, outside], []).length, 2);
  });

  it("requires an explicit main pair and keeps ordinary selection within scope", () => {
    const choices = mainModelChoices([model("provider", "scoped")], [{ model: model("provider", "scoped") }]);
    assert.doesNotThrow(() => validateMainSelection("provider/scoped", "high", choices));
    assert.throws(() => validateMainSelection("provider/scoped", undefined, choices), /requires an explicit model and thinking level/u);
    assert.throws(() => validateMainSelection(undefined, "high", choices), /requires an explicit model and thinking level/u);
    assert.throws(() => validateMainSelection("provider/outside", "high", choices), /outside the current authenticated session scope/u);
    assert.throws(() => validateMainSelection("provider/scoped", "high", []), /No authenticated models in the current session scope/u);
  });

  it("validates only the exact user-requested model and never substitutes unsupported thinking", () => {
    const requested = { ...model("provider", "nested/plain"), reasoning: false };
    const lookups: string[] = [];
    const registry = {
      find(provider: string, id: string) {
        lookups.push(`${provider}/${id}`);
        return provider === requested.provider && id === requested.id ? requested : undefined;
      },
      hasConfiguredAuth: () => true,
    };
    const choice = userRequestedModelChoice("provider/nested/plain", registry);
    assert.deepEqual(lookups, ["provider/nested/plain"]);
    assert.doesNotThrow(() => validateMainSelection("provider/nested/plain", "off", [], choice));
    assert.throws(() => validateMainSelection("provider/nested/plain", "high", [], choice), /does not support thinking high/u);
    assert.throws(() => userRequestedModelChoice("provider/missing", registry), /not authenticated/u);
    assert.throws(() => userRequestedModelChoice("provider/nested/plain", { ...registry, hasConfiguredAuth: () => false }), /not authenticated/u);
  });

  it("resolves saved worker defaults with trusted project precedence and per-model thinking", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-main-defaults-"));
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await mkdir(agentDir);
      await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "provider", defaultModel: "global", defaultThinkingLevel: "low",
        modelThinkingLevels: { "provider/global": "medium", "provider/project": "medium" },
      }));
      await writeFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
        defaultModel: "project", defaultThinkingLevel: "high",
        modelThinkingLevels: { "provider/project": "high" },
      }));
      const models = [model("provider", "global"), model("provider", "project")];
      const choices = mainModelChoices(models, models.map((model) => ({ model, thinkingLevel: "off" })));
      assert.deepEqual(savedMainDefaults(cwd, agentDir, true, choices), { pair: { model: "provider/project", thinking: "high" } });
      assert.deepEqual(savedMainDefaults(cwd, agentDir, false, choices), { pair: { model: "provider/global", thinking: "medium" } });
      assert.match(JSON.stringify(savedMainDefaults(cwd, agentDir, true, choices.slice(0, 1))), /not in the current authenticated session scope/u);
      assert.match(JSON.stringify(savedMainDefaults(cwd, agentDir, true, [])), /No authenticated models/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing, malformed, and unsupported saved defaults without inventing a fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-main-defaults-"));
    try {
      const plain = { ...model("provider", "plain"), reasoning: false };
      const choices = mainModelChoices([plain], [{ model: plain }]);
      const resolve = () => savedMainDefaults(root, root, false, choices);
      assert.match(JSON.stringify(resolve()), /not configured/u);
      for (const [settings, error] of [
        [{ defaultProvider: "provider", defaultModel: "plain" }, /missing or invalid/u],
        [{ defaultProvider: "provider", defaultModel: "plain", defaultThinkingLevel: "high" }, /unsupported/u],
        [{ defaultProvider: "provider", defaultModel: "plain", defaultThinkingLevel: "off" }, /"thinking":"off"/u],
      ] as const) {
        await writeFile(join(root, "settings.json"), JSON.stringify(settings));
        assert.match(JSON.stringify(resolve()), error);
      }
      await writeFile(join(root, "settings.json"), "{invalid");
      assert.deepEqual(resolve(), { error: "Cannot read saved worker model settings" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
