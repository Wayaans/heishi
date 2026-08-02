import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface LeaseOwner {
  version: 1;
  runId: string;
  cwd: string;
  pid: number;
  createdAt: string;
  tmuxTarget?: string;
}

export interface ProcessIdentity {
  pid: number;
  isAlive(pid: number): boolean;
}

export interface LeaseHandle {
  setTmuxTarget(target: string): Promise<void>;
  release(): Promise<void>;
}

const PANE_REGISTRATION_GRACE_MS = 30_000;

const currentProcess: ProcessIdentity = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export class MutationLease {
  constructor(
    private readonly root = join(tmpdir(), `heishi-locks-${process.getuid?.() ?? "user"}`),
    private readonly processIdentity: ProcessIdentity = currentProcess,
    private readonly paneExists: (target: string) => Promise<boolean> = async () => false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acquire(cwd: string, runId: string): Promise<LeaseHandle> {
    const canonicalCwd = await realpath(cwd);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, createHash("sha256").update(canonicalCwd).digest("hex"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const owner: LeaseOwner = {
          version: 1,
          runId,
          cwd: canonicalCwd,
          pid: this.processIdentity.pid,
          createdAt: this.now().toISOString(),
        };
        await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        return {
          setTmuxTarget: async (target) => {
            const current = await readOwner(lockPath);
            if (current.runId !== runId || current.pid !== this.processIdentity.pid) {
              throw new Error("Subagent mutation lease ownership changed before pane registration");
            }
            current.tmuxTarget = target;
            await writeFile(join(lockPath, "owner.json"), JSON.stringify(current), { mode: 0o600 });
          },
          release: async () => {
            const current = await readOwner(lockPath);
            if (current.runId === runId && current.pid === this.processIdentity.pid) {
              await rm(lockPath, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = await readOwner(lockPath);
        if (await this.ownerIsLive(owner)) throw leaseOwnedError(owner, canonicalCwd);

        const cleanupPath = join(lockPath, ".cleanup");
        try {
          await mkdir(cleanupPath);
        } catch (cleanupError) {
          const code = (cleanupError as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ENOENT") continue;
          throw cleanupError;
        }

        owner = await readOwner(lockPath);
        if (await this.ownerIsLive(owner)) {
          await rm(cleanupPath, { recursive: true, force: true });
          throw leaseOwnedError(owner, canonicalCwd);
        }
        await rm(lockPath, { recursive: true, force: true });
      }
    }

    throw new Error(`Could not acquire the mutation lease for ${canonicalCwd}`);
  }

  private async ownerIsLive(owner: LeaseOwner): Promise<boolean> {
    if (owner.tmuxTarget) return this.paneExists(owner.tmuxTarget).catch(() => true);
    if (this.processIdentity.isAlive(owner.pid)) return true;
    const age = this.now().getTime() - Date.parse(owner.createdAt);
    return age < PANE_REGISTRATION_GRACE_MS;
  }
}

function leaseOwnedError(owner: LeaseOwner, cwd: string): Error {
  return new Error(`A subagent (${owner.runId}) already owns the mutation lease for ${cwd}`);
}

async function readOwner(lockPath: string): Promise<LeaseOwner> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot safely inspect existing subagent lease: ${errorMessage(error)}`);
  }
  if (!isLeaseOwner(value)) throw new Error("Cannot safely inspect malformed subagent lease owner data");
  return value;
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Record<string, unknown>;
  return owner["version"] === 1
    && typeof owner["runId"] === "string"
    && typeof owner["cwd"] === "string"
    && typeof owner["pid"] === "number"
    && typeof owner["createdAt"] === "string"
    && Number.isFinite(Date.parse(owner["createdAt"]))
    && (owner["tmuxTarget"] === undefined || typeof owner["tmuxTarget"] === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
