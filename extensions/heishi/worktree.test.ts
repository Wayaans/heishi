import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GitCommand, GitWorktrees, WorktreeOperationError, worktreeCwd, type GitCommandExecutor } from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function executeGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { encoding: "utf8" });
}

async function executeGitStdin(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
  return new GitCommand().execStdin(args, stdin);
}

async function repositoryFixture(): Promise<{ root: string; repository: string; nested: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "heishi-worktree-"));
  const repository = join(root, "example-repo");
  const nested = join(repository, "src", "nested");
  const agentDir = join(root, "agent");
  await mkdir(nested, { recursive: true });
  await writeFile(join(repository, "README.md"), "initial\n");
  await writeFile(join(repository, ".gitignore"), "ignored.txt\nignored-only/\n");
  await writeFile(join(repository, "ignored.txt"), "ignored\n");
  await writeFile(join(nested, "tracked.txt"), "tracked\n");
  await git(repository, "init");
  await git(repository, "config", "user.name", "Heishi Test");
  await git(repository, "config", "user.email", "heishi@example.test");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "initial");
  return { root, repository, nested, agentDir };
}

describe("Git worktree workspaces", () => {
  it("creates a stable managed path from exact HEAD and preserves the nested cwd", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const record = await manager.prepare(fixture.nested, "12345678-1234-1234-1234-123456789abc");

      assert.equal(record.branch, "heishi/12345678-1234-1234-1234-123456789abc");
      assert.equal(record.baseCommit, baseCommit);
      assert.equal(record.relativeCwd, "src/nested");
      assert.match(record.path, /agent\/heishi\/worktrees\/example-repo-[a-f0-9]{10}\/12345678-1234-1234-1234-123456789abc$/u);
      assert.equal(await git(record.path, "rev-parse", "HEAD"), baseCommit);
      assert.equal(await git(record.path, "branch", "--show-current"), record.branch);
      assert.equal(
        await git(fixture.repository, "rev-parse", "refs/heishi/worktree-owners/12345678-1234-1234-1234-123456789abc"),
        baseCommit,
      );
      assert.equal(worktreeCwd(record), join(record.path, "src", "nested"));
      assert.equal(await lstat(join(record.path, "ignored.txt")).then(() => true, () => false), false);

      const second = await manager.prepare(record.path, "abcdefab-1234-1234-1234-123456789abc");
      assert.equal(second.repositoryName, record.repositoryName);
      assert.equal(dirname(second.path), dirname(record.path));

      const secondRolledBack = await manager.rollback(second);
      assert.equal(secondRolledBack.worktree.state, "removed");
      assert.equal(secondRolledBack.worktree.state === "removed" ? secondRolledBack.worktree.resumeCommit : undefined, baseCommit);
      assert.match(secondRolledBack.warning ?? "", /branch .* internal lease were retained for manual recovery/u);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/${second.branch}`), baseCommit);

      const rolledBack = await manager.rollback(record);
      assert.equal(rolledBack.worktree.state, "removed");
      assert.equal(rolledBack.worktree.state === "removed" ? rolledBack.worktree.resumeCommit : undefined, baseCommit);
      assert.match(rolledBack.warning ?? "", /does not delete refs/u);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/${record.branch}`), baseCommit);
      assert.equal(
        await git(fixture.repository, "rev-parse", "refs/heishi/worktree-owners/12345678-1234-1234-1234-123456789abc"),
        baseCommit,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("atomically owns branch creation and does not delete a competing branch", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-branch-race";
      const reference = `refs/heads/heishi/${runId}`;
      const ownerReference = `refs/heishi/worktree-owners/${runId}`;
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      let insertedCompetingBranch = false;
      let deleteAttempts = 0;
      const executor: GitCommandExecutor = {
        exec: executeGit,
        async execStdin(args, stdin) {
          if (stdin.includes(`create ${reference} `) && !insertedCompetingBranch) {
            insertedCompetingBranch = true;
            await git(fixture.repository, "update-ref", reference, baseCommit);
          }
          if (stdin.includes(`delete ${reference} `)) deleteAttempts += 1;
          return executeGitStdin(args, stdin);
        },
      };

      await assert.rejects(
        () => new GitWorktrees(fixture.agentDir, executor).prepare(fixture.repository, runId),
        /Could not create Git worktree/u,
      );

      assert.equal(insertedCompetingBranch, true);
      assert.equal(deleteAttempts, 0);
      assert.equal(await git(fixture.repository, "rev-parse", reference), baseCommit);
      assert.equal(await git(fixture.repository, "show-ref", "--verify", ownerReference).then(() => true, () => false), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains the branch and lease if the branch moves before creation rollback", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-branch-moved";
      const reference = `refs/heads/heishi/${runId}`;
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const movedCommit = await git(fixture.repository, "commit-tree", `${baseCommit}^{tree}`, "-p", baseCommit, "-m", "moved");
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args[2] === "worktree" && args[3] === "add") {
            await git(fixture.repository, "update-ref", reference, movedCommit, baseCommit);
            throw new Error("simulated worktree add failure");
          }
          return executeGit(args);
        },
      };

      const error = await new GitWorktrees(fixture.agentDir, executor).prepare(fixture.repository, runId)
        .then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "removed");
      assert.equal(error.worktree.state === "removed" ? error.worktree.resumeCommit : undefined, movedCommit);
      assert.match(error.message, /branch .* internal lease were retained for manual recovery/u);
      assert.equal(await git(fixture.repository, "rev-parse", reference), movedCommit);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`), baseCommit);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains both refs after a worktree add failure", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-add-failure";
      const branchRef = `refs/heads/heishi/${runId}`;
      const ownerRef = `refs/heishi/worktree-owners/${runId}`;
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args[2] === "worktree" && args[3] === "add") throw new Error("simulated worktree add failure");
          return executeGit(args);
        },
      };

      const error = await new GitWorktrees(fixture.agentDir, executor).prepare(fixture.repository, runId)
        .then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "removed");
      assert.equal(error.worktree.state === "removed" ? error.worktree.resumeCommit : undefined, baseCommit);
      assert.match(error.message, /internal lease were retained.*does not delete refs/u);
      assert.equal(await git(fixture.repository, "rev-parse", branchRef), baseCommit);
      assert.equal(await git(fixture.repository, "rev-parse", ownerRef), baseCommit);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps present metadata and both refs when prelaunch rollback cannot remove the worktree", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-rollback-refused";
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args[2] === "worktree" && args[3] === "remove") {
            throw new Error("simulated rollback refusal");
          }
          return executeGit(args);
        },
        execStdin: executeGitStdin,
      };
      const manager = new GitWorktrees(fixture.agentDir, executor);
      const record = await manager.prepare(fixture.repository, runId);

      const error = await manager.rollback(record).then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "present");
      assert.match(error.message, /rollback refusal.*retained for manual recovery/u);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/${record.branch}`), baseCommit);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`), baseCommit);
      assert.match(await git(fixture.repository, "worktree", "list", "--porcelain"), new RegExp(runId, "u"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns present metadata when creation rollback fails after reservation", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-create-rollback-refused";
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const movedCommit = await git(fixture.repository, "commit-tree", `${baseCommit}^{tree}`, "-p", baseCommit, "-m", "moved");
      let added = false;
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (!added && args[2] === "worktree" && args[3] === "add") {
            const result = await executeGit(args);
            added = true;
            await git(fixture.repository, "update-ref", `refs/heads/heishi/${runId}`, movedCommit, baseCommit);
            return result;
          }
          if (added && args[2] === "worktree" && args[3] === "remove") {
            throw new Error("simulated creation rollback refusal");
          }
          return executeGit(args);
        },
        execStdin: executeGitStdin,
      };

      const error = await new GitWorktrees(fixture.agentDir, executor).prepare(fixture.repository, runId)
        .then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "present");
      assert.match(error.message, /rollback failed.*creation rollback refusal.*retained for manual recovery/u);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/heishi/${runId}`), movedCommit);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`), baseCommit);
      assert.match(await git(fixture.repository, "worktree", "list", "--porcelain"), new RegExp(runId, "u"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains a same-base recreated branch and its lease without attempting deletion", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-branch-aba";
      const reference = `refs/heads/heishi/${runId}`;
      const ownerReference = `refs/heishi/worktree-owners/${runId}`;
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      let replaced = false;
      const transactions: string[] = [];
      const executor: GitCommandExecutor = {
        async exec(args) {
          const result = await executeGit(args);
          if (!replaced && args[2] === "worktree" && args[3] === "remove") {
            replaced = true;
            await git(fixture.repository, "update-ref", "-d", reference, baseCommit);
            await git(
              fixture.repository,
              "update-ref", "--create-reflog", "-m", "competing recreation",
              reference, baseCommit, "",
            );
          }
          return result;
        },
        async execStdin(args, stdin) {
          transactions.push(stdin);
          return executeGitStdin(args, stdin);
        },
      };
      const manager = new GitWorktrees(fixture.agentDir, executor);
      const record = await manager.prepare(fixture.repository, runId);

      const rollback = await manager.rollback(record);

      assert.equal(replaced, true);
      assert.equal(rollback.worktree.state, "removed");
      assert.equal(rollback.worktree.state === "removed" ? rollback.worktree.resumeCommit : undefined, baseCommit);
      assert.match(rollback.warning ?? "", /internal lease were retained.*does not delete refs/u);
      assert.match(transactions[0] ?? "", new RegExp(`create ${reference}`, "u"));
      assert.match(transactions[0] ?? "", new RegExp(`create ${ownerReference}`, "u"));
      assert.equal(transactions.length, 1);
      assert.equal(await git(fixture.repository, "rev-parse", reference), baseCommit);
      assert.equal(await git(fixture.repository, "rev-parse", ownerReference), baseCommit);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a worktree whose HEAD moves after add and retains the moved branch", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-head-race";
      const reference = `refs/heads/heishi/${runId}`;
      const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
      const movedCommit = await git(fixture.repository, "commit-tree", `${baseCommit}^{tree}`, "-p", baseCommit, "-m", "moved");
      let movedAfterAdd = false;
      const executor: GitCommandExecutor = {
        async exec(args) {
          const result = await executeGit(args);
          if (!movedAfterAdd && args[2] === "worktree" && args[3] === "add") {
            movedAfterAdd = true;
            await git(fixture.repository, "update-ref", reference, movedCommit, baseCommit);
          }
          return result;
        },
      };

      const error = await new GitWorktrees(fixture.agentDir, executor).prepare(fixture.repository, runId)
        .then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "removed");
      assert.equal(error.worktree.state === "removed" ? error.worktree.resumeCommit : undefined, movedCommit);
      assert.match(error.message, /Created worktree HEAD.*does not match source HEAD.*internal lease were retained/u);
      assert.equal(await git(fixture.repository, "rev-parse", reference), movedCommit);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`), baseCommit);
      assert.doesNotMatch(await git(fixture.repository, "worktree", "list", "--porcelain"), new RegExp(runId, "u"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects non-Git and dirty source directories without creating a worktree", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const outside = join(fixture.root, "outside");
      await mkdir(outside);
      await assert.rejects(
        () => manager.prepare(outside, "run-non-git"),
        /not a Git checkout/u,
      );

      await writeFile(join(fixture.repository, "untracked.txt"), "dirty\n");
      await assert.rejects(
        () => manager.prepare(fixture.repository, "run-dirty"),
        /clean source checkout.*untracked/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recreates an ignored-only nested source cwd as an empty directory", async () => {
    const fixture = await repositoryFixture();
    try {
      const ignoredCwd = join(fixture.repository, "ignored-only", "nested");
      await mkdir(ignoredCwd, { recursive: true });
      await writeFile(join(ignoredCwd, "local.txt"), "ignored\n");

      const record = await new GitWorktrees(fixture.agentDir).prepare(ignoredCwd, "run-ignored-cwd");

      assert.equal(record.relativeCwd, "ignored-only/nested");
      assert.deepEqual(await readdir(worktreeCwd(record)), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports branch inspection errors instead of treating them as absence", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const removed = await manager.cleanup(await manager.prepare(fixture.repository, "run-inspection-error"));
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args.includes("show-ref")) {
            throw Object.assign(new Error("permission denied while reading refs"), { code: 128 });
          }
          return executeGit(args);
        },
      };

      await assert.rejects(
        () => new GitWorktrees(fixture.agentDir, executor).prepareResume(removed),
        /Could not inspect worktree branch.*permission denied while reading refs/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses dirty cleanup and recreates a removed worktree from its retained branch", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const record = await manager.prepare(fixture.repository, "run-cleanup");
      await writeFile(join(record.path, "result.txt"), "result\n");
      await assert.rejects(() => manager.cleanup(record), /modified, untracked, or ignored files/u);

      await git(record.path, "add", "result.txt");
      await git(record.path, "commit", "-m", "worker result");
      const retainedCommit = await git(record.path, "rev-parse", "HEAD");
      await writeFile(join(record.path, "ignored.txt"), "local ignored output\n");
      await assert.rejects(() => manager.cleanup(record), /modified, untracked, or ignored files/u);
      await rm(join(record.path, "ignored.txt"));

      const removed = await manager.cleanup(record);
      assert.equal(removed.state, "removed");
      assert.equal(removed.state === "removed" ? removed.resumeCommit : undefined, retainedCommit);
      assert.equal(record.baseCommit, removed.baseCommit);
      assert.equal(await git(fixture.repository, "show-ref", "--verify", `refs/heads/${record.branch}`).then(() => true), true);
      assert.equal(
        await git(fixture.repository, "show-ref", "--verify", "refs/heishi/worktree-owners/run-cleanup").then(() => true),
        true,
      );

      const recreated = await manager.prepareResume(removed);
      assert.equal(recreated.state, "present");
      assert.equal(recreated.resumeCommit, undefined);
      assert.equal(recreated.path, record.path);
      assert.equal(await git(recreated.path, "rev-parse", "HEAD"), retainedCommit);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports removed metadata when retained refs change immediately after cleanup removal", async () => {
    const races = [
      { kind: "move-branch", error: /retained refs are inconsistent.*branch .* moved from resume commit/u },
      { kind: "delete-branch", error: /retained refs are inconsistent.*Retained worktree branch is missing/u },
      { kind: "move-lease", error: /retained refs are inconsistent.*reservation is inconsistent/u },
      { kind: "delete-lease", error: /retained refs are inconsistent.*reservation is missing/u },
    ] as const;

    for (const race of races) {
      const fixture = await repositoryFixture();
      try {
        const runId = `run-cleanup-${race.kind}`;
        const branchRef = `refs/heads/heishi/${runId}`;
        const leaseRef = `refs/heishi/worktree-owners/${runId}`;
        const baseManager = new GitWorktrees(fixture.agentDir);
        const record = await baseManager.prepare(fixture.repository, runId);
        const resumeCommit = await git(record.path, "rev-parse", "HEAD");
        const movedCommit = await git(
          fixture.repository,
          "commit-tree", `${resumeCommit}^{tree}`, "-p", resumeCommit, "-m", race.kind,
        );
        let mutated = false;
        const executor: GitCommandExecutor = {
          async exec(args) {
            const result = await executeGit(args);
            if (!mutated && args[2] === "worktree" && args[3] === "remove") {
              mutated = true;
              if (race.kind === "move-branch") {
                await git(fixture.repository, "update-ref", branchRef, movedCommit, resumeCommit);
              } else if (race.kind === "delete-branch") {
                await git(fixture.repository, "update-ref", "-d", branchRef, resumeCommit);
              } else if (race.kind === "move-lease") {
                await git(fixture.repository, "update-ref", leaseRef, movedCommit, record.baseCommit);
              } else {
                await git(fixture.repository, "update-ref", "-d", leaseRef, record.baseCommit);
              }
            }
            return result;
          },
        };

        const error = await new GitWorktrees(fixture.agentDir, executor).cleanup(record)
          .then(() => undefined, (failure: unknown) => failure);

        assert.ok(error instanceof WorktreeOperationError);
        assert.equal(mutated, true);
        assert.equal(error.worktree.state, "removed");
        assert.equal(error.worktree.state === "removed" ? error.worktree.resumeCommit : undefined, resumeCommit);
        assert.match(error.message, race.error);
        assert.equal(await lstat(record.path).then(() => true, () => false), false);
        assert.doesNotMatch(await git(fixture.repository, "worktree", "list", "--porcelain"), new RegExp(runId, "u"));
        if (race.kind === "move-branch") {
          assert.equal(await git(fixture.repository, "rev-parse", branchRef), movedCommit);
        } else if (race.kind === "delete-branch") {
          assert.equal(await git(fixture.repository, "show-ref", "--verify", branchRef).then(() => true, () => false), false);
        } else if (race.kind === "move-lease") {
          assert.equal(await git(fixture.repository, "rev-parse", leaseRef), movedCommit);
        } else {
          assert.equal(await git(fixture.repository, "show-ref", "--verify", leaseRef).then(() => true, () => false), false);
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects resume of a present worktree when its branch name reservation is missing", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const present = await manager.prepare(fixture.repository, "run-present-owner-missing");
      await git(fixture.repository, "update-ref", "-d", "refs/heishi/worktree-owners/run-present-owner-missing");

      await assert.rejects(
        () => manager.prepareResume(present),
        /branch name reservation is missing/u,
      );
      assert.equal(await lstat(present.path).then(() => true, () => false), true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects resume of a present worktree when its visible branch ref is missing", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-present-branch-missing";
      const manager = new GitWorktrees(fixture.agentDir);
      const present = await manager.prepare(fixture.repository, runId);
      await git(fixture.repository, "update-ref", "-d", `refs/heads/${present.branch}`);

      await assert.rejects(
        () => manager.prepareResume(present),
        /Present worktree branch is missing or unborn/u,
      );
      assert.equal(await lstat(present.path).then(() => true, () => false), true);
      assert.equal(
        await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`),
        present.baseCommit,
      );
      assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).includes(present.path), true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects resume of a present worktree when its branch moves after HEAD is resolved", async () => {
    const fixture = await repositoryFixture();
    try {
      const runId = "run-present-branch-race";
      let presentPath: string | undefined;
      let moved = false;
      let movedCommit = "";
      const executor: GitCommandExecutor = {
        async exec(args) {
          const result = await executeGit(args);
          if (
            !moved
            && presentPath !== undefined
            && args[0] === "-C"
            && args[1] === presentPath
            && args[2] === "rev-parse"
            && args[3] === "HEAD"
          ) {
            moved = true;
            await git(fixture.repository, "update-ref", `refs/heads/heishi/${runId}`, movedCommit);
          }
          return result;
        },
        execStdin: executeGitStdin,
      };
      const manager = new GitWorktrees(fixture.agentDir, executor);
      const present = await manager.prepare(fixture.repository, runId);
      presentPath = present.path;
      movedCommit = await git(
        fixture.repository,
        "commit-tree", `${present.baseCommit}^{tree}`, "-p", present.baseCommit, "-m", "moved during present resume",
      );

      await assert.rejects(
        () => manager.prepareResume(present),
        /Present worktree HEAD .* does not match branch .* tip/u,
      );
      assert.equal(moved, true);
      assert.equal(await lstat(present.path).then(() => true, () => false), true);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/${present.branch}`), movedCommit);
      assert.equal(
        await git(fixture.repository, "rev-parse", `refs/heishi/worktree-owners/${runId}`),
        present.baseCommit,
      );
      assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).includes(present.path), true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects resume when the retained branch name reservation is missing", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const removed = await manager.cleanup(await manager.prepare(fixture.repository, "run-resume-owner-missing"));
      await git(fixture.repository, "update-ref", "-d", "refs/heishi/worktree-owners/run-resume-owner-missing");

      await assert.rejects(
        () => manager.prepareResume(removed),
        /branch name reservation is missing/u,
      );
      assert.equal(await lstat(removed.path).then(() => true, () => false), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects resume when the retained branch changed before add", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const record = await manager.prepare(fixture.repository, "run-resume-before-race");
      const removed = await manager.cleanup(record);
      const resumeCommit = removed.state === "removed" ? removed.resumeCommit : "";
      const movedCommit = await git(
        fixture.repository,
        "commit-tree", `${resumeCommit}^{tree}`, "-p", resumeCommit, "-m", "moved before resume",
      );
      await git(fixture.repository, "update-ref", `refs/heads/${record.branch}`, movedCommit, resumeCommit);

      await assert.rejects(
        () => manager.prepareResume(removed),
        /moved from resume commit.*to/u,
      );
      assert.equal(await lstat(record.path).then(() => true, () => false), false);
      assert.doesNotMatch(await git(fixture.repository, "worktree", "list", "--porcelain"), /run-resume-before-race/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back recreation when the retained branch changes during add", async () => {
    const fixture = await repositoryFixture();
    try {
      const baseManager = new GitWorktrees(fixture.agentDir);
      const record = await baseManager.prepare(fixture.repository, "run-resume-during-race");
      const removed = await baseManager.cleanup(record);
      const resumeCommit = removed.state === "removed" ? removed.resumeCommit : "";
      const movedCommit = await git(
        fixture.repository,
        "commit-tree", `${resumeCommit}^{tree}`, "-p", resumeCommit, "-m", "moved during resume",
      );
      let movedDuringAdd = false;
      const executor: GitCommandExecutor = {
        async exec(args) {
          const result = await executeGit(args);
          if (!movedDuringAdd && args[2] === "worktree" && args[3] === "add") {
            movedDuringAdd = true;
            await git(fixture.repository, "update-ref", `refs/heads/${record.branch}`, movedCommit, resumeCommit);
          }
          return result;
        },
      };

      await assert.rejects(
        () => new GitWorktrees(fixture.agentDir, executor).prepareResume(removed),
        /changed from resume commit/u,
      );
      assert.equal(movedDuringAdd, true);
      assert.equal(await lstat(record.path).then(() => true, () => false), false);
      assert.doesNotMatch(await git(fixture.repository, "worktree", "list", "--porcelain"), /run-resume-during-race/u);
      assert.equal(await git(fixture.repository, "rev-parse", `refs/heads/${record.branch}`), movedCommit);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back recreation when the branch name reservation disappears during add", async () => {
    const fixture = await repositoryFixture();
    try {
      const baseManager = new GitWorktrees(fixture.agentDir);
      const record = await baseManager.prepare(fixture.repository, "run-resume-owner-race");
      const removed = await baseManager.cleanup(record);
      let removedDuringAdd = false;
      const executor: GitCommandExecutor = {
        async exec(args) {
          const result = await executeGit(args);
          if (!removedDuringAdd && args[2] === "worktree" && args[3] === "add") {
            removedDuringAdd = true;
            await git(fixture.repository, "update-ref", "-d", "refs/heishi/worktree-owners/run-resume-owner-race");
          }
          return result;
        },
      };

      await assert.rejects(
        () => new GitWorktrees(fixture.agentDir, executor).prepareResume(removed),
        /branch name reservation is missing/u,
      );
      assert.equal(removedDuringAdd, true);
      assert.equal(await lstat(record.path).then(() => true, () => false), false);
      assert.doesNotMatch(await git(fixture.repository, "worktree", "list", "--porcelain"), /run-resume-owner-race/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports present state when partial resume registration cannot be rolled back", async () => {
    const fixture = await repositoryFixture();
    try {
      const baseManager = new GitWorktrees(fixture.agentDir);
      const record = await baseManager.prepare(fixture.repository, "run-resume-rollback-failure");
      const removed = await baseManager.cleanup(record);
      let addCompleted = false;
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args[2] === "worktree" && args[3] === "add") {
            const result = await executeGit(args);
            addCompleted = true;
            throw new Error("simulated failure after registration");
          }
          if (addCompleted && args[2] === "worktree" && args[3] === "remove") {
            throw new Error("simulated rollback refusal");
          }
          return executeGit(args);
        },
      };

      const error = await new GitWorktrees(fixture.agentDir, executor).prepareResume(removed)
        .then(() => undefined, (failure: unknown) => failure);

      assert.ok(error instanceof WorktreeOperationError);
      assert.equal(error.worktree.state, "present");
      assert.match(error.message, /rollback failed.*rollback refusal/u);
      assert.match(await git(fixture.repository, "worktree", "list", "--porcelain"), /run-resume-rollback-failure/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces non-ENOENT realpath failures for managed metadata and path identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "heishi-worktree-path-errors-"));
    try {
      const agentDir = join(root, "agent");
      const loop = join(root, "git-loop");
      await symlink("git-loop", loop);
      const runId = "run-common-loop";
      const repositoryName = "repo";
      const stableId = createHash("sha256").update(loop).digest("hex").slice(0, 10);
      const loopRecord = {
        path: join(agentDir, "heishi", "worktrees", `${repositoryName}-${stableId}`, runId),
        branch: `heishi/${runId}`,
        baseCommit: "abc123",
        state: "present" as const,
        gitCommonDir: loop,
        repositoryName,
        relativeCwd: ".",
      };
      await assert.rejects(
        () => new GitWorktrees(agentDir).rollback(loopRecord),
        /Could not resolve worktree Git common directory.*(symbolic links|ELOOP)/ui,
      );

      const commonDir = await realpath(await mkdir(join(root, "common"), { recursive: true }).then(() => join(root, "common")));
      const identityRunId = "run-path-loop";
      const identityStableId = createHash("sha256").update(commonDir).digest("hex").slice(0, 10);
      const path = join(agentDir, "heishi", "worktrees", `repo-${identityStableId}`, identityRunId);
      await mkdir(dirname(path), { recursive: true });
      await symlink(identityRunId, path);
      const executor: GitCommandExecutor = {
        async exec(args) {
          if (args.includes("list")) {
            return {
              stdout: `worktree ${path}\nbranch refs/heads/heishi/${identityRunId}\n`,
              stderr: "",
            };
          }
          throw new Error(`Unexpected Git command: ${args.join(" ")}`);
        },
      };
      await assert.rejects(
        () => new GitWorktrees(agentDir, executor).rollback({
          path,
          branch: `heishi/${identityRunId}`,
          baseCommit: "abc123",
          state: "present",
          gitCommonDir: commonDir,
          repositoryName: "repo",
          relativeCwd: ".",
        }),
        /Could not resolve worktree path identity.*(symbolic links|ELOOP)/ui,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to recreate into an occupied removed path", async () => {
    const fixture = await repositoryFixture();
    try {
      const manager = new GitWorktrees(fixture.agentDir);
      const record = await manager.prepare(fixture.repository, "run-occupied");
      const removed = await manager.cleanup(record);
      await mkdir(removed.path, { recursive: true });

      await assert.rejects(() => manager.prepareResume(removed), /path is occupied/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
