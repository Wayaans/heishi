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

Restart Pi, then configure the delegation pool of model and thinking-level pairs:

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
- `main` loads normal Pi resources, including extensions, skills, prompt templates, themes, context files, settings, and packages. It can use any authenticated model explicitly requested by the user. Otherwise, the agent deliberately chooses the best-fitting model/thinking pair from the configured delegation pool instead of selecting randomly or using Pi's default model. It can delegate recursively.

Choose a mode by the task's intended repository side effects, not by keywords:

| Task | Mode |
| --- | --- |
| Read-only exploration, research, analysis, audit, review, or a report returned to the parent | `sub` |
| Implementation, fixes, refactoring, or creating, editing, deleting, formatting, or generating repository files | `main` |

Tell read-only workers not to modify files and to return findings in their final report. For mixed investigation and write work, prefer a sub-mode investigation followed by a main-mode implementation; if the work cannot be split, use `main`. Returning a report through `subagent_wait` is read-only, while saving that report in the repository is write work.

The main agent passes `mode` explicitly after classifying a task. Set the fallback for direct starts with `/heishi mode`, `/heishi mode sub`, or `/heishi mode main`. An explicit `subagent_start.mode` overrides that fallback for one run. New and forked sessions default to `sub`; existing runs retain their original mode.

Main workers mirror the parent session's project trust. They load trusted extensions with normal process permissions and model credentials; they are not sandboxes.

Use `/subagent` to manage workers in the interactive overlay. Both modes prefer structured reports and fall back to the worker's final assistant response.

By default, sub workers open in a detached window in the `heishi-subagents` tmux session, while main workers open in a detached window in the current tmux session. An explicit placement can open either mode in the background session or in the current tmux session as a pane or detached window.

Subagents share the current checkout. Run concurrent writers only on separate files or worktrees.

### Delegation contract

Every worker runs in a fresh session without the parent conversation, prior tool results, assumptions, or decisions. A `subagent_start.task` must therefore be a self-contained brief with the objective, relevant background, scope, constraints, expected deliverable, and verification. Heishi marks messages as delegations from the parent and instructs workers to return all communication to that parent rather than addressing the user.

When a worker needs human or other external input, it reports `status: "blocked"` with a structured `request` containing the request kind, exact prompt, and optional detail, choices, and recommendation. `subagent_wait` returns that request to the parent. The parent can obtain the answer, resume the worker, send the answer with `subagent_control`, and wait again.

## Development

```sh
git clone https://github.com/Wayaans/heishi.git
cd heishi
bun install
bun run check
bun test
```
