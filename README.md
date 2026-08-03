# heishi

A Bun-managed, strict TypeScript package for project-local pi extensions.

## Create an extension

Create each extension at:

```text
extensions/<extension-name>/index.ts
```

An extension must default-export a factory receiving `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI): void {
  // Register tools, commands, or event handlers here.
}
```

Then run:

```sh
bun run check
```

The project-local `.pi/settings.json` loads this repository as a pi package. After trusting the project, restart pi or use `/reload` to load new extensions.

## Heishi subagents

The `heishi` extension runs delegated subagents as normal interactive Pi sessions in tmux. Start Pi inside tmux, then use:

- `subagent_start` with an explicit task, model, and thinking level; by default, it opens a detached window in the dedicated `heishi-subagents` tmux session, while `placement: "pane"` splits the current window and `placement: "window"` opens a detached window in the current session
- `subagent_control` to prompt, steer, follow up, abort, or resume a run
- `subagent_wait` to wait for the current work to settle
- `/subagent` to open the keyboard-driven management overlay
- `/heishi model` to choose the model/thinking pairs the main agent may use for delegation and save them globally or for the current trusted project

Project configuration in `.pi/heishi.json` overrides global configuration in `~/.pi/agent/heishi.json`; when no project file exists, Heishi falls back to the global pool. Delegation remains disabled until at least one currently authenticated pair is configured. Pi-scoped models constrain the picker when present; otherwise it lists all authenticated models.

Each subagent keeps its own Pi session and loads project context files such as `AGENTS.md`. Multiple subagents may run concurrently in the same checkout, including concurrent writers, so callers are responsible for avoiding conflicting edits. Session-placed workers reuse `heishi-subagents` without changing the current tmux client focus; the tmux session disappears naturally after its final worker closes and is recreated on demand. Automatically delegated panes close after work settles; completed Pi sessions remain resumable. Startup failures are recorded and returned with `status: "failed"` instead of failing the `subagent_start` tool call.

Runtime third-party packages belong in `dependencies`. Keep pi-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox`) as `peerDependencies` with a `"*"` range.
