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

Runtime third-party packages belong in `dependencies`. Keep pi-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox`) as `peerDependencies` with a `"*"` range.
