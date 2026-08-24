import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  initTheme,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "./model-config.js";
import { showHeishiSettings } from "./settings.js";

initTheme("dark", false);

describe("Heishi settings", () => {
  it("selects the scope first and saves global defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-settings-"));
    try {
      const paths = { global: join(root, "global.json"), project: join(root, "project.json") };
      const selectionTitles: string[] = [];
      let selections = 0;
      const ctx = settingsContext({
        select(title, options) {
          selectionTitles.push(title);
          selections += 1;
          return Promise.resolve(selections === 1 ? options[0] : selections === 2 ? options[0] : "Done");
        },
        custom: toggleFirstSetting,
      });

      assert.equal(await showHeishiSettings(ctx, paths), true);
      assert.equal(selectionTitles[0], "Configure Heishi settings for");
      assert.equal((await loadConfig(paths.global)).config.mode, "main");
      assert.equal((await loadConfig(paths.project)).exists, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves the global terminal host selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-settings-"));
    try {
      const paths = { global: join(root, "global.json"), project: join(root, "project.json") };
      let selections = 0;
      const ctx = settingsContext({
        select(_title, options) {
          selections += 1;
          return Promise.resolve(selections === 1 ? options[0] : selections === 2 ? options[0] : "Done");
        },
        custom: toggleThirdSetting,
      });

      assert.equal(await showHeishiSettings(ctx, paths), true);
      assert.equal((await loadConfig(paths.global)).config.terminalHost, "tmux");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves project overrides without copying inherited global settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-settings-"));
    try {
      const paths = { global: join(root, "global.json"), project: join(root, "project.json") };
      await saveConfig(paths.global, {
        mode: "main",
        workspace: "worktree",
        models: [{ model: "provider/global", thinking: "high" }],
        worktree: { cleanupApproval: "allow" },
      });
      let selections = 0;
      const ctx = settingsContext({
        select(_title, options) {
          selections += 1;
          return Promise.resolve(selections === 1 ? options[1] : selections === 2 ? options[0] : "Done");
        },
        custom: toggleFirstSetting,
      });

      assert.equal(await showHeishiSettings(ctx, paths), true);
      assert.deepEqual((await loadConfig(paths.project)).config, { mode: "sub" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface UIOverrides {
  select(title: string, options: string[]): Promise<string | undefined>;
  custom: ExtensionCommandContext["ui"]["custom"];
}

function settingsContext(overrides: UIOverrides): ExtensionCommandContext {
  return {
    mode: "tui",
    scopedModels: [],
    isProjectTrusted: () => true,
    modelRegistry: {
      refresh: async () => undefined,
      getAvailable: () => [],
    },
    ui: {
      select: overrides.select,
      custom: overrides.custom,
      notify() {},
    },
  } as unknown as ExtensionCommandContext;
}

type SettingsFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

async function toggleThirdSetting<T>(
  factory: SettingsFactory<T>,
): Promise<T> {
  return interactWithSettings(factory, ["\x1b[B", "\x1b[B", " ", "\x1b"]);
}

async function toggleFirstSetting<T>(factory: SettingsFactory<T>): Promise<T> {
  return interactWithSettings(factory, [" ", "\x1b"]);
}

async function interactWithSettings<T>(
  factory: SettingsFactory<T>,
  inputs: string[],
): Promise<T> {
  let result!: T;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const component = await factory(
    { requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    {} as never,
    (value) => {
      result = value;
      finished();
    },
  );
  for (const input of inputs) component.handleInput?.(input);
  await done;
  return result;
}
