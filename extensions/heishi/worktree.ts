import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeRecord } from "./types.js";
import { isSafeRelativeCwd } from "./workspace.js";

const execFileAsync = promisify(execFile);

export interface GitCommandExecutor {
  exec(args: string[]): Promise<{ stdout: string; stderr: string }>;
  execStdin?(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }>;
}

export interface WorktreeRollbackResult {
  worktree: WorktreeRecord;
  warning?: string;
}

export class WorktreeOperationError extends Error {
  constructor(message: string, readonly worktree: WorktreeRecord) {
    super(message);
    this.name = "WorktreeOperationError";
  }
}

export interface WorktreeAdapter {
  prepare(sourceCwd: string, runId: string): Promise<WorktreeRecord>;
  rollback(worktree: WorktreeRecord): Promise<WorktreeRollbackResult>;
  validateCleanup(worktree: WorktreeRecord): Promise<void>;
  cleanup(worktree: WorktreeRecord): Promise<WorktreeRecord>;
  prepareResume(worktree: WorktreeRecord): Promise<WorktreeRecord>;
}

export class GitCommand implements GitCommandExecutor {
  async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { encoding: "utf8", timeout: 120_000 });
  }

  async execStdin(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveCommand, rejectCommand) => {
      const child = spawn("git", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", rejectCommand);
      child.stdin.on("error", rejectCommand);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolveCommand({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || `git exited with ${signal ?? `code ${code ?? "unknown"}`}`;
        rejectCommand(Object.assign(new Error(detail), { code, stdout, stderr }));
      });
      child.stdin.end(stdin);
    });
  }
}

export class GitWorktrees implements WorktreeAdapter {
  private readonly root: string;

  constructor(
    agentDir: string,
    private readonly git: GitCommandExecutor = new GitCommand(),
  ) {
    this.root = join(agentDir, "heishi", "worktrees");
  }

  async prepare(sourceCwd: string, runId: string): Promise<WorktreeRecord> {
    const canonicalSourceCwd = await requiredRealpath(sourceCwd, "Could not resolve source directory");
    const sourceRootOutput = await this.gitValue(["-C", canonicalSourceCwd, "rev-parse", "--show-toplevel"], "Source directory is not a Git checkout");
    const sourceRoot = await requiredRealpath(sourceRootOutput, "Could not resolve the Git worktree root");
    const commonOutput = await this.gitValue(
      ["-C", canonicalSourceCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      "Could not resolve the Git common directory",
    );
    const gitCommonDir = await requiredRealpath(
      resolve(canonicalSourceCwd, commonOutput),
      "Could not resolve the Git common directory",
    );
    const relativeCwd = relative(sourceRoot, canonicalSourceCwd) || ".";
    if (!isSafeRelativeCwd(relativeCwd)) throw new Error("Source directory is outside its Git worktree");

    const status = await this.gitValue(["-C", sourceRoot, "status", "--porcelain=v1", "--untracked-files=all"], "Could not inspect source checkout status");
    if (status) throw new Error("Git worktree workspace requires a clean source checkout, including no untracked files");

    const baseCommit = await this.gitValue(["-C", sourceRoot, "rev-parse", "HEAD"], "Could not resolve source HEAD");
    const repositoryName = await this.repositoryName(gitCommonDir, sourceRoot);
    const branch = `heishi/${runId}`;
    const path = this.worktreePath(repositoryName, gitCommonDir, runId);
    const record: WorktreeRecord = {
      path,
      branch,
      baseCommit,
      state: "present",
      gitCommonDir,
      repositoryName,
      relativeCwd,
    };
    await this.assertManagedRecord(record);
    if (await pathExists(path)) throw new Error(`Worktree path already exists: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    let reservationAttempted = false;
    let reservedBranchName = false;
    try {
      reservationAttempted = true;
      await this.reserveBranchName(record);
      reservedBranchName = true;
      await this.git.exec(["-C", sourceRoot, "worktree", "add", path, branch]);
      const worktreeHead = await this.gitValue(
        ["-C", path, "rev-parse", "HEAD"],
        "Could not verify the created worktree HEAD",
      );
      if (worktreeHead !== baseCommit) {
        throw new Error(`Created worktree HEAD ${worktreeHead} does not match source HEAD ${baseCommit}`);
      }
      await mkdir(worktreeCwd(record), { recursive: true });
      return record;
    } catch (error) {
      if (reservationAttempted && !reservedBranchName) {
        throw new WorktreeOperationError(
          `Could not create Git worktree: ${errorMessage(error)}; branch reservation outcome is unknown and was retained`,
          record,
        );
      }
      let rolledBack: WorktreeRecord;
      try {
        await this.rollbackPartial(record);
        rolledBack = removedRecord(record, await this.branchCommit(record));
      } catch (rollbackError) {
        throw new WorktreeOperationError(
          `Could not create Git worktree: ${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}; ${retainedRefsWarning(record)}`,
          record,
        );
      }
      throw new WorktreeOperationError(
        `Could not create Git worktree: ${errorMessage(error)}; ${retainedRefsWarning(record)}`,
        rolledBack,
      );
    }
  }

  async rollback(worktree: WorktreeRecord): Promise<WorktreeRollbackResult> {
    await this.assertManagedRecord(worktree);
    const warning = retainedRefsWarning(worktree);
    if (worktree.state === "removed") return { worktree, warning };
    try {
      await this.assertRegistered(worktree);
      await this.git.exec(["--git-dir", worktree.gitCommonDir, "worktree", "remove", worktree.path]);
      if (await this.registeredWorktree(worktree.path, worktree.gitCommonDir) || await pathExists(worktree.path)) {
        throw new Error(`Worktree resources remain at ${worktree.path}`);
      }
      const resumeCommit = await this.branchCommit(worktree);
      return { worktree: removedRecord(worktree, resumeCommit), warning };
    } catch (error) {
      throw new WorktreeOperationError(
        `Could not remove Git worktree during rollback: ${errorMessage(error)}; ${warning}`,
        worktree,
      );
    }
  }

  async validateCleanup(worktree: WorktreeRecord): Promise<void> {
    await this.assertManagedRecord(worktree);
    if (worktree.state !== "present") throw new Error("Worktree workspace has already been removed");
    await this.assertRegistered(worktree);
    await this.assertPresentWorktreeConsistency(worktree);
    const status = await this.gitValue(
      ["-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
      "Could not inspect worktree status",
    );
    if (status) throw new Error("Worktree has modified, untracked, or ignored files; cleanup refused");
  }

  async cleanup(worktree: WorktreeRecord): Promise<WorktreeRecord> {
    await this.validateCleanup(worktree);
    const resumeCommit = await this.worktreeHead(worktree);
    try {
      await this.git.exec(["--git-dir", worktree.gitCommonDir, "worktree", "remove", worktree.path]);
      if (await this.registeredWorktree(worktree.path, worktree.gitCommonDir) || await pathExists(worktree.path)) {
        throw new Error(`Worktree resources remain at ${worktree.path}`);
      }
    } catch (error) {
      throw new WorktreeOperationError(`Could not remove Git worktree: ${errorMessage(error)}`, worktree);
    }

    const removed = removedRecord(worktree, resumeCommit);
    try {
      await this.assertBranchNameReservation(removed);
      if (!await this.branchExists(removed.gitCommonDir, removed.branch)) {
        throw new Error(`Retained worktree branch is missing: ${removed.branch}`);
      }
      const branchCommit = await this.branchCommit(removed);
      if (branchCommit !== resumeCommit) {
        throw new Error(
          `Retained worktree branch ${removed.branch} moved from resume commit ${resumeCommit} to ${branchCommit}`,
        );
      }
    } catch (error) {
      throw new WorktreeOperationError(
        `Git worktree was removed, but retained refs are inconsistent: ${errorMessage(error)}`,
        removed,
      );
    }
    return removed;
  }

  async prepareResume(worktree: WorktreeRecord): Promise<WorktreeRecord> {
    await this.assertManagedRecord(worktree);
    if (worktree.state === "present") {
      await this.assertRegistered(worktree);
      await this.assertPresentWorktreeConsistency(worktree);
      return worktree;
    }
    if (await pathExists(worktree.path)) {
      throw new Error(`Removed worktree path is occupied: ${worktree.path}`);
    }
    if (!await this.branchExists(worktree.gitCommonDir, worktree.branch)) {
      throw new Error(`Retained worktree branch is missing: ${worktree.branch}`);
    }
    const branchCommit = await this.branchCommit(worktree);
    if (branchCommit !== worktree.resumeCommit) {
      throw new Error(
        `Retained worktree branch ${worktree.branch} moved from resume commit ${worktree.resumeCommit} to ${branchCommit}`,
      );
    }
    await this.assertBranchNameReservation(worktree);
    if (await this.registeredWorktree(worktree.path, worktree.gitCommonDir)) {
      throw new Error(`Removed worktree still has a Git registration: ${worktree.path}`);
    }

    const present = presentRecord(worktree);
    try {
      await this.git.exec(["--git-dir", worktree.gitCommonDir, "worktree", "add", worktree.path, worktree.branch]);
      const [createdHead, currentBranchCommit] = await Promise.all([
        this.worktreeHead(present),
        this.branchCommit(present),
      ]);
      await this.assertBranchNameReservation(present);
      if (createdHead !== worktree.resumeCommit || currentBranchCommit !== worktree.resumeCommit) {
        throw new Error(
          `Recreated worktree changed from resume commit ${worktree.resumeCommit}; worktree HEAD is ${createdHead} and branch tip is ${currentBranchCommit}`,
        );
      }
      await mkdir(worktreeCwd(present), { recursive: true });
      return present;
    } catch (error) {
      try {
        await this.rollbackPartial(present);
      } catch (rollbackError) {
        throw new WorktreeOperationError(
          `Could not recreate Git worktree: ${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
          present,
        );
      }
      throw new WorktreeOperationError(`Could not recreate Git worktree: ${errorMessage(error)}`, worktree);
    }
  }

  private async assertPresentWorktreeConsistency(worktree: WorktreeRecord): Promise<void> {
    await this.assertBranchNameReservation(worktree);
    if (!await this.branchExists(worktree.gitCommonDir, worktree.branch)) {
      throw new Error(`Present worktree branch is missing or unborn: ${worktree.branch}`);
    }
    const worktreeHead = await this.worktreeHead(worktree);
    const branchCommit = await this.branchCommit(worktree);
    if (worktreeHead !== branchCommit) {
      throw new Error(
        `Present worktree HEAD ${worktreeHead} does not match branch ${worktree.branch} tip ${branchCommit}`,
      );
    }
  }

  private async repositoryName(commonDir: string, fallbackRoot: string): Promise<string> {
    const output = await this.gitValue(["--git-dir", commonDir, "worktree", "list", "--porcelain"], "Could not inspect Git worktrees");
    const primaryPath = output.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const name = basename(primaryPath ?? fallbackRoot);
    if (!isSafeRepositoryName(name)) throw new Error("Could not derive a safe repository name");
    return name;
  }

  private async assertManagedRecord(worktree: WorktreeRecord): Promise<void> {
    const runId = worktree.branch.startsWith("heishi/") ? worktree.branch.slice("heishi/".length) : "";
    if (!runId
      || runId === "."
      || runId === ".."
      || runId.includes("/")
      || runId.includes("\\")
      || !isSafeRepositoryName(worktree.repositoryName)
      || !isSafeRelativeCwd(worktree.relativeCwd)) throw new Error("Worktree metadata is inconsistent");
    const canonicalCommonDir = await requiredRealpath(
      worktree.gitCommonDir,
      "Could not resolve worktree Git common directory",
    );
    if (canonicalCommonDir !== worktree.gitCommonDir) {
      throw new Error("Worktree Git common directory is missing or no longer canonical");
    }
    if (worktree.path !== this.worktreePath(worktree.repositoryName, worktree.gitCommonDir, runId)) {
      throw new Error("Worktree path does not match its managed repository and run");
    }
  }

  private async assertRegistered(worktree: WorktreeRecord): Promise<void> {
    const registered = await this.registeredWorktree(worktree.path, worktree.gitCommonDir);
    if (!registered || registered.branch !== `refs/heads/${worktree.branch}`) {
      throw new Error("Worktree is missing or its registered branch is inconsistent");
    }
    await requiredRealpath(worktree.path, "Could not resolve worktree path");
  }

  private async registeredWorktree(path: string, commonDir: string): Promise<{ branch?: string } | undefined> {
    const output = await this.gitValue(["--git-dir", commonDir, "worktree", "list", "--porcelain"], "Could not inspect Git worktrees");
    const expectedPath = await pathIdentity(path);
    let currentMatches = false;
    let branch: string | undefined;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentMatches) return { ...(branch ? { branch } : {}) };
        currentMatches = await pathIdentity(line.slice("worktree ".length)) === expectedPath;
        branch = undefined;
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (!line && currentMatches) {
        return { ...(branch ? { branch } : {}) };
      }
    }
    return currentMatches ? { ...(branch ? { branch } : {}) } : undefined;
  }

  private async worktreeHead(worktree: WorktreeRecord): Promise<string> {
    return this.gitValue(["-C", worktree.path, "rev-parse", "HEAD"], "Could not resolve worktree HEAD");
  }

  private async branchCommit(worktree: WorktreeRecord): Promise<string> {
    return this.gitValue(
      ["--git-dir", worktree.gitCommonDir, "rev-parse", "--verify", `refs/heads/${worktree.branch}`],
      `Could not inspect worktree branch ${worktree.branch}`,
    );
  }

  private async branchExists(commonDir: string, branch: string): Promise<boolean> {
    try {
      await this.git.exec(["--git-dir", commonDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch (error) {
      if (hasExitCode(error) && error.code === 1) return false;
      throw new Error(`Could not inspect worktree branch ${branch}: ${errorMessage(error)}`);
    }
  }

  private worktreePath(repositoryName: string, commonDir: string, runId: string): string {
    const stableId = createHash("sha256").update(commonDir).digest("hex").slice(0, 10);
    return join(this.root, `${repositoryName}-${stableId}`, runId);
  }

  private async gitValue(args: string[], context: string): Promise<string> {
    try {
      return (await this.git.exec(args)).stdout.trim();
    } catch (error) {
      throw new Error(`${context}: ${errorMessage(error)}`);
    }
  }

  private async rollbackPartial(worktree: WorktreeRecord): Promise<void> {
    const expectedBranch = `refs/heads/${worktree.branch}`;
    const registered = await this.registeredWorktree(worktree.path, worktree.gitCommonDir);
    if (registered && registered.branch !== expectedBranch) {
      throw new Error(`Partial worktree registration uses unexpected branch ${registered.branch ?? "(detached)"}`);
    }
    if (registered) {
      await this.git.exec(["--git-dir", worktree.gitCommonDir, "worktree", "remove", worktree.path]);
    }
    if (await this.registeredWorktree(worktree.path, worktree.gitCommonDir) || await pathExists(worktree.path)) {
      throw new Error(`Partial worktree resources remain at ${worktree.path}`);
    }
  }

  private async assertBranchNameReservation(worktree: WorktreeRecord): Promise<void> {
    const runId = worktree.branch.slice("heishi/".length);
    const ownerRef = branchNameReservationRef(runId);
    if (!await this.refExists(worktree.gitCommonDir, ownerRef)) {
      throw new Error(`Worktree branch name reservation is missing: ${worktree.branch}`);
    }
    const ownerCommit = await this.gitValue(
      ["--git-dir", worktree.gitCommonDir, "rev-parse", "--verify", ownerRef],
      `Could not inspect branch name reservation for ${worktree.branch}`,
    );
    if (ownerCommit !== worktree.baseCommit) {
      throw new Error(`Worktree branch name reservation is inconsistent: ${worktree.branch}`);
    }
  }

  private async reserveBranchName(worktree: WorktreeRecord): Promise<void> {
    const runId = worktree.branch.slice("heishi/".length);
    const branchRef = `refs/heads/${worktree.branch}`;
    const ownerRef = branchNameReservationRef(runId);
    const transaction = [
      "start",
      `create ${branchRef} ${worktree.baseCommit}`,
      `create ${ownerRef} ${worktree.baseCommit}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    await this.execRefTransaction(
      ["--git-dir", worktree.gitCommonDir, "update-ref", "--create-reflog", "-m", ownershipMessage(runId), "--stdin"],
      transaction,
    );
  }

  private async execRefTransaction(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
    if (this.git.execStdin) return this.git.execStdin(args, stdin);
    return new GitCommand().execStdin(args, stdin);
  }

  private async refExists(commonDir: string, reference: string): Promise<boolean> {
    try {
      await this.git.exec(["--git-dir", commonDir, "show-ref", "--verify", "--quiet", reference]);
      return true;
    } catch (error) {
      if (hasExitCode(error) && error.code === 1) return false;
      throw new Error(`Could not inspect Git ref ${reference}: ${errorMessage(error)}`);
    }
  }
}

export function worktreeCwd(worktree: WorktreeRecord): string {
  return worktree.relativeCwd === "." ? worktree.path : join(worktree.path, worktree.relativeCwd);
}

function removedRecord(worktree: WorktreeRecord, resumeCommit: string): WorktreeRecord {
  const { resumeCommit: _previousResumeCommit, ...record } = worktree;
  return { ...record, state: "removed", resumeCommit };
}

function presentRecord(worktree: WorktreeRecord): WorktreeRecord {
  const { resumeCommit: _resumeCommit, ...record } = worktree;
  return { ...record, state: "present" };
}

function isSafeRepositoryName(value: string): boolean {
  return value.trim().length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function ownershipMessage(runId: string): string {
  return `heishi: own worktree branch for run ${runId}`;
}

function retainedRefsWarning(worktree: WorktreeRecord): string {
  return `Worktree branch ${worktree.branch} and its internal lease were retained for manual recovery; Heishi does not delete refs`;
}

function branchNameReservationRef(runId: string): string {
  return `refs/heishi/worktree-owners/${runId}`;
}

async function pathIdentity(path: string): Promise<string> {
  const canonical = await realpathIfExists(path, `Could not resolve worktree path identity for ${path}`);
  if (canonical) return canonical;
  const canonicalParent = await realpathIfExists(
    dirname(path),
    `Could not resolve parent path identity for ${path}`,
  );
  return canonicalParent ? join(canonicalParent, basename(path)) : resolve(path);
}

async function requiredRealpath(path: string, context: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

async function realpathIfExists(path: string, context: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hasExitCode(error: unknown): error is Error & { code: number } {
  return error instanceof Error && "code" in error && typeof error.code === "number";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
