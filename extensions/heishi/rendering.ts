import type { RunResult, SubagentReport } from "./types.js";

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
