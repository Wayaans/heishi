import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
  availableModelChoices,
  loadConfig,
  resolveEffectiveConfig,
  saveConfig,
  type CleanupApproval,
  type HeishiConfig,
} from "./model-config.js";
import { pickDelegationPairs } from "./model-picker.js";

interface SettingsPaths {
  global: string;
  project: string;
}

type SettingsScope = "global" | "project";

export async function showHeishiSettings(
  ctx: ExtensionCommandContext,
  paths: SettingsPaths,
): Promise<boolean> {
  const scope = await selectScope(ctx);
  if (!scope) return false;

  const globalLoaded = await loadConfig(paths.global);
  const projectLoaded = scope === "project"
    ? await loadConfig(paths.project)
    : { config: {}, exists: false };
  if (globalLoaded.error) {
    ctx.ui.notify(globalLoaded.error, "warning");
    return false;
  }
  if (scope === "project" && projectLoaded.error) {
    ctx.ui.notify(projectLoaded.error, "warning");
    return false;
  }

  let config = scope === "global" ? globalLoaded.config : projectLoaded.config;
  let changed = false;
  while (true) {
    const effective = resolveEffectiveConfig(
      scope === "global" ? config : globalLoaded.config,
      scope === "project" ? config : undefined,
    );
    const section = await ctx.ui.select(
      scope === "global" ? "Configure Heishi globally" : "Configure Heishi for this project",
      [
        `Defaults and cleanup (${effective.mode}, ${effective.workspace}, ${approvalLabel(effective.cleanupApproval)})`,
        `Delegation models (${effective.models.length} pair${effective.models.length === 1 ? "" : "s"})`,
        "Done",
      ],
    );
    if (!section || section === "Done") break;

    if (section.startsWith("Defaults and cleanup")) {
      const updated = await editDefaults(ctx, scope, config);
      if (!sameConfig(config, updated)) {
        config = updated;
        await saveConfig(paths[scope], config);
        changed = true;
      }
      continue;
    }

    await ctx.modelRegistry.refresh();
    const choices = availableModelChoices(ctx.modelRegistry.getAvailable(), ctx.scopedModels);
    if (choices.length === 0) {
      ctx.ui.notify("No authenticated models are available", "warning");
      continue;
    }

    if (scope === "project") {
      const modelBehavior = await ctx.ui.select("Project delegation models", [
        `Inherit global models (${globalLoaded.config.models?.length ?? 0} configured)`,
        "Configure project models",
      ]);
      if (!modelBehavior) continue;
      if (modelBehavior.startsWith("Inherit global models")) {
        if (config.models !== undefined) {
          config = withoutModels(config);
          await saveConfig(paths.project, config);
          changed = true;
        }
        continue;
      }
    }

    const initial = config.models ?? globalLoaded.config.models ?? [];
    const selected = await pickDelegationPairs(ctx, choices, initial);
    if (selected && !sameModels(config.models, selected)) {
      config = { ...config, models: selected };
      await saveConfig(paths[scope], config);
      changed = true;
    }
  }

  if (changed) ctx.ui.notify(`Saved Heishi settings to ${paths[scope]}`, "info");
  return changed;
}

async function selectScope(ctx: ExtensionCommandContext): Promise<SettingsScope | undefined> {
  const options = ctx.isProjectTrusted() ? ["Global", "Current project"] : ["Global"];
  const selected = await ctx.ui.select("Configure Heishi settings for", options);
  if (selected === "Global") return "global";
  if (selected === "Current project") return "project";
  return undefined;
}

async function editDefaults(
  ctx: ExtensionCommandContext,
  scope: SettingsScope,
  initial: HeishiConfig,
): Promise<HeishiConfig> {
  let config = structuredClone(initial);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = [
      {
        id: "mode",
        label: "Default worker mode",
        description: scopeDescription(scope),
        currentValue: scope === "project" ? config.mode ?? "inherit" : config.mode ?? "sub",
        values: scope === "project" ? ["inherit", "sub", "main"] : ["sub", "main"],
      },
      {
        id: "workspace",
        label: "Main-mode workspace",
        description: scopeDescription(scope),
        currentValue: scope === "project" ? config.workspace ?? "inherit" : config.workspace ?? "shared",
        values: scope === "project" ? ["inherit", "shared", "worktree"] : ["shared", "worktree"],
      },
      {
        id: "cleanupApproval",
        label: "Worktree cleanup approval",
        description: "ask: prompt each time, allow: clean without asking",
        currentValue: scope === "project"
          ? config.worktree?.cleanupApproval ?? "inherit"
          : config.worktree?.cleanupApproval ?? "ask",
        values: scope === "project" ? ["inherit", "ask", "allow"] : ["ask", "allow"],
      },
    ];

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(
      theme.fg("accent", theme.bold(scope === "global" ? "Global Heishi defaults" : "Project Heishi defaults")),
      1,
      0,
    ));
    const settings = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, value) => {
        config = updateDefault(config, id, value);
      },
      () => done(),
    );
    container.addChild(settings);
    container.addChild(new Text(theme.fg("dim", "Enter/Space change · Esc save and close"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        settings.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "72%", minWidth: 54, maxHeight: "70%", margin: 1 },
  });
  return config;
}

function updateDefault(config: HeishiConfig, id: string, value: string): HeishiConfig {
  const updated = structuredClone(config);
  if (id === "mode") {
    if (value === "inherit") delete updated.mode;
    else if (value === "sub" || value === "main") updated.mode = value;
  } else if (id === "workspace") {
    if (value === "inherit") delete updated.workspace;
    else if (value === "shared" || value === "worktree") updated.workspace = value;
  } else if (id === "cleanupApproval") {
    if (value === "inherit") delete updated.worktree;
    else if (value === "ask" || value === "allow") updated.worktree = { cleanupApproval: value };
  }
  return updated;
}

function withoutModels(config: HeishiConfig): HeishiConfig {
  const updated = structuredClone(config);
  delete updated.models;
  return updated;
}

function sameConfig(left: HeishiConfig, right: HeishiConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameModels(current: HeishiConfig["models"], selected: NonNullable<HeishiConfig["models"]>): boolean {
  return current !== undefined && JSON.stringify(current) === JSON.stringify(selected);
}

function scopeDescription(scope: SettingsScope): string {
  return scope === "project" ? "inherit uses the global value" : "used unless a trusted project overrides it";
}

function approvalLabel(approval: CleanupApproval): string {
  return approval === "ask" ? "ask before cleanup" : "allow cleanup";
}
