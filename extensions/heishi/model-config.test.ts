import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  loadConfig,
  loadEffectiveConfig,
  resolveEffectiveConfig,
  saveConfig,
  validateRequestedModel,
  type HeishiConfig,
} from "./model-config.js";

const globalConfig: HeishiConfig = {
  mode: "sub",
  workspace: "shared",
  terminalHost: "tmux",
  worktree: { cleanupApproval: "ask" },
};
const projectConfig: HeishiConfig = {
  mode: "main",
  terminalHost: "cmux",
  worktree: { cleanupApproval: "allow" },
};

describe("Heishi configuration", () => {
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
        cleanupApproval: "allow",
      });
      assert.deepEqual((await loadEffectiveConfig(globalPath, projectPath, false)).config, {
        mode: "sub",
        workspace: "shared",
        terminalHost: "tmux",
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
      cleanupApproval: "ask",
    });
    assert.deepEqual(resolveEffectiveConfig(globalConfig, { workspace: "worktree" }), {
      mode: "sub",
      workspace: "worktree",
      terminalHost: "tmux",
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

  it("ignores the retired delegation model pool in existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-config-"));
    try {
      const path = join(root, "heishi.json");
      await writeFile(path, JSON.stringify({ mode: "main", models: [{ model: "provider/old", thinking: "high" }] }));
      assert.deepEqual(await loadConfig(path), { config: { mode: "main" }, exists: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts omitted worker models and validates only explicit, authenticated, supported requests", () => {
    const plain = { ...model("provider", "nested/plain"), reasoning: false };
    const lookups: string[] = [];
    const registry = {
      find(provider: string, id: string) {
        lookups.push(`${provider}/${id}`);
        return provider === plain.provider && id === plain.id ? plain : undefined;
      },
      hasConfiguredAuth: () => true,
    };

    assert.doesNotThrow(() => validateRequestedModel(undefined, undefined, registry));
    assert.doesNotThrow(() => validateRequestedModel(undefined, "high", registry));
    assert.deepEqual(lookups, []);
    assert.doesNotThrow(() => validateRequestedModel("provider/nested/plain", "off", registry));
    assert.deepEqual(lookups, ["provider/nested/plain"]);
    assert.throws(() => validateRequestedModel("provider/nested/plain", "high", registry), /does not support thinking high/u);
    assert.throws(() => validateRequestedModel("provider/missing", undefined, registry), /not available or authenticated/u);
    assert.throws(() => validateRequestedModel("no-provider", undefined, registry), /not available or authenticated/u);
    assert.throws(
      () => validateRequestedModel("provider/nested/plain", undefined, { ...registry, hasConfiguredAuth: () => false }),
      /not available or authenticated/u,
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

