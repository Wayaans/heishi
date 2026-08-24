import type { ThinkingLevel } from "./terminal-host.js";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export interface PiCommandOptions {
  mode: "sub" | "main";
  piPath: string | readonly string[];
  extensionPath: string;
  model?: string;
  thinking?: ThinkingLevel;
  name: string;
  projectTrusted: boolean;
  sessionFile?: string;
}

export function buildPiCommand(options: PiCommandOptions): string[] {
  const command = options.mode === "main"
    ? buildMainPiCommand(options)
    : buildSubPiCommand(options);
  if (options.sessionFile) command.push("--session", options.sessionFile);
  return command;
}

function buildSubPiCommand(options: PiCommandOptions): string[] {
  if (!options.model || !options.thinking) throw new Error("Subagent model and thinking are required");
  return [
    ...piInvocation(options.piPath),
    "--no-extensions",
    "-e", options.extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--model", options.model,
    "--thinking", options.thinking,
    "--name", options.name,
  ];
}

function buildMainPiCommand(options: PiCommandOptions): string[] {
  const command = [...piInvocation(options.piPath), "-e", options.extensionPath];
  if (options.model) command.push("--model", options.model);
  if (options.thinking) command.push("--thinking", options.thinking);
  command.push("--name", options.name, options.projectTrusted ? "--approve" : "--no-approve");
  return command;
}

function piInvocation(piPath: PiCommandOptions["piPath"]): string[] {
  return typeof piPath === "string" ? [piPath] : [...piPath];
}
