import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandExecutor {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export class ProcessCommandExecutor implements CommandExecutor {
  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(command, args, { encoding: "utf8", timeout: 30_000 });
  }
}
