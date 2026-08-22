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
- `subagent_control` — prompt, steer, follow up, abort, resume, or clean up a worker workspace
- `subagent_wait` — wait for a worker to finish and return its report

Workers have two modes:

- `sub` (default) uses Heishi's fast, constrained resource profile and requires a model/thinking pair configured through `/heishi model`.
- `main` loads normal Pi resources, including extensions, skills, prompt templates, themes, context files, settings, and packages. Model selection follows this priority: values explicitly requested by the user, the parent session's exact active model and thinking level, then a deliberately selected pair from the configured delegation pool as the final fallback. It can delegate recursively.

Choose a mode by the task's intended repository side effects, not by keywords:

| Task | Mode |
| --- | --- |
| Read-only exploration, research, analysis, audit, review, or a report returned to the parent | `sub` |
| Implementation, fixes, refactoring, or creating, editing, deleting, formatting, or generating repository files | `main` |

Tell read-only workers not to modify files and to return findings in their final report. For mixed investigation and write work, prefer a sub-mode investigation followed by a main-mode implementation; if the work cannot be split, use `main`. Returning a report through `subagent_wait` is read-only, while saving that report in the repository is write work.

The main agent passes `mode` explicitly after classifying a task. Set the fallback for direct starts with `/heishi mode`, `/heishi mode sub`, or `/heishi mode main`. An explicit `subagent_start.mode` overrides that fallback for one run. New and forked sessions default to `sub`; existing runs retain their original mode.

Main workers mirror the parent session's project trust. They load trusted extensions with normal process permissions and model credentials; they are not sandboxes.

Use `/subagent` to manage workers in the interactive overlay. Both modes prefer structured reports and fall back to the worker's final assistant response.

### Worktree workspaces

Workers use the shared checkout by default. Main-mode workers can instead use an isolated Git worktree by passing `workspace: "worktree"`. Set the main-mode session fallback with `/heishi workspace shared` or `/heishi workspace worktree`; bare `/heishi workspace` reports it. New and forked sessions default to `shared`, and an explicit `subagent_start.workspace` overrides the fallback in main mode. Sub mode always uses the shared checkout and rejects an explicit worktree.

Heishi requires the source checkout to be clean, including untracked files. It creates branch `heishi/<run-id>` from the source checkout's exact HEAD and places the worktree at `<agent-dir>/heishi/worktrees/<repo-name>-<repo-id>/<run-id>`. Ignored files are not copied. The worktree and branch remain after the worker settles, waits, shuts down, or fails after launch. If startup fails before launch, Heishi removes a safely identified worktree registration and path when possible, but retains the generated branch and internal lease for manual recovery. Persisted worktree metadata records whether the worktree is present or removed, and the startup error warns that both refs were retained. Heishi never merges branches or deletes refs.

After reviewing or integrating the work yourself, use `subagent_control` action `cleanup` from the interactive TUI. Heishi displays a confirmation naming the run and exact worktree path, and does not call cleanup unless you accept it. Non-interactive cleanup is rejected. Cleanup uses ordinary `git worktree remove` only when a settled worktree contains no modified, untracked, or ignored files. It also requires a verified closed pane and retains the branch and internal lease. Resume recreates an explicitly removed worktree from that retained branch at the same path. Heishi refuses missing or inconsistent workspace state instead of pruning or overwriting it. No Heishi tool deletes refs.

By default, sub workers open in a detached window in the `heishi-subagents` tmux session, while main workers open in a detached window in the current tmux session. An explicit placement can open either mode in the background session or in the current tmux session as a pane or detached window.

Shared-workspace subagents use the current checkout. Run concurrent shared writers only on separate files; use main-mode worktree workspaces for isolated checkouts.

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
