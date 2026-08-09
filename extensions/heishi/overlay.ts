import {
  DynamicBorder,
  getMarkdownTheme,
  type ExtensionCommandContext,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Markdown,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { RunCoordinator } from "./coordinator.js";
import { reportMarkdown, shortRunId } from "./rendering.js";
import type { RunRecord, RunStatus } from "./types.js";

type OverlayAction = "select" | "steer" | "follow_up" | "abort" | "details" | "close";

interface Selection {
  action: OverlayAction;
  runId?: string;
}

export async function showSubagentOverlay(
  coordinator: RunCoordinator,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let selectedRunId: string | undefined;
  while (true) {
    const runs = coordinator.list().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (runs.length === 0) {
      ctx.ui.notify("No subagents are recorded in this session", "info");
      return;
    }
    const byId = new Map(runs.map((run) => [run.runId, run]));
    const selection = await ctx.ui.custom<Selection>((tui, theme, _keybindings, done) => {
      return new SubagentList(
        runs,
        selectedRunId,
        Math.min(18, Math.max(runs.length, Math.floor(tui.terminal.rows * 0.55))),
        theme,
        done,
        () => tui.requestRender(),
      );
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", minWidth: 60, maxHeight: "80%", margin: 1 },
    });

    if (!selection.runId || selection.action === "close") return;
    selectedRunId = selection.runId;
    const run = byId.get(selection.runId);
    if (!run) continue;

    if (selection.action === "details") {
      await showDetails(ctx, run);
      continue;
    }
    if (selection.action === "steer" || selection.action === "follow_up") {
      const label = selection.action === "steer" ? "Steer subagent" : "Follow up with subagent";
      const message = await ctx.ui.input(label, "Message");
      if (message?.trim()) {
        await coordinator.control({ runId: run.runId, action: selection.action, message });
      }
      continue;
    }
    if (selection.action === "abort") {
      if (await ctx.ui.confirm("Abort subagent", `Abort ${run.alias} and close its pane?`)) {
        await coordinator.control({ runId: run.runId, action: "abort" });
      }
      continue;
    }

    if (run.paneState === "open") {
      await coordinator.control({ runId: run.runId, action: "focus" });
      return;
    }
    if (run.workerSessionFile) {
      const resumed = await coordinator.control({ runId: run.runId, action: "resume" });
      if (resumed.tmuxTarget) await coordinator.control({ runId: run.runId, action: "focus" });
      return;
    }
    await showDetails(ctx, run);
  }
}

class SubagentList implements Component {
  private selected: number;
  private scroll = 0;

  constructor(
    private readonly runs: RunRecord[],
    selectedRunId: string | undefined,
    private readonly visibleRows: number,
    private readonly theme: Theme,
    private readonly done: (selection: Selection) => void,
    private readonly requestRender: () => void,
  ) {
    const selected = selectedRunId ? runs.findIndex((run) => run.runId === selectedRunId) : 0;
    this.selected = selected >= 0 ? selected : 0;
    this.keepSelectedVisible();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const title = joinColumns(
      this.theme.fg("accent", this.theme.bold("Subagents")),
      this.theme.fg("dim", `${this.runs.length} agents`),
      width,
    );
    const label = ` agents · ${this.selected + 1}/${this.runs.length} `;
    const lines = [title, this.border(width, label, true)];
    const end = Math.min(this.runs.length, this.scroll + this.visibleRows);
    for (let index = this.scroll; index < end; index += 1) {
      lines.push(this.row(this.runs[index]!, index === this.selected, innerWidth));
    }
    for (let index = end - this.scroll; index < this.visibleRows; index += 1) {
      lines.push(this.frame("", innerWidth));
    }
    lines.push(this.border(width, "", false));
    lines.push(truncateToWidth(
      this.theme.fg("dim", "↑↓/jk select · Enter focus/resume · S steer · F follow-up · A abort · D details · Esc close"),
      width,
    ));
    const active = this.runs.filter((run) => run.status === "created" || run.status === "starting" || run.status === "running").length;
    const done = this.runs.filter((run) => run.status === "completed").length;
    lines.push(truncateToWidth(
      `subagents: ${this.theme.fg("warning", `■ ${active} running`)} · ${this.theme.fg("success", `■ ${done} done`)}`,
      width,
    ));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "close" });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.keepSelectedVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(this.runs.length - 1, this.selected + 1);
      this.keepSelectedVisible();
      this.requestRender();
      return;
    }
    const runId = this.runs[this.selected]?.runId;
    if (!runId) return;
    if (matchesKey(data, Key.enter)) this.done({ action: "select", runId });
    else if (data === "s" || data === "S") this.done({ action: "steer", runId });
    else if (data === "f" || data === "F") this.done({ action: "follow_up", runId });
    else if (data === "a" || data === "A") this.done({ action: "abort", runId });
    else if (data === "d" || data === "D") this.done({ action: "details", runId });
  }

  invalidate(): void {}

  private row(run: RunRecord, selected: boolean, width: number): string {
    const marker = this.theme.fg("accent", selected ? "❯" : " ");
    const icon = this.theme.fg(statusColor(run.status), "■");
    const alias = this.theme.fg(selected ? "accent" : "text", run.alias);
    const identity = `${marker} ${icon} ${alias} ${this.theme.fg("dim", shortRunId(run.runId))} ${this.theme.fg("muted", `— ${run.taskPreview}`)}`;
    const metadata = `${this.theme.fg("dim", `${run.mode} · ${run.model ?? "…"} · ${run.thinking ?? "…"} · ${paneLabel(run)} · ${elapsed(run)} ·`)} ${this.theme.fg(statusColor(run.status), run.status)}`;
    return this.frame(joinColumns(identity, metadata, width), width);
  }

  private frame(content: string, width: number): string {
    const padded = padToWidth(truncateToWidth(content, width), width);
    return `${this.theme.fg("border", "│")}${padded}${this.theme.fg("border", "│")}`;
  }

  private border(width: number, label: string, top: boolean): string {
    const left = top ? "╭" : "╰";
    const right = top ? "╮" : "╯";
    const middle = label
      ? `─${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 3))}`
      : "─".repeat(Math.max(0, width - 2));
    return this.theme.fg("border", `${left}${middle}${right}`);
  }

  private keepSelectedVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + this.visibleRows) this.scroll = this.selected - this.visibleRows + 1;
  }
}

function joinColumns(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width - 12) return truncateToWidth(left, width);
  const leftWidth = width - rightWidth - 1;
  const fittedLeft = truncateToWidth(left, leftWidth);
  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth))}${right}`;
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function statusColor(status: RunStatus): ThemeColor {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "blocked" || status === "cancelled") return "warning";
  return "accent";
}

function paneLabel(run: RunRecord): string {
  return run.paneState === "open" ? "pane open" : run.paneState;
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

async function showDetails(ctx: ExtensionCommandContext, run: RunRecord): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Subagent: ${run.alias} · ${shortRunId(run.runId)}`)), 1, 0));
    container.addChild(new Text([
      `Status: ${run.status}`,
      `Mode: ${run.mode}`,
      `Model/thinking: ${run.model ?? "not selected"} / ${run.thinking ?? "not selected"}`,
      `Pane: ${run.paneState}${run.tmuxTarget ? ` (${run.tmuxTarget})` : ""}`,
      `Session: ${run.workerSessionFile ?? "not created"}`,
      `Task: ${run.taskPreview}`,
      run.error ? `Error: ${run.error}` : "",
    ].filter(Boolean).join("\n"), 1, 0));
    if (run.report) container.addChild(new Markdown(reportMarkdown(run.report), 1, 0, getMarkdownTheme()));
    container.addChild(new Text(theme.fg("dim", "Press Enter or Escape to return"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "80%" } });
}
