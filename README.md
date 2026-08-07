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

Restart Pi, then configure the model and thinking-level pairs available to subagents:

```text
/heishi model
```

## Usage

Heishi gives Pi three tools:

- `subagent_start` — start a subagent in tmux
- `subagent_control` — prompt, steer, follow up, abort, or resume a subagent
- `subagent_wait` — wait for a subagent to finish and return its report

Use `/subagent` to manage subagents in the interactive overlay.

By default, workers open in a detached window in the `heishi-subagents` tmux session. They can also open in the current tmux session as a pane or detached window.

Subagents share the current checkout. Run concurrent writers only on separate files or worktrees.

## Development

```sh
git clone https://github.com/Wayaans/heishi.git
cd heishi
bun install
bun run check
bun test
```
