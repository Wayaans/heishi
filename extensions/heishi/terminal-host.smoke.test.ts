import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Cmux } from "./cmux.js";
import type { CmuxHostTarget } from "./terminal-host.js";
import { Tmux, type TmuxTarget } from "./tmux.js";

it("runs the real cmux placement, focus, and cleanup smoke matrix", {
  skip: process.env["HEISHI_REAL_CMUX_SMOKE"] !== "1",
}, async () => {
  const cmux = new Cmux();
  const directories: string[] = [];
  const targets: CmuxHostTarget[] = [];
  await cmux.validate();
  try {
    for (const placement of ["pane", "window"] as const) {
      const launcherDirectory = await mkdtemp(join(tmpdir(), "heishi-cmux-smoke-"));
      directories.push(launcherDirectory);
      const target = await cmux.launch({
        placement,
        cwd: process.cwd(),
        title: `Heishi smoke ${placement}`,
        command: ["/bin/sleep", "10"],
        environment: { HEISHI_SMOKE: "1" },
        launcherDirectory,
      });
      targets.push(target);
      assert.equal(await cmux.exists(target), true);
      await cmux.focus(target);
    }

    const sessionDirectories = await Promise.all([
      mkdtemp(join(tmpdir(), "heishi-cmux-smoke-")),
      mkdtemp(join(tmpdir(), "heishi-cmux-smoke-")),
    ]);
    directories.push(...sessionDirectories);
    const sessionTargets = await Promise.all(sessionDirectories.map((launcherDirectory, index) => cmux.launch({
      placement: "session",
      sessionName: `heishi-smoke-${process.pid}`,
      cwd: process.cwd(),
      title: `Heishi smoke session ${index + 1}`,
      command: ["/bin/sleep", "10"],
      environment: { HEISHI_SMOKE: "1" },
      launcherDirectory,
    })));
    assert.equal(sessionTargets[0]?.workspaceId, sessionTargets[1]?.workspaceId);
    assert.equal(sessionTargets[0]?.paneId, sessionTargets[1]?.paneId);
    assert.notEqual(sessionTargets[0]?.surfaceId, sessionTargets[1]?.surfaceId);
    targets.push(...sessionTargets);
    for (const target of sessionTargets) {
      assert.equal(await cmux.exists(target), true);
      await cmux.focus(target);
    }
  } finally {
    await Promise.all(targets.map((target) => cmux.close(target).catch(() => undefined)));
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
  for (const target of targets) assert.equal(await cmux.exists(target), false);
});

it("runs the real tmux placement, focus, and cleanup smoke matrix", {
  skip: process.env["HEISHI_REAL_TMUX_SMOKE"] !== "1",
}, async () => {
  const tmux = new Tmux();
  const targets: TmuxTarget[] = [];
  let sessionLaunches: Promise<TmuxTarget>[] = [];
  await tmux.validate();
  try {
    for (const placement of ["pane", "window"] as const) {
      const target = await tmux.launch({
        placement,
        cwd: process.cwd(),
        title: `Heishi smoke ${placement}`,
        command: ["/bin/sleep", "10"],
        environment: { HEISHI_SMOKE: "1" },
      });
      targets.push(target);
      assert.equal(await tmux.exists(target.paneId), true);
      await tmux.focus(target.paneId);
    }

    const sessionName = `heishi-smoke-${process.pid}-${Date.now()}`;
    sessionLaunches = [1, 2].map((number) => tmux.launch({
      placement: "session",
      sessionName,
      cwd: process.cwd(),
      title: `Heishi smoke session ${number}`,
      command: ["/bin/sleep", "10"],
      environment: { HEISHI_SMOKE: "1" },
    }).then((target) => {
      targets.push(target);
      return target;
    }));
    const sessionTargets = await Promise.all(sessionLaunches);
    assert.equal(sessionTargets[0]?.sessionId, sessionTargets[1]?.sessionId);
    for (const target of sessionTargets) {
      assert.equal(await tmux.exists(target.paneId), true);
      await tmux.focus(target.paneId);
    }
  } finally {
    await Promise.allSettled(sessionLaunches);
    await Promise.all(targets.map((target) => tmux.close(target.paneId).catch(() => undefined)));
  }
  for (const target of targets) assert.equal(await tmux.exists(target.paneId), false);
});
