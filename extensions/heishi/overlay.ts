import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { RunCoordinator } from "./coordinator.js";
import type { RunRecord } from "./types.js";

type OverlayAction = "select" | "steer" | "follow_up" | "abort" | "details" | "close";

interface Selection {
  action: OverlayAction;
  runId?: string;
}

export async function showSubagentOverlay(
  coordinator: RunCoordinator,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const runs = coordinator.list().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (runs.length === 0) {
    ctx.ui.notify("No subagents are recorded in this session", "info");
    return;
  }
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const items = runs.map(toSelectItem);

  const selection = await ctx.ui.custom<Selection>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
    const list = new SelectList(items, 12, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    let selectedRunId = items[0]?.value;
    list.onSelectionChange = (item) => { selectedRunId = item.value; };
    list.onSelect = (item) => done({ action: "select", runId: item.value });
    list.onCancel = () => done({ action: "close" });
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Enter focus/resume · S steer · F follow-up · A abort · D details · Esc close"), 1, 0));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        const action = actionForKey(data);
        if (action) {
          done(selectedRunId ? { action, runId: selectedRunId } : { action: "close" });
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: 100, maxHeight: "80%" },
  });

  if (!selection.runId || selection.action === "close") return;
  const run = byId.get(selection.runId);
  if (!run) return;

  if (selection.action === "details") {
    await showDetails(ctx, run);
    return;
  }
  if (selection.action === "steer" || selection.action === "follow_up") {
    const label = selection.action === "steer" ? "Steer subagent" : "Follow up with subagent";
    const message = await ctx.ui.input(label, "Message");
    if (!message?.trim()) return;
    await coordinator.control({ runId: run.runId, action: selection.action, message });
    return;
  }
  if (selection.action === "abort") {
    if (await ctx.ui.confirm("Abort subagent", `Abort ${run.alias} and close its pane?`)) {
      await coordinator.control({ runId: run.runId, action: "abort" });
    }
    return;
  }

  if (run.paneState === "open") {
    await coordinator.control({ runId: run.runId, action: "focus" });
  } else if (run.workerSessionFile) {
    const resumed = await coordinator.control({ runId: run.runId, action: "resume" });
    if (resumed.tmuxTarget) await coordinator.control({ runId: run.runId, action: "focus" });
  } else {
    await showDetails(ctx, run);
  }
}

function toSelectItem(run: RunRecord): SelectItem {
  const pane = run.paneState === "open" ? "pane open" : run.paneState;
  return {
    value: run.runId,
    label: `[${run.status}] ${run.alias} · ${run.runId.slice(0, 6)}  ${run.model}/${run.thinking}`,
    description: `${pane} · ${elapsed(run)} · ${run.taskPreview}`,
  };
}

function elapsed(run: RunRecord): string {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = Date.parse(run.completedAt ?? new Date().toISOString());
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function actionForKey(data: string): Exclude<OverlayAction, "select" | "close"> | undefined {
  if (matchesKey(data, Key.shift("s")) || matchesKey(data, "s")) return "steer";
  if (matchesKey(data, Key.shift("f")) || matchesKey(data, "f")) return "follow_up";
  if (matchesKey(data, Key.shift("a")) || matchesKey(data, "a")) return "abort";
  if (matchesKey(data, Key.shift("d")) || matchesKey(data, "d")) return "details";
  return undefined;
}

async function showDetails(ctx: ExtensionCommandContext, run: RunRecord): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Subagent: ${run.alias} · ${run.runId.slice(0, 6)}`)), 1, 0));
    container.addChild(new Text([
      `Status: ${run.status}`,
      `Model/thinking: ${run.model} / ${run.thinking}`,
      `Pane: ${run.paneState}${run.tmuxTarget ? ` (${run.tmuxTarget})` : ""}`,
      `Session: ${run.workerSessionFile ?? "not created"}`,
      `Task: ${run.taskPreview}`,
      run.report ? `Report: ${run.report.summary}` : "Report: none",
      run.error ? `Error: ${run.error}` : "",
      "",
      "Press Enter or Escape to close",
    ].filter(Boolean).join("\n"), 1, 0));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: 90, maxHeight: "80%" } });
}
