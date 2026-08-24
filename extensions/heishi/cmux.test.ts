import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Cmux } from "./cmux.js";
import type { CommandExecutor } from "./command-executor.js";
import type { HostLaunch } from "./terminal-host.js";

const WINDOW = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_WINDOW = "bbbbbbbb-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "cccccccc-2222-4222-8222-222222222222";
const OTHER_PANE = "dddddddd-3333-4333-8333-333333333333";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PANE = "33333333-3333-4333-8333-333333333333";
const SURFACE = "44444444-4444-4444-8444-444444444444";
const CREATED_WORKSPACE = "55555555-5555-4555-8555-55555555555a";
const CREATED_PANE = "66666666-6666-4666-8666-666666666666";
const CREATED_SURFACE = "77777777-7777-4777-8777-77777777777b";
const SECOND_SURFACE = "88888888-8888-4888-8888-888888888888";
const SOCKET = "/tmp/cmux.sock";

class FakeExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  methods = requiredMethods();
  groups: Array<Record<string, unknown>> = [];
  dedicatedExists = false;
  dedicatedSurfaces: Array<Record<string, unknown>> = [];
  callerSurfaces: Array<Record<string, unknown>> = [{ id: SURFACE, pane_id: PANE }];
  malformedMethod?: string;
  invalidField?: { method: string; field: string };
  overriddenField?: { method: string; field: string; value: string };
  failingMethod?: string;
  failingMethodMessage = "not_found: target does not exist";
  missingSurfaces = false;

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args });
    if (args.includes("identify")) return json({
      socket_path: SOCKET,
      caller: {
        window_id: WINDOW,
        workspace_id: WORKSPACE,
        pane_id: PANE,
        surface_id: SURFACE,
      },
    });
    if (args.includes("capabilities")) return json({ methods: this.methods });
    const invocation = parseRpcInvocation(args);
    if (!invocation) throw new Error("missing RPC method");
    const { method, params } = invocation;
    if (this.failingMethod === method) throw new Error(this.failingMethodMessage);
    if (this.malformedMethod === method) return { stdout: "not json", stderr: "" };

    if (method === "surface.split") {
      this.callerSurfaces.push({ id: CREATED_SURFACE, pane_id: CREATED_PANE });
      return this.rpcResult(method, {
        window_id: WINDOW,
        workspace_id: WORKSPACE,
        pane_id: CREATED_PANE,
        surface_id: CREATED_SURFACE,
      });
    }
    if (method === "surface.create") {
      const workspaceId = String(params["workspace_id"]);
      if (sameUuid(workspaceId, CREATED_WORKSPACE) && !this.dedicatedExists) {
        throw new Error("not_found: workspace does not exist");
      }
      const surface = { id: SECOND_SURFACE, pane_id: sameUuid(workspaceId, WORKSPACE) ? PANE : CREATED_PANE };
      if (sameUuid(workspaceId, CREATED_WORKSPACE)) this.dedicatedSurfaces.push(surface);
      else this.callerSurfaces.push(surface);
      return this.rpcResult(method, {
        window_id: WINDOW,
        workspace_id: workspaceId,
        pane_id: surface.pane_id,
        surface_id: surface.id,
      });
    }
    if (method === "workspace.create") {
      this.dedicatedExists = true;
      this.dedicatedSurfaces = [{ id: CREATED_SURFACE, pane_id: CREATED_PANE }];
      return this.rpcResult(method, {
        window_id: WINDOW,
        workspace_id: CREATED_WORKSPACE,
        surface_id: CREATED_SURFACE,
      });
    }
    if (method === "surface.list") {
      const workspaceId = String(params["workspace_id"]);
      if (sameUuid(workspaceId, CREATED_WORKSPACE) && !this.dedicatedExists) {
        throw new Error("not_found: workspace does not exist");
      }
      const surfaces = sameUuid(workspaceId, CREATED_WORKSPACE) ? this.dedicatedSurfaces : this.callerSurfaces;
      return json({ surfaces: this.missingSurfaces ? [] : surfaces });
    }
    if (method === "workspace.list") return json({
      workspaces: this.dedicatedExists
        ? [{ id: CREATED_WORKSPACE, title: "Heishi subagents" }]
        : [],
    });
    if (method === "surface.close") {
      const surfaceId = params["surface_id"];
      this.dedicatedSurfaces = this.dedicatedSurfaces.filter((surface) => surface["id"] !== surfaceId);
      this.callerSurfaces = this.callerSurfaces.filter((surface) => surface["id"] !== surfaceId);
      return json({});
    }
    if (method === "workspace.close") {
      this.dedicatedExists = false;
      this.dedicatedSurfaces = [];
      return json({});
    }
    if (method === "workspace.group.list") return json({ groups: this.groups });
    if (method === "workspace.group.delete") {
      this.groups = [];
      return json({});
    }
    return json({});
  }

  private rpcResult(method: string, result: Record<string, unknown>): { stdout: string; stderr: string } {
    if (this.invalidField?.method === method) {
      return json({ ...result, [this.invalidField.field]: "invalid" });
    }
    if (this.overriddenField?.method === method) {
      return json({ ...result, [this.overriddenField.field]: this.overriddenField.value });
    }
    return json(result);
  }
}

describe("cmux terminal host", () => {
  it("requires caller context and every required RPC method", async () => {
    const executor = new FakeExecutor();
    const cmux = new Cmux(executor, {});
    await assert.rejects(() => cmux.validate(), /cmux caller terminal/u);
    assert.equal(executor.calls.length, 0);

    const mismatched = new Cmux(executor, {
      CMUX_SOCKET_PATH: SOCKET,
      CMUX_WORKSPACE_ID: CREATED_WORKSPACE,
      CMUX_SURFACE_ID: SURFACE,
    });
    await assert.rejects(() => mismatched.validate(), /did not confirm the caller/u);

    const configured = host(executor);
    executor.methods = executor.methods.filter((method) => method !== "surface.create");
    await assert.rejects(() => configured.validate(), /missing required methods: surface.create/u);

    for (const method of ["workspace.group.list", "workspace.group.delete"] as const) {
      executor.methods = requiredMethods().filter((candidate) => candidate !== method);
      await assert.rejects(() => configured.validate(), new RegExp(`missing required methods: ${method}`, "u"));
    }
  });

  it("launches a split without putting secrets in RPC arguments", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const target = await cmux.launch(launch(directory, "pane"));
      assert.deepEqual(target, {
        host: "cmux",
        windowId: WINDOW,
        workspaceId: WORKSPACE,
        paneId: CREATED_PANE,
        surfaceId: CREATED_SURFACE,
        socketPath: SOCKET,
        closeKind: "surface",
      });
      const split = rpcCall(executor, "surface.split");
      assert.deepEqual(split.args.slice(0, split.args.indexOf("rpc")), [
        "--socket", SOCKET, "--id-format", "uuids",
      ]);
      const params = rpcParams(split);
      assert.deepEqual({ ...params, initial_command: "<launcher>" }, {
        workspace_id: WORKSPACE,
        surface_id: SURFACE,
        direction: "right",
        working_directory: "/repo",
        initial_command: "<launcher>",
        focus: false,
      });
      assert.equal(split.args.join(" ").includes("secret-token"), false);
      assert.doesNotMatch(String(params["initial_command"]), /^exec /u);
      const script = await readFile(launcherFrom(String(params["initial_command"])), "utf8");
      assert.match(script, /CMUX_PI_HOOKS_DISABLED='1'/u);
      assert.match(script, /HEISHI_TOKEN='secret-token'/u);
      assert.match(script, /exec 'pi' '--model' 'provider\/model'/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts case-insensitive UUID relationship matches", async () => {
    const executor = new FakeExecutor();
    executor.overriddenField = { method: "surface.split", field: "window_id", value: WINDOW.toUpperCase() };
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const target = await cmux.launch(launch(directory, "pane"));
      assert.equal(target.windowId, WINDOW.toUpperCase());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps window placement to a surface tab in the caller workspace", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const target = await cmux.launch(launch(directory, "window"));
      assert.deepEqual(target, {
        host: "cmux",
        windowId: WINDOW,
        workspaceId: WORKSPACE,
        paneId: PANE,
        surfaceId: SECOND_SURFACE,
        socketPath: SOCKET,
        closeKind: "surface",
      });
      const params = rpcParams(rpcCall(executor, "surface.create"));
      assert.equal(params["workspace_id"], WORKSPACE);
      assert.equal(params["pane_id"], PANE);
      assert.equal(params["working_directory"], "/repo");
      assert.equal(params["focus"], false);
      assert.doesNotMatch(String(params["initial_command"]), /^exec /u);
      assert.equal(rpcCallCount(executor, "workspace.create"), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates one dedicated workspace for session surfaces and closes it after the last worker", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const first = await cmux.launch(launch(directory, "session"));
      const second = await cmux.launch(launch(directory, "session"));
      assert.equal(first.dedicatedWorkspace, true);
      assert.equal(second.dedicatedWorkspace, true);
      assert.equal(first.workspaceId, CREATED_WORKSPACE);
      assert.equal(second.workspaceId, CREATED_WORKSPACE);
      assert.equal(rpcCallCount(executor, "workspace.create"), 1);
      assert.equal(rpcCallCount(executor, "surface.create"), 1);

      await cmux.close(first);
      assert.equal(executor.dedicatedExists, true);
      await cmux.close(second);
      assert.equal(executor.dedicatedExists, false);
      assert.equal(rpcCallCount(executor, "workspace.close"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses managed workspace identity across adapters with the same executor and context", async () => {
    const executor = new FakeExecutor();
    const firstHost = host(executor);
    const secondHost = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await firstHost.validate();
      await secondHost.validate();
      const first = await firstHost.launch(launch(directory, "session"));
      const second = await secondHost.launch(launch(directory, "session"));
      assert.equal(first.workspaceId, second.workspaceId);
      assert.equal(rpcCallCount(executor, "workspace.create"), 1);
      assert.equal(rpcCallCount(executor, "surface.create"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears stale managed workspace identity and recreates it", async () => {
    const executor = new FakeExecutor();
    const firstHost = host(executor);
    const secondHost = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await firstHost.validate();
      await firstHost.launch(launch(directory, "session"));
      executor.dedicatedExists = false;
      executor.dedicatedSurfaces = [];
      await secondHost.validate();
      await secondHost.launch(launch(directory, "session"));
      assert.equal(rpcCallCount(executor, "workspace.create"), 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces a remembered dedicated workspace when it has no surfaces", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await cmux.launch(launch(directory, "session"));
      executor.dedicatedSurfaces = [];

      const replacement = await cmux.launch(launch(directory, "session"));

      assert.equal(replacement.workspaceId, CREATED_WORKSPACE);
      assert.equal(executor.dedicatedExists, true);
      assert.equal(rpcCallCount(executor, "workspace.close"), 1);
      assert.equal(rpcCallCount(executor, "workspace.create"), 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not recreate an empty dedicated workspace when closing it fails", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await cmux.launch(launch(directory, "session"));
      executor.dedicatedSurfaces = [];
      executor.failingMethod = "workspace.close";
      executor.failingMethodMessage = "permission denied";

      await assert.rejects(
        () => cmux.launch(launch(directory, "session")),
        /could not close the empty dedicated workspace before recreation.*permission denied/u,
      );
      assert.equal(rpcCallCount(executor, "workspace.create"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not adopt an unrelated workspace with the same title", async () => {
    const executor = new FakeExecutor();
    executor.dedicatedExists = true;
    executor.dedicatedSurfaces = [{ id: CREATED_SURFACE, pane_id: CREATED_PANE }];
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await cmux.launch(launch(directory, "session"));
      assert.equal(rpcCallCount(executor, "workspace.create"), 1);
      assert.equal(rpcCallCount(executor, "surface.create"), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent first session launches into one dedicated workspace", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const targets = await Promise.all([
        cmux.launch(launch(directory, "session")),
        cmux.launch(launch(directory, "session")),
      ]);
      assert.equal(new Set(targets.map((target) => target.workspaceId)).size, 1);
      assert.equal(rpcCallCount(executor, "workspace.create"), 1);
      assert.equal(rpcCallCount(executor, "surface.create"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("focuses in window, workspace, surface order and checks surface existence", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    await cmux.validate();
    const target = {
      host: "cmux" as const,
      windowId: WINDOW,
      workspaceId: WORKSPACE,
      paneId: PANE,
      surfaceId: SURFACE,
      socketPath: SOCKET,
      closeKind: "surface" as const,
    };

    assert.equal(await cmux.exists(target), true);
    await cmux.focus(target);
    await cmux.close(target);
    const methods = executor.calls.flatMap((call) => {
      const method = parseRpcInvocation(call.args)?.method;
      return method ? [method] : [];
    });
    assert.deepEqual(methods.slice(-4), ["window.focus", "workspace.select", "surface.focus", "surface.close"]);
  });

  it("finds surface and workspace targets when cmux lists their UUIDs with different casing", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    await cmux.validate();
    executor.callerSurfaces = [{ id: CREATED_SURFACE, pane_id: PANE }];
    executor.dedicatedExists = true;

    assert.equal(await cmux.exists({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: WORKSPACE,
      paneId: PANE,
      surfaceId: CREATED_SURFACE.toUpperCase(),
      socketPath: SOCKET,
      closeKind: "surface",
    }), true);
    assert.equal(await cmux.exists({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE.toUpperCase(),
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "workspace",
    }), true);
  });

  it("treats missing targets and not-found closes as already closed", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    await cmux.validate();
    const target = {
      host: "cmux" as const,
      windowId: WINDOW,
      workspaceId: WORKSPACE,
      paneId: PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "surface" as const,
    };
    executor.missingSurfaces = true;
    assert.equal(await cmux.exists(target), false);
    executor.failingMethod = "surface.close";
    await assert.doesNotReject(() => cmux.close(target));
  });

  it("rejects mismatched split relationships and preserves the mismatch after rollback", async () => {
    for (const [field, value] of [
      ["window_id", OTHER_WINDOW],
      ["workspace_id", OTHER_WORKSPACE],
    ] as const) {
      const executor = new FakeExecutor();
      executor.overriddenField = { method: "surface.split", field, value };
      executor.failingMethod = "surface.close";
      const cmux = host(executor);
      const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
      try {
        await cmux.validate();
        await assert.rejects(
          () => cmux.launch(launch(directory, "pane")),
          new RegExp(`cmux split ${field === "window_id" ? "window" : "workspace"} ID does not match`, "u"),
        );
        assert.equal(rpcCallCount(executor, "surface.close"), 1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("preserves surface parsing and rollback failures", async () => {
    const executor = new FakeExecutor();
    executor.invalidField = { method: "surface.split", field: "pane_id" };
    executor.failingMethod = "surface.close";
    executor.failingMethodMessage = "permission denied";
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(
        () => cmux.launch(launch(directory, "pane")),
        /cmux split pane ID is invalid: invalid; cmux rollback via surface\.close also failed:.*permission denied/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects mismatched created-surface relationships and rolls back", async () => {
    for (const [field, value, label] of [
      ["window_id", OTHER_WINDOW, "window"],
      ["workspace_id", OTHER_WORKSPACE, "workspace"],
      ["pane_id", OTHER_PANE, "pane"],
    ] as const) {
      const executor = new FakeExecutor();
      executor.overriddenField = { method: "surface.create", field, value };
      const cmux = host(executor);
      const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
      try {
        await cmux.validate();
        await assert.rejects(
          () => cmux.launch(launch(directory, "window")),
          new RegExp(`cmux surface ${label} ID does not match`, "u"),
        );
        assert.deepEqual(rpcParams(rpcCall(executor, "surface.close")), { surface_id: SECOND_SURFACE });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects a mismatched workspace window and preserves the mismatch after rollback", async () => {
    const executor = new FakeExecutor();
    executor.overriddenField = { method: "workspace.create", field: "window_id", value: OTHER_WINDOW };
    executor.failingMethod = "workspace.close";
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(
        () => cmux.launch(launch(directory, "session")),
        /cmux workspace window ID does not match/u,
      );
      assert.equal(rpcCallCount(executor, "workspace.close"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves workspace parsing and rollback failures", async () => {
    const executor = new FakeExecutor();
    executor.invalidField = { method: "workspace.create", field: "surface_id" };
    executor.failingMethod = "workspace.close";
    executor.failingMethodMessage = "permission denied";
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(
        () => cmux.launch(launch(directory, "session")),
        /cmux workspace surface ID is invalid: invalid; cmux rollback via workspace\.close also failed:.*permission denied/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back created surfaces when another returned identifier is invalid", async () => {
    for (const placement of ["pane", "window"] as const) {
      const executor = new FakeExecutor();
      executor.invalidField = {
        method: placement === "pane" ? "surface.split" : "surface.create",
        field: "pane_id",
      };
      if (placement === "pane") executor.failingMethod = "surface.close";
      const cmux = host(executor);
      const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
      try {
        await cmux.validate();
        await assert.rejects(() => cmux.launch(launch(directory, placement)), /pane ID is invalid: invalid/u);
        assert.deepEqual(rpcParams(rpcCall(executor, "surface.close")), {
          surface_id: placement === "pane" ? CREATED_SURFACE : SECOND_SURFACE,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("does not fabricate surface rollback when the returned surface ID is invalid", async () => {
    const executor = new FakeExecutor();
    executor.invalidField = { method: "surface.split", field: "surface_id" };
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(() => cmux.launch(launch(directory, "pane")), /surface ID is invalid: invalid/u);
      assert.equal(rpcCallCount(executor, "surface.close"), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes a restored dedicated surface without validation", async () => {
    const executor = new FakeExecutor();
    executor.dedicatedExists = true;
    executor.dedicatedSurfaces = [{ id: CREATED_SURFACE, pane_id: CREATED_PANE }];
    const cmux = new Cmux(executor, {});

    await cmux.close({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE,
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "surface",
      dedicatedWorkspace: true,
    });

    assert.equal(executor.dedicatedExists, false);
    assert.deepEqual(rpcParams(rpcCall(executor, "workspace.close")), {
      workspace_id: CREATED_WORKSPACE,
    });
  });

  it("cleans up a dedicated target with mixed-case UUIDs and clears its managed identity", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const target = await cmux.launch(launch(directory, "session"));

      await cmux.close({
        ...target,
        workspaceId: target.workspaceId.toUpperCase(),
        surfaceId: target.surfaceId.toUpperCase(),
      });
      await cmux.launch(launch(directory, "session"));

      assert.equal(rpcCallCount(executor, "workspace.close"), 1);
      assert.equal(rpcCallCount(executor, "workspace.create"), 2);
      assert.equal(rpcCallCount(executor, "surface.list"), 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes an empty restored dedicated workspace idempotently", async () => {
    const executor = new FakeExecutor();
    executor.dedicatedExists = true;
    const cmux = new Cmux(executor, {});

    await cmux.close({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE,
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "surface",
      dedicatedWorkspace: true,
    });

    assert.equal(executor.dedicatedExists, false);
    assert.equal(rpcCallCount(executor, "workspace.close"), 1);
  });

  it("serializes restored dedicated closes across unvalidated adapters", async () => {
    const executor = new FakeExecutor();
    executor.dedicatedExists = true;
    executor.dedicatedSurfaces = [
      { id: CREATED_SURFACE, pane_id: CREATED_PANE },
      { id: SECOND_SURFACE, pane_id: CREATED_PANE },
    ];
    const first = new Cmux(executor, {});
    const second = new Cmux(executor, {});

    await Promise.all([
      first.close({
        host: "cmux",
        windowId: WINDOW,
        workspaceId: CREATED_WORKSPACE,
        paneId: CREATED_PANE,
        surfaceId: CREATED_SURFACE,
        socketPath: SOCKET,
        closeKind: "surface",
        dedicatedWorkspace: true,
      }),
      second.close({
        host: "cmux",
        windowId: WINDOW,
        workspaceId: CREATED_WORKSPACE,
        paneId: CREATED_PANE,
        surfaceId: SECOND_SURFACE,
        socketPath: SOCKET,
        closeKind: "surface",
        dedicatedWorkspace: true,
      }),
    ]);

    assert.equal(executor.dedicatedExists, false);
    assert.equal(rpcCallCount(executor, "workspace.close"), 1);
  });

  it("cleans up a restored legacy session group without validation", async () => {
    const groupId = "99999999-9999-4999-8999-999999999999";
    const executor = new FakeExecutor();
    executor.groups = [{ id: groupId, member_workspace_ids: [WORKSPACE] }];
    const cmux = new Cmux(executor, {});

    await cmux.close({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE,
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "workspace",
      groupId,
      groupAnchorWorkspaceId: WORKSPACE,
    });

    assert.deepEqual(rpcParams(rpcCall(executor, "workspace.group.delete")), {
      window_id: WINDOW,
      group_id: groupId,
      close_workspaces: true,
    });
  });

  it("treats a not-found final workspace close as success and forgets managed identity", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      const target = await cmux.launch(launch(directory, "session"));
      executor.failingMethod = "workspace.close";
      await assert.doesNotReject(() => cmux.close(target));
      delete executor.failingMethod;
      await cmux.launch(launch(directory, "session"));
      assert.equal(rpcCallCount(executor, "workspace.create"), 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats a not-found legacy group list as already cleaned up", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    await cmux.validate();
    executor.failingMethod = "workspace.group.list";
    await assert.doesNotReject(() => cmux.close({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE,
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "workspace",
      groupId: "99999999-9999-4999-8999-999999999999",
      groupAnchorWorkspaceId: WORKSPACE,
    }));
  });

  it("treats not-found workspace targets as already closed", async () => {
    const executor = new FakeExecutor();
    const cmux = host(executor);
    await cmux.validate();
    executor.failingMethod = "workspace.list";
    assert.equal(await cmux.exists({
      host: "cmux",
      windowId: WINDOW,
      workspaceId: CREATED_WORKSPACE,
      paneId: CREATED_PANE,
      surfaceId: CREATED_SURFACE,
      socketPath: SOCKET,
      closeKind: "workspace",
    }), false);
  });

  it("rolls back a workspace when its returned surface ID is malformed", async () => {
    const executor = new FakeExecutor();
    executor.invalidField = { method: "workspace.create", field: "surface_id" };
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(() => cmux.launch(launch(directory, "session")), /surface ID is invalid: invalid/u);
      assert.deepEqual(rpcParams(rpcCall(executor, "workspace.close")), { workspace_id: CREATED_WORKSPACE });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON and rolls back a failed dedicated workspace", async () => {
    const executor = new FakeExecutor();
    executor.missingSurfaces = true;
    const cmux = host(executor);
    const directory = await mkdtemp(join(tmpdir(), "heishi-cmux-test-"));
    try {
      await cmux.validate();
      await assert.rejects(() => cmux.launch(launch(directory, "session")), /did not list the created surface/u);
      assert.equal(rpcCallCount(executor, "workspace.close"), 1);
      executor.missingSurfaces = false;
      executor.malformedMethod = "workspace.create";
      await assert.rejects(() => cmux.launch(launch(directory, "session")), /malformed JSON/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function host(executor: FakeExecutor): Cmux {
  return new Cmux(executor, {
    CMUX_SOCKET_PATH: SOCKET,
    CMUX_WORKSPACE_ID: WORKSPACE,
    CMUX_SURFACE_ID: SURFACE,
  });
}

function launch(launcherDirectory: string, placement: "pane" | "window" | "session"): HostLaunch {
  return {
    placement,
    ...(placement === "session" ? { sessionName: "heishi-subagents" } : {}),
    cwd: "/repo",
    title: "Circe",
    command: ["pi", "--model", "provider/model"],
    environment: { HEISHI_TOKEN: "secret-token" },
    launcherDirectory,
  };
}

function rpcCall(executor: FakeExecutor, method: string): { command: string; args: string[] } {
  const call = executor.calls.find((candidate) => parseRpcInvocation(candidate.args)?.method === method);
  assert.ok(call, `missing ${method} call`);
  return call;
}

function rpcCallCount(executor: FakeExecutor, method: string): number {
  return executor.calls.filter((call) => parseRpcInvocation(call.args)?.method === method).length;
}

function rpcParams(call: { args: string[] }): Record<string, unknown> {
  const invocation = parseRpcInvocation(call.args);
  assert.ok(invocation);
  return invocation.params;
}

function parseRpcInvocation(
  args: string[],
): { method: string; params: Record<string, unknown> } | undefined {
  const rpcIndex = args.indexOf("rpc");
  const method = args[rpcIndex + 1];
  const rawParams = args[rpcIndex + 2];
  if (rpcIndex < 0 || !method || !rawParams) return undefined;
  return { method, params: JSON.parse(rawParams) as Record<string, unknown> };
}

function launcherFrom(command: string): string {
  const match = /^(?:exec )?'(.+)'$/u.exec(command);
  assert.ok(match?.[1]);
  return match[1];
}

function json(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: "" };
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requiredMethods(): string[] {
  return [
    "surface.split",
    "surface.create",
    "surface.list",
    "surface.focus",
    "surface.close",
    "window.focus",
    "workspace.create",
    "workspace.list",
    "workspace.select",
    "workspace.close",
    "workspace.group.list",
    "workspace.group.delete",
  ];
}
