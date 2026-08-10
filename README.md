# Heishi

Persistent, interactive subagents for [Pi](https://github.com/earendil-works/pi-mono), powered by tmux.

Heishi lets Pi delegate work to concurrent agent sessions, steer them while they run, and resume completed sessions without losing context.

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono)
- [tmux](https://github.com/tmux/tmux)
- At least one authenticated Pi model

## Install

```sh
pi install git:github.com/Wayaans/heishi
```

Restart Pi, then configure the model and thinking-level pairs available to constrained workers:

```text
/heishi model
```

## Usage

Heishi gives Pi three tools:

- `subagent_start` — start a managed worker in tmux
- `subagent_control` — prompt, steer, follow up, abort, or resume a worker
- `subagent_wait` — wait for a worker to finish and return its report

Workers have two modes:

- `sub` (default) uses Heishi's fast, constrained resource profile and requires a model/thinking pair configured through `/heishi model`.
- `main` loads normal Pi resources, including extensions, skills, prompt templates, themes, context files, settings, and packages. It can use Pi's default authenticated model or optional authenticated model/thinking overrides, and it can delegate recursively.

Set the current session's default for future runs with `/heishi mode`, `/heishi mode sub`, or `/heishi mode main`. An explicit `subagent_start.mode` overrides that default for one run. New and forked sessions default to `sub`; existing runs retain their original mode.

Main workers mirror the parent session's project trust. They load trusted extensions with normal process permissions and model credentials; they are not sandboxes.

Use `/subagent` to manage workers in the interactive overlay. Both modes prefer structured reports and fall back to the worker's final assistant response.

By default, sub workers open in a detached window in the `heishi-subagents` tmux session, while main workers open in a detached window in the current tmux session. An explicit placement can open either mode in the background session or in the current tmux session as a pane or detached window.

Subagents share the current checkout. Run concurrent writers only on separate files or worktrees.

## Development

```sh
git clone https://github.com/Wayaans/heishi.git
cd heishi
bun install
bun run check
bun test
```
