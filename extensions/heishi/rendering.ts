import type { RunResult, SubagentReport } from "./types.js";

export function displayWorktreePath(path: string): string {
  const marker = "/worktrees/";
  const markerIndex = path.indexOf(marker);
  return markerIndex === -1 ? path : path.slice(markerIndex);
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function reportMarkdown(report: SubagentReport): string {
  const verification = report.verification?.trim() || "Not provided.";
  const remainingRisk = report.remainingRisk?.trim() || "None reported.";
  const request = report.request
    ? [
        "## External input required",
        "",
        `Kind: ${report.request.kind}`,
        "",
        report.request.prompt.trim(),
        ...(report.request.detail?.trim() ? ["", report.request.detail.trim()] : []),
        ...(report.request.options?.length ? ["", "Options:", ...report.request.options.map((option) => `- ${option}`)] : []),
        ...(report.request.recommendation?.trim() ? ["", `Recommendation: ${report.request.recommendation.trim()}`] : []),
        "",
      ]
    : [];
  return [
    "# Report",
    "",
    report.summary.trim(),
    "",
    ...request,
    "## Verification",
    "",
    verification,
    "",
    "## Remaining risk",
    "",
    remainingRisk,
  ].join("\n");
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 6);
}

export function runIdentity(result: RunResult): string {
  const mode = result.mode === "main" ? " · main" : "";
  return `${result.alias} · ${shortRunId(result.runId)}${mode}`;
}
