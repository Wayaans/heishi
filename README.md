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

- `subagent_start` with an explicit task, model, and thinking level
- `subagent_control` to prompt, steer, follow up, abort, focus, or resume a run
- `subagent_wait` to wait for the current work to settle
- `/subagent` to open the keyboard-driven management overlay

Each subagent keeps its own Pi session and loads project context files such as `AGENTS.md`. Automatically delegated panes close after work settles; completed sessions remain resumable.

Runtime third-party packages belong in `dependencies`. Keep pi-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox`) as `peerDependencies` with a `"*"` range.
