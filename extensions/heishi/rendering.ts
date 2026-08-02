import type { RunResult, SubagentReport } from "./types.js";

export function reportMarkdown(report: SubagentReport): string {
  const verification = report.verification?.trim() || "Not provided.";
  const remainingRisk = report.remainingRisk?.trim() || "None reported.";
  return [
    "# Report",
    "",
    report.summary.trim(),
    "",
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
  return `${result.alias} · ${shortRunId(result.runId)}`;
}
