import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { DelegationPair, ModelChoice } from "./model-config.js";
import { modelReference } from "./model-config.js";

export async function pickDelegationPairs(
  ctx: ExtensionCommandContext,
  choices: readonly ModelChoice[],
  initial: readonly DelegationPair[],
): Promise<DelegationPair[] | undefined> {
  const pairs = choices.flatMap((choice) => choice.levels.map((thinking) => ({
    model: modelReference(choice.model),
    thinking,
  })));
  const enabled = new Set(initial.map(pairKey));

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = pairs.map((pair) => ({
      id: pairKey(pair),
      label: pair.model,
      description: `thinking: ${pair.thinking}`,
      currentValue: enabled.has(pairKey(pair)) ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Heishi delegation models")), 1, 0));
    const settings = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, value) => {
        if (value === "enabled") enabled.add(id);
        else enabled.delete(id);
      },
      () => done(),
      { enableSearch: true },
    );
    container.addChild(settings);
    container.addChild(new Text(
      theme.fg("dim", "Enter/Space toggle · type to search · Esc review changes"),
      1,
      0,
    ));
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
    overlayOptions: { anchor: "center", width: "86%", minWidth: 60, maxHeight: "85%", margin: 1 },
  });

  const selected = pairs.filter((pair) => enabled.has(pairKey(pair)));
  const confirmed = await ctx.ui.confirm(
    "Save Heishi delegation models",
    selected.length === 0
      ? "Save an empty model pool? Subagent delegation will be disabled for this scope."
      : `Save ${selected.length} allowed model/thinking pair${selected.length === 1 ? "" : "s"}?`,
  );
  return confirmed ? selected : undefined;
}

function pairKey(pair: DelegationPair): string {
  return `${pair.model}\u0000${pair.thinking}`;
}
