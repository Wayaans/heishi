import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TerminalHostResolver } from "./terminal-host-resolver.js";
import type { HostLaunch, HostTarget, TerminalHost, TerminalHostKind } from "./terminal-host.js";

class FakeHost implements TerminalHost {
  validationError?: Error;
  validations = 0;

  constructor(readonly kind: TerminalHostKind) {}

  async validate(): Promise<void> {
    this.validations += 1;
    if (this.validationError) throw this.validationError;
  }

  async launch(_spec: HostLaunch): Promise<HostTarget> {
    throw new Error("not used");
  }
  async exists(_target: HostTarget): Promise<boolean> { return false; }
  async focus(_target: HostTarget): Promise<void> {}
  async close(_target: HostTarget): Promise<void> {}
}

describe("terminal host resolver", () => {
  it("selects the only host that validates in auto mode", async () => {
    const tmux = new FakeHost("tmux");
    const cmux = new FakeHost("cmux");
    tmux.validationError = new Error("TMUX is unset");

    const resolver = new TerminalHostResolver([tmux, cmux]);
    assert.equal((await resolver.resolve("auto")).kind, "cmux");
  });

  it("validates only an explicit override", async () => {
    const tmux = new FakeHost("tmux");
    const cmux = new FakeHost("cmux");
    cmux.validationError = new Error("socket unavailable");
    const resolver = new TerminalHostResolver([tmux, cmux]);

    await assert.rejects(() => resolver.resolve("cmux"), /cmux terminal host is unavailable.*socket unavailable/u);
    assert.equal(tmux.validations, 0);
    assert.equal(cmux.validations, 1);
  });

  it("uses the controlling terminal when tmux and cmux both validate", async () => {
    const tmux = new FakeHost("tmux");
    const cmux = new FakeHost("cmux");
    const nestedTmux = new TerminalHostResolver([tmux, cmux], async () => "tmux");
    assert.equal((await nestedTmux.resolve("auto")).kind, "tmux");

    const nestedCmux = new TerminalHostResolver([tmux, cmux], async () => "cmux");
    assert.equal((await nestedCmux.resolve("auto")).kind, "cmux");
  });

  it("fails safely when dual-valid context is ambiguous", async () => {
    const resolver = new TerminalHostResolver(
      [new FakeHost("tmux"), new FakeHost("cmux")],
      async () => undefined,
    );
    await assert.rejects(() => resolver.resolve("auto"), /Both tmux and cmux.*\/heishi settings/u);
  });

  it("reports both auto-detection failures", async () => {
    const tmux = new FakeHost("tmux");
    const cmux = new FakeHost("cmux");
    tmux.validationError = new Error("tmux missing");
    cmux.validationError = new Error("cmux missing");
    const resolver = new TerminalHostResolver([tmux, cmux]);

    await assert.rejects(() => resolver.resolve("auto"), /tmux: tmux missing; cmux: cmux missing/u);
  });

  it("dispatches persisted targets to their concrete host", () => {
    const tmux = new FakeHost("tmux");
    const cmux = new FakeHost("cmux");
    const resolver = new TerminalHostResolver([tmux, cmux]);
    assert.equal(resolver.forTarget({
      host: "cmux",
      windowId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      socketPath: "/tmp/cmux.sock",
      closeKind: "surface",
    }), cmux);
  });
});
