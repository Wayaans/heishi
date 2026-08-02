import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { MutationLease } from "./lease.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "heishi-lease-test-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  roots.push(root);
  return { root, cwd };
}

describe("mutation lease", () => {
  it("allows only one live owner for a canonical working directory", async () => {
    const { root, cwd } = await fixture();
    const lease = new MutationLease(join(root, "locks"));
    const handle = await lease.acquire(cwd, "run-one");

    await assert.rejects(() => lease.acquire(cwd, "run-two"), /run-one/);
    await handle.release();
    const next = await lease.acquire(cwd, "run-two");
    await next.release();
  });

  it("cleans a lock whose owning process is dead", async () => {
    const { root, cwd } = await fixture();
    const lockRoot = join(root, "locks");
    const formerOwner = new MutationLease(
      lockRoot,
      { pid: 111, isAlive: () => true },
      async () => false,
      () => new Date("2024-01-01T00:00:00.000Z"),
    );
    await formerOwner.acquire(cwd, "dead-run");

    const lease = new MutationLease(
      lockRoot,
      { pid: 222, isAlive: () => false },
      async () => false,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const handle = await lease.acquire(cwd, "new-run");
    await handle.release();
  });

  it("keeps a fresh lock during the pane-registration startup window", async () => {
    const { root, cwd } = await fixture();
    const lockRoot = join(root, "locks");
    const formerOwner = new MutationLease(
      lockRoot,
      { pid: 111, isAlive: () => true },
      async () => false,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    await formerOwner.acquire(cwd, "starting-run");
    const nextParent = new MutationLease(
      lockRoot,
      { pid: 222, isAlive: () => false },
      async () => false,
      () => new Date("2026-01-01T00:00:01.000Z"),
    );

    await assert.rejects(() => nextParent.acquire(cwd, "new-run"), /starting-run/);
  });

  it("does not let stale-lock contenders delete the new owner", async () => {
    const { root, cwd } = await fixture();
    const lockRoot = join(root, "locks");
    const formerOwner = new MutationLease(
      lockRoot,
      { pid: 111, isAlive: () => true },
      async () => false,
      () => new Date("2024-01-01T00:00:00.000Z"),
    );
    await formerOwner.acquire(cwd, "dead-run");
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const contenderA = new MutationLease(lockRoot, { pid: 222, isAlive: () => false }, async () => false, now);
    const contenderB = new MutationLease(
      lockRoot,
      { pid: 333, isAlive: (pid) => pid === 222 || pid === 333 },
      async () => false,
      now,
    );

    const attempts = await Promise.allSettled([
      contenderA.acquire(cwd, "run-a"),
      contenderB.acquire(cwd, "run-b"),
    ]);
    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    assert.equal(winners.length, 1);

    const verifier = new MutationLease(lockRoot, { pid: 444, isAlive: () => true });
    await assert.rejects(() => verifier.acquire(cwd, "run-c"), /already owns/);
  });

  it("keeps the lease live while the worker pane survives its parent", async () => {
    const { root, cwd } = await fixture();
    const lockRoot = join(root, "locks");
    const formerOwner = new MutationLease(lockRoot, { pid: 111, isAlive: () => true }, async () => true);
    const formerHandle = await formerOwner.acquire(cwd, "worker-run");
    await formerHandle.setTmuxTarget("%17");

    const nextParent = new MutationLease(lockRoot, { pid: 222, isAlive: () => false }, async () => true);
    await assert.rejects(() => nextParent.acquire(cwd, "new-run"), /worker-run/);
  });
});
